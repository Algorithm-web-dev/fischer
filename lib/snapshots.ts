import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchGA4AuditData, fetchPageMetrics, monthRange, iso, type DateRange, type GA4PageMetrics, type GA4Totals } from './ga4-audit'
import { aggregateStoredDays, fetchClarityExport, parseClarityExport, type ClarityDaily, type ClarityPageData } from './clarity'
import type { ClientRow } from './audit-pipeline'
import { pctChange } from './stats'

/** "2026-10" → "2026-10-01" */
export function periodToDate(period: string): string {
  return `${period.slice(0, 7)}-01`
}

/** The calendar month before the given date, as "YYYY-MM". */
export function previousPeriod(from: Date = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1))
  return iso(d).slice(0, 7)
}

export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number)
  return iso(new Date(Date.UTC(y, m - 1 + months, 1))).slice(0, 7)
}

export interface MonthlySnapshot {
  client_id: string
  period: string
  ga4: Awaited<ReturnType<typeof fetchGA4AuditData>> | null
  pages: { pageUrl: string; ga4: GA4PageMetrics | null; clarity: ClarityPageData | null }[]
  clarity: ClarityPageData | null
  clarity_days: number
  errors: string[]
}

/**
 * Builds (or rebuilds) one client's snapshot for a calendar month: GA4 site
 * totals, GA4 + Clarity metrics for every tracked page, and the Clarity month
 * aggregate from the stored daily exports. Idempotent — safe to re-run.
 */
export async function buildMonthlySnapshot(
  supabase: SupabaseClient,
  client: ClientRow,
  period: string
): Promise<MonthlySnapshot> {
  const range = monthRange(period)
  const errors: string[] = []

  const { data: tracked } = await supabase.from('tracked_pages')
    .select('page_url').eq('client_id', client.id).eq('active', true)
  const pageUrls = (tracked ?? []).map(t => t.page_url)

  let ga4: MonthlySnapshot['ga4'] = null
  const pageGa4 = new Map<string, GA4PageMetrics | null>()
  if (client.ga4_property_id) {
    ga4 = await fetchGA4AuditData(client.ga4_property_id, { range, conversionEvent: client.ga4_conversion_event })
    if (!ga4.success) errors.push(`GA4: ${ga4.error}`)
    else {
      for (const url of pageUrls) {
        try {
          pageGa4.set(url, await fetchPageMetrics(client.ga4_property_id, url, range, client.ga4_conversion_event))
        } catch (err) {
          errors.push(`GA4 page ${url}: ${err instanceof Error ? err.message : String(err)}`)
          pageGa4.set(url, null)
        }
      }
    }
  }

  const { data: days } = await supabase.from('clarity_daily')
    .select('data').eq('client_id', client.id).gte('day', range.startDate).lte('day', range.endDate)
  const clarityDays = (days ?? []).map(d => d.data as ClarityDaily)
  const siteClarity = clarityDays.length ? aggregateStoredDays(clarityDays).data ?? null : null

  const snapshot: MonthlySnapshot = {
    client_id: client.id,
    period: periodToDate(period),
    ga4,
    pages: pageUrls.map(url => {
      const c = clarityDays.length ? aggregateStoredDays(clarityDays, url) : null
      return { pageUrl: url, ga4: pageGa4.get(url) ?? null, clarity: c?.isPageLevel ? c.data ?? null : null }
    }),
    clarity: siteClarity,
    clarity_days: clarityDays.length,
    errors
  }

  const { error } = await supabase.from('monthly_snapshots')
    .upsert(snapshot, { onConflict: 'client_id,period' })
  if (error) throw new Error(`Saving snapshot failed: ${error.message}`)
  return snapshot
}

/** Stores yesterday's Clarity export for one client (1 API call of the 10/day allowance). */
export async function storeClarityDay(supabase: SupabaseClient, client: ClientRow) {
  if (!client.clarity_api_token) return { skipped: true }
  const res = await fetchClarityExport(client.clarity_api_token, 1)
  if (!res.success) return { error: res.error }
  const parsed = parseClarityExport(res.metrics)
  // numOfDays=1 covers the last 24 hours, so file it under yesterday's date.
  const day = iso(new Date(Date.now() - 86400000))
  const { error } = await supabase.from('clarity_daily')
    .upsert({ client_id: client.id, day, data: parsed }, { onConflict: 'client_id,day' })
  if (error) return { error: error.message }
  return { day, sessions: parsed.site.totalSessions, pages: parsed.pages.length }
}

// ============================================================
// Before/after impact of a logged change
// ============================================================

export interface ChangeImpact {
  windowDays: number
  before: DateRange
  after: DateRange
  afterComplete: boolean          // false = the after-window hasn't fully elapsed yet
  scope: 'page' | 'site'
  beforeMetrics: { sessions: number; conversions: number; conversionRate: number; revenue?: number }
  afterMetrics: { sessions: number; conversions: number; conversionRate: number; revenue?: number }
  conversionRateChangePct: number | null
  conversionsChangePct: number | null
  sessionsChangePct: number | null
  measuredAt: string
}

/**
 * Compares the N days before a change with the N days after it (the change
 * day itself is excluded). This is a before/after comparison — it shows
 * correlation, not proof: seasonality, campaigns and traffic mix also move
 * these numbers. Reports label it accordingly; A/B tests are the causal
 * evidence.
 */
export async function measureChangeImpact(
  client: ClientRow,
  change: { change_date: string; page_url?: string | null },
  windowDays = 28
): Promise<ChangeImpact | null> {
  if (!client.ga4_property_id) return null
  const d = new Date(`${change.change_date}T00:00:00Z`)
  const day = 86400000
  const before = { startDate: iso(new Date(d.getTime() - windowDays * day)), endDate: iso(new Date(d.getTime() - day)) }
  const afterEnd = new Date(d.getTime() + windowDays * day)
  const yesterday = new Date(Date.now() - day)
  const after = { startDate: iso(new Date(d.getTime() + day)), endDate: iso(afterEnd < yesterday ? afterEnd : yesterday) }
  if (after.endDate < after.startDate) return null // too soon to measure

  const ev = client.ga4_conversion_event
  const measure = async (range: DateRange) => {
    if (change.page_url) {
      const p = await fetchPageMetrics(client.ga4_property_id!, change.page_url, range, ev)
      if (p) return { sessions: p.sessions, conversions: p.conversions, conversionRate: p.conversionRate }
    }
    const site = await fetchGA4AuditData(client.ga4_property_id!, { range, conversionEvent: ev })
    if (!site.success || !site.totals) throw new Error(site.error)
    const t: GA4Totals = site.totals
    return { sessions: t.sessions, conversions: t.conversions, conversionRate: t.conversionRate, revenue: t.revenue }
  }

  const [b, a] = await Promise.all([measure(before), measure(after)])
  // Normalise to per-day so a partial after-window compares fairly
  const daysAfter = (Date.parse(after.endDate) - Date.parse(after.startDate)) / day + 1
  const scale = windowDays / daysAfter
  const aScaled = { ...a, sessions: Math.round(a.sessions * scale), conversions: Math.round(a.conversions * scale), revenue: a.revenue != null ? Math.round(a.revenue * scale) : undefined }

  return {
    windowDays,
    before,
    after,
    afterComplete: daysAfter >= windowDays,
    scope: change.page_url ? 'page' : 'site',
    beforeMetrics: b,
    afterMetrics: aScaled,
    conversionRateChangePct: pctChange(b.conversionRate, a.conversionRate),
    conversionsChangePct: pctChange(b.conversions, aScaled.conversions),
    sessionsChangePct: pctChange(b.sessions, aScaled.sessions),
    measuredAt: new Date().toISOString()
  }
}
