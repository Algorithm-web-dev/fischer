/**
 * Microsoft Clarity Data Export API.
 *
 * Endpoint: GET https://www.clarity.ms/export-data/api/v1/project-live-insights
 *   ?numOfDays=1|2|3 &dimension1=URL   (Authorization: Bearer <token>)
 *
 * The response is an ARRAY of metric objects, one per metric, each holding an
 * `information` array broken down by the requested dimension:
 *
 *   [
 *     { "metricName": "Traffic", "information": [
 *         { "totalSessionCount": "9554", "totalBotSessionCount": "83", "distantUserCount": "212",
 *           "PagesPerSessionPercentage": 1.03, "Url": "https://site.com/page" }, ... ] },
 *     { "metricName": "RageClickCount", "information": [
 *         { "sessionsCount": "120", "sessionsWithMetricPercentage": 3.2,
 *           "sessionsWithoutMetricPercentage": 96.8, "pagesViews": "...", "subTotal": "...",
 *           "Url": "..." }, ... ] },
 *     { "metricName": "ScrollDepth", "information": [{ "averageScrollDepth": 54.1, "Url": "..." }] },
 *     { "metricName": "EngagementTime", "information": [{ "totalTime": "..", "activeTime": "..", "Url": "..." }] },
 *     ...
 *   ]
 *
 * The previous implementation looked for `data.results` / `data.data` (which
 * don't exist), never matched a row, and silently returned a "successful"
 * result full of zeros — so every audit told the model "0% rage clicks".
 *
 * Limits: 10 requests per project per day, max 3 days per request. That's why
 * the daily cron (app/api/cron/clarity-daily) stores one day at a time in
 * `clarity_daily`, and audits/reports aggregate from that history rather than
 * calling the API live every time.
 */

const ENDPOINT = 'https://www.clarity.ms/export-data/api/v1/project-live-insights'

/** Frustration/behaviour metrics for one URL (or a whole site). */
export interface ClarityPageData {
  url: string
  totalSessions: number
  botSessions: number
  pagesPerSession: number
  rageClickSessions: number
  rageClickRate: number        // % of sessions with at least one rage click
  deadClickSessions: number
  deadClickRate: number
  excessiveScrollSessions: number
  excessiveScrollRate: number
  quickbackSessions: number
  quickbackRate: number
  errorClickSessions: number
  errorClickRate: number
  scriptErrorSessions: number
  scriptErrorRate: number
  avgScrollDepth: number       // %
  avgEngagementTime: number    // seconds (active time per session)
}

export interface ClarityResult {
  success: boolean
  data?: ClarityPageData
  isPageLevel?: boolean        // false = page not found, site-wide numbers used instead
  days?: number
  source?: 'live' | 'stored'
  error?: string
}

/** One day's export, as stored in clarity_daily.data */
export interface ClarityDaily {
  site: ClarityPageData
  pages: ClarityPageData[]
}

type Metric = { metricName: string; information: Record<string, unknown>[] }

const FRUSTRATION_KEYS: Record<string, keyof ClarityPageData> = {
  RageClickCount: 'rageClickSessions',
  DeadClickCount: 'deadClickSessions',
  ExcessiveScroll: 'excessiveScrollSessions',
  QuickbackClick: 'quickbackSessions',
  ErrorClickCount: 'errorClickSessions',
  ScriptErrorCount: 'scriptErrorSessions'
}

const RATE_KEYS: Record<string, keyof ClarityPageData> = {
  RageClickCount: 'rageClickRate',
  DeadClickCount: 'deadClickRate',
  ExcessiveScroll: 'excessiveScrollRate',
  QuickbackClick: 'quickbackRate',
  ErrorClickCount: 'errorClickRate',
  ScriptErrorCount: 'scriptErrorRate'
}

export async function fetchClarityExport(
  apiToken: string,
  numOfDays: 1 | 2 | 3 = 1
): Promise<{ success: true; metrics: Metric[] } | { success: false; error: string }> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20000)
    const res = await fetch(`${ENDPOINT}?numOfDays=${numOfDays}&dimension1=URL`, {
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      signal: controller.signal
    })
    clearTimeout(timeout)
    if (!res.ok) {
      const body = await res.text()
      const hint = res.status === 429 ? ' (daily limit of 10 requests per project reached)'
        : res.status === 401 || res.status === 403 ? ' (token invalid or lacks Data Export access)' : ''
      return { success: false, error: `Clarity API returned ${res.status}${hint}: ${body.slice(0, 200)}` }
    }
    const json = await res.json()
    if (!Array.isArray(json)) {
      return { success: false, error: 'Unexpected Clarity response shape (expected an array of metrics).' }
    }
    return { success: true, metrics: json as Metric[] }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown Clarity API error' }
  }
}

/** Turns the raw export into per-URL rows plus site-wide totals. Pure — unit tested. */
export function parseClarityExport(metrics: Metric[]): ClarityDaily {
  const rows = new Map<string, ClarityPageData & { _scrollW: number; _engW: number }>()
  const get = (url: string) => {
    let r = rows.get(url)
    if (!r) {
      r = { ...emptyPage(url), _scrollW: 0, _engW: 0 }
      rows.set(url, r)
    }
    return r
  }

  const traffic = metrics.find(m => m.metricName === 'Traffic')
  for (const info of traffic?.information ?? []) {
    const url = urlOf(info)
    if (!url) continue
    const r = get(url)
    r.totalSessions += num(info.totalSessionCount)
    r.botSessions += num(info.totalBotSessionCount)
    r.pagesPerSession = num(info.PagesPerSessionPercentage) || r.pagesPerSession
  }

  for (const m of metrics) {
    const countKey = FRUSTRATION_KEYS[m.metricName]
    const rateKey = RATE_KEYS[m.metricName]
    for (const info of m.information ?? []) {
      const url = urlOf(info)
      if (!url) continue
      const r = get(url)
      if (countKey) {
        ;(r[countKey] as number) += num(info.sessionsCount)
        ;(r[rateKey] as number) = num(info.sessionsWithMetricPercentage)
      } else if (m.metricName === 'ScrollDepth') {
        r.avgScrollDepth = num(info.averageScrollDepth)
      } else if (m.metricName === 'EngagementTime') {
        r.avgEngagementTime = num(info.activeTime) || num(info.totalTime)
      }
    }
  }

  const pages = Array.from(rows.values()).map(({ _scrollW, _engW, ...p }) => p)
  // Where Clarity gave counts but no percentage, derive the rate from sessions.
  for (const p of pages) {
    for (const k of Object.keys(FRUSTRATION_KEYS)) {
      const c = FRUSTRATION_KEYS[k], rk = RATE_KEYS[k]
      if (!(p[rk] as number) && p.totalSessions > 0 && (p[c] as number) > 0) {
        ;(p[rk] as number) = round1(((p[c] as number) / p.totalSessions) * 100)
      }
    }
  }
  pages.sort((a, b) => b.totalSessions - a.totalSessions)
  return { site: aggregatePages(pages, 'site-wide'), pages }
}

/**
 * Sums several rows (several URLs, or the same URL over several days) into one,
 * session-weighting the percentages so a 2-session page can't dominate.
 */
export function aggregatePages(pages: ClarityPageData[], url: string): ClarityPageData {
  const out = emptyPage(url)
  if (pages.length === 0) return out
  let sessions = 0
  const weighted: Partial<Record<keyof ClarityPageData, number>> = {}
  for (const p of pages) {
    const w = p.totalSessions || 0
    sessions += w
    out.botSessions += p.botSessions
    for (const k of Object.values(FRUSTRATION_KEYS)) (out[k] as number) += p[k] as number
    for (const k of [...Object.values(RATE_KEYS), 'avgScrollDepth', 'avgEngagementTime', 'pagesPerSession'] as (keyof ClarityPageData)[]) {
      weighted[k] = (weighted[k] ?? 0) + (p[k] as number) * w
    }
  }
  out.totalSessions = sessions
  for (const [k, v] of Object.entries(weighted)) {
    ;(out as any)[k] = sessions > 0 ? round1(v! / sessions) : 0
  }
  return out
}

/** Picks the rows for one page out of a parsed export (ignores query strings, trailing slashes, protocol). */
export function matchPage(pages: ClarityPageData[], pageUrl: string): ClarityPageData[] {
  const target = normaliseUrl(pageUrl)
  return pages.filter(p => normaliseUrl(p.url) === target)
}

/** Live pull for one page — used only when no stored daily history exists yet. */
export async function fetchClarityData(apiToken: string, pageUrl: string): Promise<ClarityResult> {
  const res = await fetchClarityExport(apiToken, 3)
  if (!res.success) return { success: false, error: res.error }
  const parsed = parseClarityExport(res.metrics)
  const matched = matchPage(parsed.pages, pageUrl)
  if (matched.length > 0) {
    return { success: true, data: aggregatePages(matched, pageUrl), isPageLevel: true, days: 3, source: 'live' }
  }
  return { success: true, data: { ...parsed.site, url: pageUrl }, isPageLevel: false, days: 3, source: 'live' }
}

/** Aggregates stored daily exports for one page (or the site when pageUrl omitted). */
export function aggregateStoredDays(days: ClarityDaily[], pageUrl?: string): ClarityResult {
  if (days.length === 0) return { success: false, error: 'No stored Clarity data.' }
  if (!pageUrl) {
    return { success: true, data: aggregatePages(days.map(d => d.site), 'site-wide'), isPageLevel: false, days: days.length, source: 'stored' }
  }
  const matched = days.flatMap(d => matchPage(d.pages ?? [], pageUrl))
  if (matched.length > 0) {
    return { success: true, data: aggregatePages(matched, pageUrl), isPageLevel: true, days: days.length, source: 'stored' }
  }
  return { success: true, data: { ...aggregatePages(days.map(d => d.site), pageUrl) }, isPageLevel: false, days: days.length, source: 'stored' }
}

export function formatClarityForPrompt(result: ClarityResult): string {
  const data = result.data!
  const scope = result.isPageLevel
    ? 'this specific page'
    : 'SITE-WIDE (no page-level rows for this URL — treat as directional, do not attribute to this page specifically)'
  const period = `${result.days} day${result.days === 1 ? '' : 's'}`

  if (data.totalSessions === 0) {
    return `**MICROSOFT CLARITY:** connected, but 0 sessions were recorded for ${scope} in the last ${period}. Do not cite any Clarity metrics.`
  }

  let section = `**REAL USER BEHAVIOUR (Microsoft Clarity, last ${period}, ${scope}):**
- Sessions: ${data.totalSessions.toLocaleString()} (pages per session: ${data.pagesPerSession || 'n/a'})
- Rage clicks: ${data.rageClickRate}% of sessions (${data.rageClickSessions} sessions)
- Dead clicks: ${data.deadClickRate}% of sessions (${data.deadClickSessions} sessions)
- Excessive scrolling: ${data.excessiveScrollRate}% of sessions
- Quick-backs (left almost immediately): ${data.quickbackRate}% of sessions
- Error clicks: ${data.errorClickRate}% · JavaScript errors: ${data.scriptErrorRate}% of sessions
- Average scroll depth: ${Math.round(data.avgScrollDepth)}%
- Average active engagement time: ${Math.round(data.avgEngagementTime)}s`

  const alerts: string[] = []
  if (data.totalSessions >= 100) {
    if (data.rageClickRate > 3) alerts.push(`${data.rageClickRate}% rage-click rate (benchmark < 3%) — something looks clickable or broken`)
    if (data.deadClickRate > 10) alerts.push(`${data.deadClickRate}% dead-click rate — visitors click things that do nothing`)
    if (data.quickbackRate > 15) alerts.push(`${data.quickbackRate}% quick-back rate — visitors don't find what they expected`)
    if (data.scriptErrorRate > 5) alerts.push(`${data.scriptErrorRate}% of sessions hit a JavaScript error`)
    if (data.avgScrollDepth > 0 && data.avgScrollDepth < 40) alerts.push(`Only ${Math.round(data.avgScrollDepth)}% average scroll depth — most visitors never see the lower page`)
  } else {
    section += `\n(Low sample: under 100 sessions — treat Clarity rates as weak evidence.)`
  }
  if (alerts.length > 0) {
    section += `\n\n**CLARITY SIGNALS above benchmark (strong evidence — address each one, tying it to the element in the screenshots where you can):**\n${alerts.map(a => `- ${a}`).join('\n')}`
  }
  return section
}

export function normaliseUrl(u: string): string {
  try {
    const url = new URL(u)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.hostname.replace(/^www\./, '')}${path}`.toLowerCase()
  } catch {
    return u.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase() || '/'
  }
}

function emptyPage(url: string): ClarityPageData {
  return {
    url, totalSessions: 0, botSessions: 0, pagesPerSession: 0,
    rageClickSessions: 0, rageClickRate: 0, deadClickSessions: 0, deadClickRate: 0,
    excessiveScrollSessions: 0, excessiveScrollRate: 0, quickbackSessions: 0, quickbackRate: 0,
    errorClickSessions: 0, errorClickRate: 0, scriptErrorSessions: 0, scriptErrorRate: 0,
    avgScrollDepth: 0, avgEngagementTime: 0
  }
}

function urlOf(info: Record<string, unknown>): string | null {
  const v = info.Url ?? info.URL ?? info.url
  return typeof v === 'string' && v ? v : null
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function round1(n: number) {
  return Math.round(n * 10) / 10
}
