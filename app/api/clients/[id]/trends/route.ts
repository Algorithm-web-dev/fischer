import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'

/**
 * Everything needed to chart a client over time:
 * - monthly GA4/Clarity snapshots
 * - Fischer Score history per page (every audit)
 * - change log (with measured before/after impact where available)
 * - A/B tests and their results
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const { supabase } = auth
  const months = Math.min(Number(req.nextUrl.searchParams.get('months') || 12), 36)
  const since = new Date()
  since.setUTCMonth(since.getUTCMonth() - months)
  const sinceIso = since.toISOString().slice(0, 10)

  const [client, snapshots, audits, changes, tests] = await Promise.all([
    supabase.from('clients').select('id, name, ga4_property_id, clarity_project_id, currency').eq('id', params.id).single(),
    supabase.from('monthly_snapshots').select('period, ga4, clarity, clarity_days, pages, errors').eq('client_id', params.id).gte('period', sinceIso).order('period'),
    supabase.from('audits').select('id, page_url, fischer_score, completed_at, output->scoreBreakdown, page_diff, trigger')
      .eq('client_id', params.id).eq('status', 'complete').gte('completed_at', sinceIso).order('completed_at'),
    supabase.from('change_log').select('*').eq('client_id', params.id).gte('change_date', sinceIso).order('change_date'),
    supabase.from('test_briefs').select('id, hypothesis_name, status, page_url, test_start_date, test_end_date, stats, winner, result_summary').eq('client_id', params.id).order('created_at')
  ])
  if (!client.data) return bad('Client not found.', 404)

  const months_ = (snapshots.data ?? []).map(s => ({
    period: String(s.period).slice(0, 7),
    sessions: s.ga4?.totals?.sessions ?? null,
    conversions: s.ga4?.totals?.conversions ?? null,
    conversionRate: s.ga4?.totals?.conversionRate ?? null,
    revenue: s.ga4?.totals?.revenue ?? null,
    engagementRate: s.ga4?.totals?.engagementRate ?? null,
    rageClickRate: s.clarity?.rageClickRate ?? null,
    deadClickRate: s.clarity?.deadClickRate ?? null,
    scrollDepth: s.clarity?.avgScrollDepth ?? null,
    clarityDays: s.clarity_days,
    errors: s.errors
  }))

  const scoreHistory: Record<string, { auditId: string; date: string; score: number; breakdown: unknown; changed: boolean }[]> = {}
  for (const a of audits.data ?? []) {
    ;(scoreHistory[a.page_url] ??= []).push({
      auditId: a.id, date: a.completed_at, score: a.fischer_score, breakdown: (a as any).scoreBreakdown ?? null,
      changed: !!(a.page_diff as any)?.changed
    })
  }

  return NextResponse.json({
    client: client.data,
    months: months_,
    scoreHistory,
    changes: changes.data ?? [],
    tests: tests.data ?? []
  })
}
