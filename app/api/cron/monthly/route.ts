import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { isCronAuthorized } from '@/lib/api'
import { buildMonthlySnapshot, previousPeriod, periodToDate } from '@/lib/snapshots'
import { runAuditPipeline } from '@/lib/audit-pipeline'
import { runLeakAnalysis, trackTopLeaks } from '@/lib/leak-store'
import { monthRange } from '@/lib/ga4-audit'
import { raiseAlert } from '@/lib/alerts'
import { shiftPeriod } from '@/lib/snapshots'

export const maxDuration = 300

const REAUDIT_DAYS = Number(process.env.FISCHER_REAUDIT_DAYS || 30)

/**
 * Runs hourly (vercel.json). Each run does a bounded amount of work so it
 * always finishes inside the function time limit:
 *
 * 1. Monthly snapshots — for each client with GA4/Clarity: the previous
 *    calendar month (built on the 1st, refreshed daily until the 4th while GA4
 *    finalises late data) and the current month-to-date (refreshed daily).
 * 2. Scheduled re-audits — at most ONE tracked page per run whose last audit
 *    is older than FISCHER_REAUDIT_DAYS (default 30). Hourly runs give
 *    capacity for ~24 page audits a day.
 */
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  const started = Date.now()
  const supabase = createSupabaseServiceClient()
  const today = new Date().toISOString().slice(0, 10)
  const log: unknown[] = []

  // ---- 1. Snapshots ----
  const { data: clients } = await supabase.from('clients').select('*')
  const prev = previousPeriod()
  const current = today.slice(0, 7)
  const dayOfMonth = new Date().getUTCDate()

  for (const c of (clients ?? []).filter(c => c.ga4_property_id || c.clarity_api_token)) {
    if (Date.now() - started > 150_000) { log.push('Snapshot time budget used — continuing next run.'); break }
    const { data: existing } = await supabase.from('monthly_snapshots').select('period, updated_at')
      .eq('client_id', c.id).in('period', [periodToDate(prev), periodToDate(current)])
    const updatedToday = (p: string) => existing?.some(e => String(e.period).slice(0, 7) === p && String(e.updated_at).slice(0, 10) === today)
    const has = (p: string) => existing?.some(e => String(e.period).slice(0, 7) === p)

    for (const p of [prev, current]) {
      const due = p === prev ? (!has(p) || (dayOfMonth <= 4 && !updatedToday(p))) : !updatedToday(p)
      if (!due) continue
      try {
        const s = await buildMonthlySnapshot(supabase, c, p)
        log.push({ client: c.name, period: p, snapshot: 'ok', errors: s.errors })
        // First build of last month's snapshot → compare with the month before
        if (p === prev && !has(p) && s.ga4?.success && s.ga4.totals) {
          const { data: before } = await supabase.from('monthly_snapshots').select('ga4')
            .eq('client_id', c.id).eq('period', periodToDate(shiftPeriod(prev, -1))).maybeSingle()
          const b = before?.ga4?.totals, t = s.ga4.totals
          if (b && b.sessions >= 1000 && t.sessions >= 1000 && b.conversionRate > 0) {
            const change = ((t.conversionRate - b.conversionRate) / b.conversionRate) * 100
            if (change <= -20) await raiseAlert(supabase, {
              clientId: c.id, clientName: c.name, type: 'conversion_drop', dedupeKey: `cvr_drop:${c.id}:${prev}`,
              title: `Conversion rate fell ${Math.abs(change).toFixed(0)}% in ${prev}`,
              message: `${b.conversionRate}% → ${t.conversionRate}% (sessions ${b.sessions.toLocaleString()} → ${t.sessions.toLocaleString()}). Check tracking, recent site changes and campaigns.`,
              link: `/clients/${c.id}`
            })
          }
        }
        // First build of last month's snapshot → also build last month's leak map
        if (p === prev && !has(p) && c.ga4_property_id) {
          const leaks = await runLeakAnalysis(supabase, c, monthRange(prev))
          const tracked = c.auto_track_leaks ? await trackTopLeaks(supabase, c.id, leaks.data, 3) : []
          log.push({ client: c.name, leaks: leaks.data.totals.recoverableMonthly, autoTracked: tracked })
        }
      } catch (err) {
        log.push({ client: c.name, period: p, snapshot: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  // ---- 2. One scheduled re-audit ----
  if (Date.now() - started < 60_000) {
    const cutoff = new Date(Date.now() - REAUDIT_DAYS * 86400000).toISOString()
    const { data: due } = await supabase.from('tracked_pages').select('*')
      .eq('active', true)
      .or(`last_audit_at.is.null,last_audit_at.lt.${cutoff}`)
      .order('last_audit_at', { ascending: true, nullsFirst: true })
      .limit(1)
    const page = due?.[0]
    if (page) {
      // Claim it (so an overlapping run doesn't pick the same page)
      let claim = supabase.from('tracked_pages').update({ last_audit_at: new Date().toISOString() }).eq('id', page.id)
      claim = page.last_audit_at ? claim.eq('last_audit_at', page.last_audit_at) : claim.is('last_audit_at', null)
      const { data: claimed } = await claim.select('id')
      const client = (clients ?? []).find(c => c.id === page.client_id)
      if (claimed?.length && client) {
        const input = {
          clientId: client.id, clientName: client.name, pageUrl: page.page_url,
          pageType: page.page_type, businessGoal: page.business_goal
        }
        const { data: row } = await supabase.from('audits').insert({
          client_id: client.id, client_name: client.name, page_url: page.page_url,
          page_type: page.page_type, business_goal: page.business_goal,
          input_data: input, status: 'running', trigger: 'scheduled', tracked_page_id: page.id
        }).select('id').single()
        if (row) {
          try {
            const outcome = await runAuditPipeline({ supabase, auditId: row.id, input, client, trackedPageId: page.id })
            log.push({ audit: row.id, page: page.page_url, status: outcome.status })
            if (outcome.status === 'needs_manual_input') await raiseAlert(supabase, {
              clientId: client.id, clientName: client.name, type: 'audit_needs_input', dedupeKey: `audit_input:${page.id}`, severity: 'medium',
              title: 'Scheduled audit needs manual input', message: `${page.page_url}: ${Object.values(outcome.confidence.reasons).join(' · ')}`,
              link: `/clients/${client.id}`
            })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            await supabase.from('audits').update({ status: 'failed', error_message: msg }).eq('id', row.id)
            log.push({ audit: row.id, page: page.page_url, status: 'failed', error: msg })
            await raiseAlert(supabase, {
              clientId: client.id, clientName: client.name, type: 'audit_failed', dedupeKey: `audit_failed:${page.id}`, severity: 'medium',
              title: 'Scheduled audit failed', message: `${page.page_url}: ${msg}`, link: `/clients/${client.id}`
            })
          }
        }
      }
    }
  }

  return NextResponse.json({ ms: Date.now() - started, log })
}
