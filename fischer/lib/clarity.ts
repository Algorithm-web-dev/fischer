/**
 * Microsoft Clarity Data Export API integration.
 *
 * Pulls real user behaviour signals — rage clicks, dead clicks, excessive
 * scroll, engagement time — per page URL. This is the qualitative layer
 * Fischer was missing: the scraper sees the page structure, PageSpeed sees
 * performance, but only Clarity sees how real humans actually interact.
 *
 * API limits: 10 requests/day per project, max 3 days per request.
 * Fine for CRO retainer volume (a few audits per client per month).
 *
 * Setup per client:
 *   1. In Clarity → Settings → Data Export → Generate new API token
 *   2. Store the token + project ID in the clients table
 *   3. The service account needs no extra permissions — the token is scoped
 */

export interface ClarityPageData {
  url: string
  totalSessions: number
  rageClickCount: number
  deadClickCount: number
  excessiveScrollCount: number
  quickbackClickCount: number
  errorClickCount: number
  scriptErrorCount: number
  avgEngagementTime: number    // seconds
  avgScrollDepth: number       // percentage
  rageClickRate: number        // rage clicks as % of total sessions
  deadClickRate: number        // dead clicks as % of total sessions
}

export interface ClarityResult {
  success: boolean
  data?: ClarityPageData
  rawMetrics?: Record<string, any>
  error?: string
}

/**
 * Fetches the last 3 days of Clarity dashboard metrics for a specific page,
 * broken down by URL dimension so we can isolate the page being audited.
 */
export async function fetchClarityData(
  projectId: string,
  apiToken: string,
  pageUrl: string
): Promise<ClarityResult> {
  const endpoint = 'https://www.clarity.ms/export-data/api/v1/project-live-insights'

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    // Pull 3 days of data broken down by URL — this gives us per-page metrics
    const res = await fetch(
      `${endpoint}?numOfDays=3&dimension1=URL`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal
      }
    )
    clearTimeout(timeout)

    if (!res.ok) {
      const body = await res.text()
      return {
        success: false,
        error: `Clarity API returned ${res.status}: ${body.slice(0, 300)}`
      }
    }

    const data = await res.json()

    // The API returns aggregated metrics — we need to find the row(s)
    // matching our target page URL. The URL dimension value can be a
    // full URL or a path, depending on Clarity's normalisation.
    const targetPath = extractPath(pageUrl)
    const allRows = data?.results || data?.data || []

    // Find metrics for our specific page
    const pageMetrics = findPageMetrics(allRows, pageUrl, targetPath)

    if (!pageMetrics) {
      // No data for this specific page — Clarity may not have enough
      // sessions yet, or the URL isn't tracked. Return what we have
      // at the project level as a fallback.
      return {
        success: true,
        data: buildProjectLevelData(data, pageUrl),
        rawMetrics: data
      }
    }

    return {
      success: true,
      data: pageMetrics,
      rawMetrics: data
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown Clarity API error'
    }
  }
}

/**
 * Extract just the pathname from a URL for fuzzy matching against Clarity's
 * URL dimension values, which may or may not include the protocol/domain.
 */
function extractPath(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/$/, '') || '/'
  } catch {
    return url
  }
}

/**
 * Search through Clarity's response data to find metrics for our target page.
 * The response structure varies — handle both flat metrics and dimension-broken arrays.
 */
function findPageMetrics(
  rows: any[],
  fullUrl: string,
  targetPath: string
): ClarityPageData | null {
  if (!Array.isArray(rows) || rows.length === 0) return null

  for (const row of rows) {
    const rowUrl = (row.URL || row.url || row.dimension1Value || '').toString()
    const rowPath = extractPath(rowUrl)

    // Match on full URL, path only, or path with trailing slash variation
    if (
      rowUrl === fullUrl ||
      rowPath === targetPath ||
      rowUrl.includes(targetPath)
    ) {
      return extractMetricsFromRow(row, fullUrl)
    }
  }

  return null
}

/**
 * Extract typed metrics from a Clarity API response row.
 */
function extractMetricsFromRow(row: any, url: string): ClarityPageData {
  const sessions = toNum(row.Traffic || row.totalSessions || row.sessions || 0)
  const rageClicks = toNum(row.RageClickCount || row.rageClickCount || 0)
  const deadClicks = toNum(row.DeadClickCount || row.deadClickCount || 0)
  const excessiveScroll = toNum(row.ExcessiveScroll || row.excessiveScrollCount || 0)
  const quickback = toNum(row.QuickbackClick || row.quickbackClickCount || 0)
  const errorClicks = toNum(row.ErrorClickCount || row.errorClickCount || 0)
  const scriptErrors = toNum(row.ScriptErrorCount || row.scriptErrorCount || 0)
  const engagementTime = toNum(row.EngagementTime || row.avgEngagementTime || 0)
  const scrollDepth = toNum(row.ScrollDepth || row.avgScrollDepth || 0)

  return {
    url,
    totalSessions: sessions,
    rageClickCount: rageClicks,
    deadClickCount: deadClicks,
    excessiveScrollCount: excessiveScroll,
    quickbackClickCount: quickback,
    errorClickCount: errorClicks,
    scriptErrorCount: scriptErrors,
    avgEngagementTime: engagementTime,
    avgScrollDepth: scrollDepth,
    rageClickRate: sessions > 0 ? Math.round((rageClicks / sessions) * 100 * 10) / 10 : 0,
    deadClickRate: sessions > 0 ? Math.round((deadClicks / sessions) * 100 * 10) / 10 : 0
  }
}

/**
 * Fallback: if we can't find page-specific data, return project-level
 * aggregates. Better than nothing — the prompt will note it's site-wide.
 */
function buildProjectLevelData(data: any, url: string): ClarityPageData {
  // Project-level metrics are often in the top-level response
  return {
    url,
    totalSessions: toNum(data?.Traffic || data?.totalSessions || 0),
    rageClickCount: toNum(data?.RageClickCount || 0),
    deadClickCount: toNum(data?.DeadClickCount || 0),
    excessiveScrollCount: toNum(data?.ExcessiveScroll || 0),
    quickbackClickCount: toNum(data?.QuickbackClick || 0),
    errorClickCount: toNum(data?.ErrorClickCount || 0),
    scriptErrorCount: toNum(data?.ScriptErrorCount || 0),
    avgEngagementTime: toNum(data?.EngagementTime || 0),
    avgScrollDepth: toNum(data?.ScrollDepth || 0),
    rageClickRate: 0,
    deadClickRate: 0
  }
}

function toNum(val: any): number {
  const n = Number(val)
  return isNaN(n) ? 0 : n
}

/**
 * Formats Clarity data into a prompt section for Claude.
 * This is what makes Fischer's recommendations specific: instead of
 * guessing "users might find this confusing," it can say "35% rage
 * click rate on this element — users ARE finding it confusing."
 */
export function formatClarityForPrompt(data: ClarityPageData, isPageLevel: boolean): string {
  const scope = isPageLevel ? 'this specific page' : 'site-wide (page-level data not available — treat as directional)'

  let section = `**REAL USER BEHAVIOUR (Microsoft Clarity, last 72 hours, ${scope}):**
- Total sessions: ${data.totalSessions.toLocaleString()}
- Rage clicks: ${data.rageClickCount} (${data.rageClickRate}% of sessions) — users clicking repeatedly on elements that don't respond as expected
- Dead clicks: ${data.deadClickCount} (${data.deadClickRate}% of sessions) — users clicking elements that do nothing
- Excessive scrolling: ${data.excessiveScrollCount} sessions — users hunting for content, likely can't find what they need
- Quick-back clicks: ${data.quickbackClickCount} — users immediately returning to the previous page (strong intent mismatch signal)
- JavaScript errors: ${data.scriptErrorCount} — broken functionality users are hitting
- Average engagement time: ${Math.round(data.avgEngagementTime)}s
- Average scroll depth: ${Math.round(data.avgScrollDepth)}%`

  // Add diagnostic interpretation
  const alerts: string[] = []
  if (data.rageClickRate > 5) alerts.push(`CRITICAL: ${data.rageClickRate}% rage click rate is far above the <3% benchmark — a UI element is broken or misleading`)
  if (data.deadClickRate > 10) alerts.push(`HIGH: ${data.deadClickRate}% dead click rate — users expect interactivity where there is none`)
  if (data.quickbackClickCount > data.totalSessions * 0.15) alerts.push(`HIGH: Quick-back rate suggests intent mismatch — visitors aren't finding what they expected`)
  if (data.avgScrollDepth < 40) alerts.push(`MEDIUM: Only ${Math.round(data.avgScrollDepth)}% average scroll depth — most visitors never see below-the-fold content`)
  if (data.scriptErrorCount > 10) alerts.push(`HIGH: ${data.scriptErrorCount} JS errors in 72 hours — functionality is breaking for real users`)

  if (alerts.length > 0) {
    section += `\n\n**CLARITY ALERT — these MUST appear in your friction points:**\n${alerts.map(a => `- ${a}`).join('\n')}`
  }

  return section
}
