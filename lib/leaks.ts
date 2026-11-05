import { getGA4Client, type DateRange } from './ga4-audit'

/**
 * Revenue leak map.
 *
 * Answers "where is this site losing money?" from GA4 before anyone picks a
 * page to audit. The unit of analysis is a landing page × device CELL (e.g.
 * "/quote on mobile"). Each cell is compared with the site's own conversion
 * rate for that device. Because every session belongs to exactly one cell,
 * totals by page, by device and overall never double count.
 *
 *   gap         = sessions × (target CVR − actual CVR) × value per conversion
 *   recoverable = gap × RECOVERY_FACTOR   (we claim we can close half the gap)
 *
 * Two further insights are reported separately (they overlap with the cells,
 * so they are NOT added to the total):
 *   - Mobile gap: if mobile converted at MOBILE_PARITY × the desktop rate
 *   - Paid traffic: paid channels converting below the site average, per
 *     landing page — i.e. ad spend landing on pages that don't convert
 *
 * The target is the site's OWN average, not an external benchmark: it is
 * achievable by definition (other pages on the same site already do it) and
 * it can't be argued with. Cross-client industry benchmarks, once there are
 * enough clients, can raise the target (see lib/benchmarks.ts).
 */

export const RECOVERY_FACTOR = 0.5
export const MOBILE_PARITY = 0.7       // mobile typically converts at 50–80% of desktop
export const MIN_CELL_SESSIONS = 100   // per period; below this the rate is noise
const PAID_CHANNELS = ['Paid Search', 'Paid Social', 'Paid Shopping', 'Paid Video', 'Display', 'Paid Other', 'Cross-network']

export interface CellRow { page: string; device: string; sessions: number; conversions: number; revenue: number }
export interface ChannelRow { page: string; channel: string; sessions: number; conversions: number }

export interface LeakCell {
  page: string
  device: string
  sessions: number
  conversions: number
  conversionRate: number
  targetRate: number
  lostConversions: number      // per period, before the recovery factor
  gapValue: number             // per period
  recoverableValue: number     // per period, after the recovery factor
}

export interface PageLeak {
  page: string
  url: string | null
  sessions: number
  conversions: number
  conversionRate: number
  gapValue: number
  recoverableValue: number
  worstDevice: string | null
  share: number                // % of total recoverable
  cells: LeakCell[]
}

export interface LeakAnalysis {
  range: DateRange
  periodDays: number
  valuePerConversion: number
  valueBasis: 'client_setting' | 'ga4_revenue' | 'none'
  conversionEvent: string | null
  site: { sessions: number; conversions: number; conversionRate: number; byDevice: Record<string, { sessions: number; conversions: number; conversionRate: number }> }
  totals: { gapValue: number; recoverableValue: number; recoverableMonthly: number }
  byDevice: { device: string; recoverableValue: number; share: number }[]
  pages: PageLeak[]
  mobileGap: { mobileRate: number; desktopRate: number; targetRate: number; mobileSessions: number; lostConversions: number; value: number } | null
  paidTraffic: { page: string; url: string | null; channel: string; sessions: number; conversionRate: number; siteRate: number; lostConversions: number; value: number }[]
  notes: string[]
  generatedAt: string
}

const round = (n: number, dp = 0) => Math.round(n * 10 ** dp) / 10 ** dp

/** Pure computation — unit tested. */
export function computeLeaks(params: {
  cells: CellRow[]
  channels: ChannelRow[]
  range: DateRange
  valuePerConversion: number
  valueBasis: LeakAnalysis['valueBasis']
  conversionEvent?: string | null
  siteOrigin?: string | null
  minCellSessions?: number
  targetOverrides?: Partial<Record<string, number>>   // device → CVR % (e.g. from benchmarks)
}): LeakAnalysis {
  const minSessions = params.minCellSessions ?? MIN_CELL_SESSIONS
  const periodDays = Math.round((Date.parse(params.range.endDate) - Date.parse(params.range.startDate)) / 86400000) + 1
  const value = params.valuePerConversion
  const toUrl = (page: string) => params.siteOrigin && page.startsWith('/') ? params.siteOrigin.replace(/\/$/, '') + page : null
  const notes: string[] = []

  // Site rates by device
  const byDevice: LeakAnalysis['site']['byDevice'] = {}
  let siteSessions = 0, siteConv = 0
  for (const c of params.cells) {
    const d = (byDevice[c.device] ??= { sessions: 0, conversions: 0, conversionRate: 0 })
    d.sessions += c.sessions; d.conversions += c.conversions
    siteSessions += c.sessions; siteConv += c.conversions
  }
  for (const d of Object.values(byDevice)) d.conversionRate = d.sessions ? round((d.conversions / d.sessions) * 100, 2) : 0
  const siteRate = siteSessions ? (siteConv / siteSessions) * 100 : 0

  if (siteConv === 0) notes.push('GA4 recorded no conversions in this period — fix conversion tracking before trusting any leak figures.')
  if (!value) notes.push('No value per conversion is set for this client, so leaks are shown in lost conversions, not rand. Set "Value per conversion" in Settings.')

  // Cells
  const leakCells: LeakCell[] = []
  for (const c of params.cells) {
    if (c.sessions < minSessions || c.page === '(not set)') continue
    const target = params.targetOverrides?.[c.device] ?? byDevice[c.device]?.conversionRate ?? 0
    const rate = (c.conversions / c.sessions) * 100
    const lost = Math.max(0, (c.sessions * (target - rate)) / 100)
    leakCells.push({
      page: c.page, device: c.device, sessions: c.sessions, conversions: c.conversions,
      conversionRate: round(rate, 2), targetRate: round(target, 2),
      lostConversions: round(lost, 1), gapValue: Math.round(lost * value), recoverableValue: Math.round(lost * value * RECOVERY_FACTOR)
    })
  }

  // Pages
  const pageMap = new Map<string, LeakCell[]>()
  for (const c of leakCells) (pageMap.get(c.page) ?? pageMap.set(c.page, []).get(c.page)!).push(c)
  const totalRecoverable = leakCells.reduce((s, c) => s + c.recoverableValue, 0)
  const totalLost = leakCells.reduce((s, c) => s + c.lostConversions, 0)
  const pages: PageLeak[] = Array.from(pageMap.entries()).map(([page, cells]) => {
    const sessions = cells.reduce((s, c) => s + c.sessions, 0)
    const conversions = cells.reduce((s, c) => s + c.conversions, 0)
    const recoverable = cells.reduce((s, c) => s + c.recoverableValue, 0)
    const lost = cells.reduce((s, c) => s + c.lostConversions, 0)
    const worst = cells.slice().sort((a, b) => b.lostConversions - a.lostConversions)[0]
    return {
      page, url: toUrl(page), sessions, conversions,
      conversionRate: sessions ? round((conversions / sessions) * 100, 2) : 0,
      gapValue: cells.reduce((s, c) => s + c.gapValue, 0),
      recoverableValue: recoverable,
      worstDevice: worst && worst.lostConversions > 0 ? worst.device : null,
      // share by lost conversions so it works even without a rand value
      share: totalLost ? round((lost / totalLost) * 100, 1) : 0,
      cells: cells.sort((a, b) => b.lostConversions - a.lostConversions)
    }
  }).filter(p => p.cells.some(c => c.lostConversions > 0))
    .sort((a, b) => b.cells.reduce((s, c) => s + c.lostConversions, 0) - a.cells.reduce((s, c) => s + c.lostConversions, 0))

  const devices = Array.from(new Set(leakCells.map(c => c.device)))
  const deviceTotals = devices.map(device => {
    const lost = leakCells.filter(c => c.device === device).reduce((s, c) => s + c.lostConversions, 0)
    return { device, recoverableValue: leakCells.filter(c => c.device === device).reduce((s, c) => s + c.recoverableValue, 0), share: totalLost ? round((lost / totalLost) * 100, 1) : 0 }
  }).sort((a, b) => b.share - a.share)

  // Mobile gap (separate insight)
  let mobileGap: LeakAnalysis['mobileGap'] = null
  const m = byDevice['mobile'], d = byDevice['desktop']
  if (m && d && m.sessions >= minSessions && d.sessions >= minSessions && d.conversionRate > 0) {
    const target = d.conversionRate * MOBILE_PARITY
    if (m.conversionRate < target) {
      const lost = (m.sessions * (target - m.conversionRate)) / 100
      mobileGap = { mobileRate: m.conversionRate, desktopRate: d.conversionRate, targetRate: round(target, 2), mobileSessions: m.sessions, lostConversions: round(lost, 1), value: Math.round(lost * value * RECOVERY_FACTOR) }
    }
  }

  // Paid traffic landing on under-performing pages (separate insight)
  const paidTraffic = params.channels
    .filter(r => PAID_CHANNELS.includes(r.channel) && r.sessions >= minSessions)
    .map(r => {
      const rate = (r.conversions / r.sessions) * 100
      const lost = Math.max(0, (r.sessions * (siteRate - rate)) / 100)
      return { page: r.page, url: toUrl(r.page), channel: r.channel, sessions: r.sessions, conversionRate: round(rate, 2), siteRate: round(siteRate, 2), lostConversions: round(lost, 1), value: Math.round(lost * value * RECOVERY_FACTOR) }
    })
    .filter(r => r.lostConversions > 0)
    .sort((a, b) => b.lostConversions - a.lostConversions)
    .slice(0, 10)

  const scale = 30 / Math.max(1, periodDays)
  return {
    range: params.range,
    periodDays,
    valuePerConversion: value,
    valueBasis: params.valueBasis,
    conversionEvent: params.conversionEvent ?? null,
    site: { sessions: siteSessions, conversions: siteConv, conversionRate: round(siteRate, 2), byDevice },
    totals: {
      gapValue: leakCells.reduce((s, c) => s + c.gapValue, 0),
      recoverableValue: totalRecoverable,
      recoverableMonthly: Math.round(totalRecoverable * scale)
    },
    byDevice: deviceTotals,
    pages: pages.slice(0, 25),
    mobileGap,
    paidTraffic,
    notes,
    generatedAt: new Date().toISOString()
  }
}

/** Pulls the GA4 rows and computes the leak map for one client. */
export async function fetchLeakAnalysis(params: {
  propertyId: string
  range: DateRange
  conversionEvent?: string | null
  valuePerConversion?: number | null
  siteOrigin?: string | null
  targetOverrides?: Partial<Record<string, number>>
}): Promise<LeakAnalysis> {
  const ga = getGA4Client()
  const property = `properties/${params.propertyId}`
  const conv = params.conversionEvent ? `keyEvents:${params.conversionEvent}` : 'keyEvents'

  const [cellReport, channelReport] = await Promise.all([
    ga.runReport({
      property, dateRanges: [params.range],
      dimensions: [{ name: 'landingPage' }, { name: 'deviceCategory' }],
      metrics: [{ name: 'sessions' }, { name: conv }, { name: 'totalRevenue' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 1000
    }),
    ga.runReport({
      property, dateRanges: [params.range],
      dimensions: [{ name: 'landingPage' }, { name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: conv }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 1000
    })
  ])

  const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }
  const cells: CellRow[] = (cellReport[0]?.rows ?? []).map(r => ({
    page: stripQuery(r.dimensionValues?.[0]?.value ?? '(not set)'),
    device: r.dimensionValues?.[1]?.value ?? 'other',
    sessions: n(r.metricValues?.[0]?.value),
    conversions: n(r.metricValues?.[1]?.value),
    revenue: n(r.metricValues?.[2]?.value)
  }))
  const channels: ChannelRow[] = (channelReport[0]?.rows ?? []).map(r => ({
    page: stripQuery(r.dimensionValues?.[0]?.value ?? '(not set)'),
    channel: r.dimensionValues?.[1]?.value ?? 'Unassigned',
    sessions: n(r.metricValues?.[0]?.value),
    conversions: n(r.metricValues?.[1]?.value)
  }))

  let value = params.valuePerConversion || 0
  let basis: LeakAnalysis['valueBasis'] = value ? 'client_setting' : 'none'
  const revenue = cells.reduce((s, c) => s + c.revenue, 0)
  const conversions = cells.reduce((s, c) => s + c.conversions, 0)
  if (!value && revenue > 0 && conversions > 0) { value = Math.round(revenue / conversions); basis = 'ga4_revenue' }

  return computeLeaks({
    cells: mergeRows(cells, ['page', 'device']),
    channels: mergeRows(channels, ['page', 'channel']),
    range: params.range,
    valuePerConversion: value,
    valueBasis: basis,
    conversionEvent: params.conversionEvent,
    siteOrigin: params.siteOrigin,
    targetOverrides: params.targetOverrides
  })
}

/** GA4 landingPage can include query strings; "/p?utm=a" and "/p" are the same page. */
function stripQuery(p: string) {
  const path = p.split(/[?#]/)[0]
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

function mergeRows<T extends Record<string, any>>(rows: T[], keys: (keyof T)[]): T[] {
  const map = new Map<string, T>()
  for (const r of rows) {
    const k = keys.map(x => r[x]).join('|')
    const existing = map.get(k)
    if (!existing) { map.set(k, { ...r }); continue }
    for (const [f, v] of Object.entries(r)) if (typeof v === 'number') (existing as any)[f] += v
  }
  return Array.from(map.values())
}

/** Finds the leak entry for one URL (used to focus an audit on its known leak). */
export function leakForUrl(analysis: LeakAnalysis | null | undefined, pageUrl: string): PageLeak | null {
  if (!analysis) return null
  let path: string
  try { path = new URL(pageUrl).pathname } catch { path = pageUrl }
  path = path.length > 1 ? path.replace(/\/+$/, '') : path
  return analysis.pages.find(p => p.page === path) ?? null
}
