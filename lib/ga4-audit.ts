/**
 * GA4 Data API — audit-time analytics and monthly snapshots.
 *
 * Fixes vs the previous version:
 * - Uses `keyEvents` (GA4 renamed "conversions" to "key events"; the old
 *   metric name is deprecated). If the client has a specific conversion event
 *   configured (clients.ga4_conversion_event, e.g. "generate_lead" or
 *   "purchase"), we use `keyEvents:<event>` so the CVR reflects the thing the
 *   client actually sells, not every key event on the site.
 * - Page metrics filter on the EXACT page path. The old CONTAINS filter on "/"
 *   matched every page on the site and then took whichever row came first.
 * - "Top exit pages" were actually top pages by sessions; GA4 has no exit
 *   metric in the Data API, so we now report top LANDING pages honestly.
 * - Explicit calendar date ranges, so month-over-month comparisons line up.
 *
 * Auth: one service account (GOOGLE_SERVICE_ACCOUNT_KEY). Each client must add
 * that service account's email as a Viewer on their GA4 property.
 */

import { BetaAnalyticsDataClient } from '@google-analytics/data'
import { authForProperty } from './google'

let serviceClient: BetaAnalyticsDataClient | null = null
const oauthClients = new Map<string, BetaAnalyticsDataClient>()

/**
 * GA4 Data API client for a property: the client's own Google connection
 * when one is registered (lib/google.ts registerGoogleAuth), otherwise the
 * agency service account (GOOGLE_SERVICE_ACCOUNT_KEY).
 */
export function getGA4Client(propertyId?: string | null): BetaAnalyticsDataClient {
  const oauth = authForProperty(propertyId)
  if (oauth && propertyId) {
    let c = oauthClients.get(String(propertyId))
    if (!c) { c = new BetaAnalyticsDataClient({ authClient: oauth as any }); oauthClients.set(String(propertyId), c) }
    return c
  }
  if (serviceClient) return serviceClient
  const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!credsJson) throw new Error('No Google connection for this client and GOOGLE_SERVICE_ACCOUNT_KEY is not configured.')
  serviceClient = new BetaAnalyticsDataClient({ credentials: JSON.parse(credsJson) })
  return serviceClient
}

export interface DateRange { startDate: string; endDate: string }

export interface GA4Totals {
  sessions: number
  users: number
  newUsers: number
  pageviews: number
  conversions: number          // key events (or the configured conversion event)
  conversionRate: number       // % of sessions with a conversion
  revenue: number
  transactions: number
  bounceRate: number           // %
  engagementRate: number       // %
  avgSessionDuration: number   // seconds
}

export interface GA4PageMetrics {
  pagePath: string
  views: number
  sessions: number             // sessions that LANDED on this page
  conversions: number          // conversions in sessions that landed here
  conversionRate: number
  bounceRate: number
  engagementRate: number
  avgEngagementTime: number    // seconds per active user
}

export interface GA4AuditData {
  success: boolean
  error?: string
  range?: DateRange
  conversionEvent?: string | null
  totals?: GA4Totals
  deviceSplit?: { desktop: number; mobile: number; tablet: number }
  deviceConversion?: { device: string; sessions: number; conversionRate: number }[]
  topLandingPages?: { page: string; sessions: number; conversionRate: number }[]
  topSources?: { source: string; medium: string; sessions: number; conversionRate: number }[]
  page?: GA4PageMetrics | null
}

/** Last N full days, ending yesterday (today's GA4 data is incomplete). */
export function lastNDays(n: number): DateRange {
  const end = new Date()
  end.setUTCDate(end.getUTCDate() - 1)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - (n - 1))
  return { startDate: iso(start), endDate: iso(end) }
}

/** Calendar month range for a period like "2026-10" (or a Date in that month). */
export function monthRange(period: string): DateRange {
  const [y, m] = period.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1))
  const end = new Date(Date.UTC(y, m, 0))
  return { startDate: iso(start), endDate: iso(end) }
}

export function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function convMetric(event?: string | null) {
  return event ? `keyEvents:${event}` : 'keyEvents'
}
function rateMetric(event?: string | null) {
  return event ? `sessionKeyEventRate:${event}` : 'sessionKeyEventRate'
}

export async function fetchGA4AuditData(
  propertyId: string,
  opts: { pageUrl?: string; range?: DateRange; conversionEvent?: string | null } = {}
): Promise<GA4AuditData> {
  const range = opts.range ?? lastNDays(30)
  const ev = opts.conversionEvent || null
  try {
    const ga = getGA4Client(propertyId)
    const property = `properties/${propertyId}`
    const dateRanges = [range]

    const [core, devices, landing, sources, page] = await Promise.all([
      ga.runReport({
        property, dateRanges,
        metrics: [
          { name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' }, { name: 'screenPageViews' },
          { name: convMetric(ev) }, { name: rateMetric(ev) }, { name: 'totalRevenue' }, { name: 'transactions' },
          { name: 'bounceRate' }, { name: 'engagementRate' }, { name: 'averageSessionDuration' }
        ]
      }),
      ga.runReport({
        property, dateRanges,
        dimensions: [{ name: 'deviceCategory' }],
        metrics: [{ name: 'sessions' }, { name: rateMetric(ev) }]
      }),
      ga.runReport({
        property, dateRanges,
        dimensions: [{ name: 'landingPage' }],
        metrics: [{ name: 'sessions' }, { name: rateMetric(ev) }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 10
      }),
      ga.runReport({
        property, dateRanges,
        dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
        metrics: [{ name: 'sessions' }, { name: rateMetric(ev) }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 8
      }),
      opts.pageUrl ? fetchPageMetrics(propertyId, opts.pageUrl, range, ev) : Promise.resolve(null)
    ])

    const v = core[0]?.rows?.[0]?.metricValues ?? []
    const totals: GA4Totals = {
      sessions: n(v[0]?.value),
      users: n(v[1]?.value),
      newUsers: n(v[2]?.value),
      pageviews: n(v[3]?.value),
      conversions: n(v[4]?.value),
      conversionRate: pct(v[5]?.value),
      revenue: round2(n(v[6]?.value)),
      transactions: n(v[7]?.value),
      bounceRate: pct(v[8]?.value),
      engagementRate: pct(v[9]?.value),
      avgSessionDuration: Math.round(n(v[10]?.value))
    }

    const deviceRows = devices[0]?.rows ?? []
    const deviceTotal = deviceRows.reduce((s, r) => s + n(r.metricValues?.[0]?.value), 0)
    const share = (d: string) => {
      const row = deviceRows.find(r => r.dimensionValues?.[0]?.value === d)
      return deviceTotal > 0 ? Math.round((n(row?.metricValues?.[0]?.value) / deviceTotal) * 100) : 0
    }

    return {
      success: true,
      range,
      conversionEvent: ev,
      totals,
      deviceSplit: deviceTotal > 0 ? { desktop: share('desktop'), mobile: share('mobile'), tablet: share('tablet') } : undefined,
      deviceConversion: deviceRows.map(r => ({
        device: r.dimensionValues?.[0]?.value ?? 'other',
        sessions: n(r.metricValues?.[0]?.value),
        conversionRate: pct(r.metricValues?.[1]?.value)
      })),
      topLandingPages: (landing[0]?.rows ?? []).map(r => ({
        page: r.dimensionValues?.[0]?.value ?? '(not set)',
        sessions: n(r.metricValues?.[0]?.value),
        conversionRate: pct(r.metricValues?.[1]?.value)
      })),
      topSources: (sources[0]?.rows ?? []).map(r => ({
        source: r.dimensionValues?.[0]?.value ?? '(direct)',
        medium: r.dimensionValues?.[1]?.value ?? '(none)',
        sessions: n(r.metricValues?.[0]?.value),
        conversionRate: pct(r.metricValues?.[1]?.value)
      })),
      page
    }
  } catch (err) {
    return { success: false, error: explainGA4Error(err, propertyId) }
  }
}

/** Metrics for one specific page: views (pagePath) + sessions/conversions that landed on it (landingPage). */
export async function fetchPageMetrics(
  propertyId: string,
  pageUrl: string,
  range: DateRange,
  conversionEvent?: string | null
): Promise<GA4PageMetrics | null> {
  const ga = getGA4Client(propertyId)
  const property = `properties/${propertyId}`
  const paths = pathVariants(pageUrl)

  const [views, landing] = await Promise.all([
    ga.runReport({
      property, dateRanges: [range],
      dimensions: [{ name: 'pagePath' }],
      dimensionFilter: { filter: { fieldName: 'pagePath', inListFilter: { values: paths } } },
      metrics: [{ name: 'screenPageViews' }, { name: 'userEngagementDuration' }, { name: 'activeUsers' }]
    }),
    ga.runReport({
      property, dateRanges: [range],
      dimensions: [{ name: 'landingPage' }],
      dimensionFilter: { filter: { fieldName: 'landingPage', inListFilter: { values: paths } } },
      metrics: [{ name: 'sessions' }, { name: convMetric(conversionEvent) }, { name: 'bounceRate' }, { name: 'engagementRate' }]
    })
  ])

  const vr = views[0]?.rows ?? []
  const lr = landing[0]?.rows ?? []
  if (vr.length === 0 && lr.length === 0) return null

  const pageviews = vr.reduce((s, r) => s + n(r.metricValues?.[0]?.value), 0)
  const engDuration = vr.reduce((s, r) => s + n(r.metricValues?.[1]?.value), 0)
  const activeUsers = vr.reduce((s, r) => s + n(r.metricValues?.[2]?.value), 0)
  const sessions = lr.reduce((s, r) => s + n(r.metricValues?.[0]?.value), 0)
  const conversions = lr.reduce((s, r) => s + n(r.metricValues?.[1]?.value), 0)
  // Session-weighted average of the per-variant rates
  const wavg = (i: number) => sessions > 0
    ? lr.reduce((s, r) => s + n(r.metricValues?.[i]?.value) * n(r.metricValues?.[0]?.value), 0) / sessions
    : 0

  return {
    pagePath: paths[0],
    views: pageviews,
    sessions,
    conversions,
    conversionRate: sessions > 0 ? round2((conversions / sessions) * 100) : 0,
    bounceRate: round1(wavg(2) * 100),
    engagementRate: round1(wavg(3) * 100),
    avgEngagementTime: activeUsers > 0 ? Math.round(engDuration / activeUsers) : 0
  }
}

/** "/pricing" and "/pricing/" are separate rows in GA4 — query both. */
export function pathVariants(pageUrl: string): string[] {
  let path: string
  try { path = new URL(pageUrl).pathname } catch { path = pageUrl.split(/[?#]/)[0] }
  if (!path.startsWith('/')) path = '/' + path
  if (path === '/') return ['/']
  const bare = path.replace(/\/+$/, '')
  return [bare, bare + '/']
}

function explainGA4Error(err: unknown, propertyId: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/PERMISSION_DENIED|permission/i.test(msg)) {
    return `GA4 permission denied for property ${propertyId} — add the service account email as a Viewer in GA4 Admin → Property access management.`
  }
  if (/keyEvents:/.test(msg) || /not a valid metric/i.test(msg)) {
    return `GA4 rejected the conversion event — check clients.ga4_conversion_event is an event marked as a key event. (${msg.slice(0, 160)})`
  }
  return msg.slice(0, 300)
}

export function formatGA4ForPrompt(data: GA4AuditData): string {
  if (!data.success || !data.totals) {
    return `**ANALYTICS (GA4): could not be fetched — ${data.error}. Do not invent traffic or conversion numbers.**`
  }
  const t = data.totals
  const conv = data.conversionEvent ? `"${data.conversionEvent}" events` : 'key events (all)'
  let s = `**ANALYTICS (GA4 Data API, live, ${data.range!.startDate} → ${data.range!.endDate}):**
- Sessions: ${t.sessions.toLocaleString()} · Users: ${t.users.toLocaleString()} · Pageviews: ${t.pageviews.toLocaleString()}
- Conversions (${conv}): ${t.conversions.toLocaleString()} → ${t.conversionRate}% session conversion rate
- Revenue: ${t.revenue ? t.revenue.toLocaleString() : 'not tracked'}${t.transactions ? ` from ${t.transactions} transactions` : ''}
- Bounce rate: ${t.bounceRate}% · Engagement rate: ${t.engagementRate}% · Avg session: ${formatDuration(t.avgSessionDuration)}`
  if (t.conversions === 0) {
    s += `\n- NOTE: zero conversions recorded — conversion tracking may not be configured. Flag this as a measurement gap rather than assuming the page converts at 0%.`
  }
  if (data.deviceSplit) {
    s += `\n- Device split: ${data.deviceSplit.mobile}% mobile / ${data.deviceSplit.desktop}% desktop / ${data.deviceSplit.tablet}% tablet`
  }
  if (data.deviceConversion?.length) {
    s += `\n- Conversion rate by device: ${data.deviceConversion.map(d => `${d.device} ${d.conversionRate}%`).join(', ')}`
  }
  if (data.topSources?.length) {
    s += `\n- Top sources: ${data.topSources.slice(0, 5).map(x => `${x.source}/${x.medium} (${x.sessions}, ${x.conversionRate}% CVR)`).join(', ')}`
  }
  if (data.topLandingPages?.length) {
    s += `\n- Top landing pages: ${data.topLandingPages.slice(0, 5).map(x => `${x.page} (${x.sessions}, ${x.conversionRate}% CVR)`).join(', ')}`
  }
  if (data.page) {
    const p = data.page
    s += `\n\n**THIS PAGE (${p.pagePath}):** ${p.views.toLocaleString()} views · ${p.sessions.toLocaleString()} landing sessions · ${p.conversionRate}% CVR of sessions landing here · bounce ${p.bounceRate}% · engagement ${p.engagementRate}% · avg engaged time ${formatDuration(p.avgEngagementTime)}`
  } else if (data.page === null) {
    s += `\n\n**THIS PAGE:** no GA4 rows found for this exact path in the period.`
  }
  return s
}

export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
function pct(v: unknown): number {
  return round2(n(v) * 100)
}
function round1(x: number) { return Math.round(x * 10) / 10 }
function round2(x: number) { return Math.round(x * 100) / 100 }
