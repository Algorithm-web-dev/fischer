/**
 * GA4 Data API integration for audit-time analytics.
 *
 * The existing lib/ga4.ts handles guardrail metric checks (single-metric,
 * single-date-range). This module does the richer pull needed at audit time:
 * traffic, conversion rate, bounce rate, device split, session duration,
 * and top exit pages — all from the live GA4 property, replacing the
 * manually-typed form fields.
 *
 * Same service account key (GOOGLE_SERVICE_ACCOUNT_KEY) — the account just
 * needs Viewer access on each client's GA4 property (one-time setup step).
 */

import { BetaAnalyticsDataClient } from '@google-analytics/data'

let client: BetaAnalyticsDataClient | null = null

function getClient(): BetaAnalyticsDataClient {
  if (client) return client
  const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!credsJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not configured.')
  }
  client = new BetaAnalyticsDataClient({ credentials: JSON.parse(credsJson) })
  return client
}

export interface GA4AuditData {
  success: boolean

  // Core metrics
  totalSessions?: number
  totalUsers?: number
  pageviews?: number

  // Conversion
  conversionRate?: number          // as a percentage, e.g. 1.8
  totalConversions?: number

  // Engagement
  bounceRate?: number              // as a percentage
  avgSessionDuration?: number      // seconds
  engagementRate?: number          // as a percentage

  // Device split
  deviceSplit?: {
    desktop: number                // percentage
    mobile: number
    tablet: number
  }

  // Top exit pages (up to 5)
  topExitPages?: { page: string; exits: number }[]

  // Traffic sources (top 5)
  topSources?: { source: string; medium: string; sessions: number }[]

  // Page-specific metrics (if a page URL filter was applied)
  pageMetrics?: {
    pageviews: number
    avgTimeOnPage: number
    bounceRate: number
    exitRate: number
  }

  error?: string
  daysBack?: number
}

/**
 * Pulls a comprehensive set of analytics data for a client's GA4 property.
 * Optionally filters to a specific page URL for page-level audit context.
 *
 * @param propertyId - GA4 property ID (just the number, e.g. "123456789")
 * @param pageUrl - Optional: filter metrics to this specific page
 * @param daysBack - How many days to look back (default 30)
 */
export async function fetchGA4AuditData(
  propertyId: string,
  pageUrl?: string,
  daysBack: number = 30
): Promise<GA4AuditData> {
  try {
    const analyticsClient = getClient()
    const property = `properties/${propertyId}`
    const dateRange = { startDate: `${daysBack}daysAgo`, endDate: 'today' }

    // Run multiple reports concurrently for speed
    const [coreMetrics, deviceData, exitPages, trafficSources, pageData] = await Promise.all([
      // 1. Core site metrics
      analyticsClient.runReport({
        property,
        dateRanges: [dateRange],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'screenPageViews' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
          { name: 'engagementRate' },
          { name: 'conversions' }
        ]
      }),

      // 2. Device breakdown
      analyticsClient.runReport({
        property,
        dateRanges: [dateRange],
        dimensions: [{ name: 'deviceCategory' }],
        metrics: [{ name: 'sessions' }]
      }),

      // 3. Top exit pages
      analyticsClient.runReport({
        property,
        dateRanges: [dateRange],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 5
      }),

      // 4. Top traffic sources
      analyticsClient.runReport({
        property,
        dateRanges: [dateRange],
        dimensions: [
          { name: 'sessionSource' },
          { name: 'sessionMedium' }
        ],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 5
      }),

      // 5. Page-specific metrics (only if a page URL was provided)
      pageUrl
        ? analyticsClient.runReport({
            property,
            dateRanges: [dateRange],
            dimensions: [{ name: 'pagePath' }],
            dimensionFilter: {
              filter: {
                fieldName: 'pagePath',
                stringFilter: {
                  matchType: 'CONTAINS' as any,
                  value: extractPath(pageUrl)
                }
              }
            },
            metrics: [
              { name: 'screenPageViews' },
              { name: 'averageSessionDuration' },
              { name: 'bounceRate' }
            ]
          })
        : Promise.resolve([null])
    ])

    // Parse core metrics
    const coreRow = coreMetrics[0]?.rows?.[0]?.metricValues
    const totalSessions = toNum(coreRow?.[0]?.value)
    const totalUsers = toNum(coreRow?.[1]?.value)
    const pageviews = toNum(coreRow?.[2]?.value)
    const bounceRate = toNum(coreRow?.[3]?.value) * 100
    const avgSessionDuration = toNum(coreRow?.[4]?.value)
    const engagementRate = toNum(coreRow?.[5]?.value) * 100
    const totalConversions = toNum(coreRow?.[6]?.value)
    const conversionRate = totalSessions > 0 ? (totalConversions / totalSessions) * 100 : 0

    // Parse device data
    const deviceRows = deviceData[0]?.rows || []
    const deviceTotals: Record<string, number> = {}
    let deviceSum = 0
    for (const row of deviceRows) {
      const device = row.dimensionValues?.[0]?.value?.toLowerCase() || 'other'
      const sessions = toNum(row.metricValues?.[0]?.value)
      deviceTotals[device] = sessions
      deviceSum += sessions
    }
    const deviceSplit = deviceSum > 0
      ? {
          desktop: Math.round(((deviceTotals['desktop'] || 0) / deviceSum) * 100),
          mobile: Math.round(((deviceTotals['mobile'] || 0) / deviceSum) * 100),
          tablet: Math.round(((deviceTotals['tablet'] || 0) / deviceSum) * 100)
        }
      : undefined

    // Parse exit pages
    const topExitPages = (exitPages[0]?.rows || []).map(row => ({
      page: row.dimensionValues?.[0]?.value || '(unknown)',
      exits: toNum(row.metricValues?.[0]?.value)
    }))

    // Parse traffic sources
    const topSources = (trafficSources[0]?.rows || []).map(row => ({
      source: row.dimensionValues?.[0]?.value || '(direct)',
      medium: row.dimensionValues?.[1]?.value || '(none)',
      sessions: toNum(row.metricValues?.[0]?.value)
    }))

    // Parse page-specific metrics
    let pageMetrics: GA4AuditData['pageMetrics'] | undefined
    const pageRow = pageData[0]?.rows?.[0]
    if (pageRow) {
      pageMetrics = {
        pageviews: toNum(pageRow.metricValues?.[0]?.value),
        avgTimeOnPage: toNum(pageRow.metricValues?.[1]?.value),
        bounceRate: toNum(pageRow.metricValues?.[2]?.value) * 100,
        exitRate: 0 // GA4 doesn't have exitRate as a direct metric
      }
    }

    return {
      success: true,
      totalSessions: Math.round(totalSessions),
      totalUsers: Math.round(totalUsers),
      pageviews: Math.round(pageviews),
      conversionRate: Math.round(conversionRate * 100) / 100,
      totalConversions: Math.round(totalConversions),
      bounceRate: Math.round(bounceRate * 10) / 10,
      avgSessionDuration: Math.round(avgSessionDuration),
      engagementRate: Math.round(engagementRate * 10) / 10,
      deviceSplit,
      topExitPages,
      topSources,
      pageMetrics,
      daysBack
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown GA4 API error'
    }
  }
}

function extractPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function toNum(val: any): number {
  const n = Number(val)
  return isNaN(n) ? 0 : n
}

/**
 * Formats GA4 data into a prompt section for Claude. Replaces the manually
 * typed analytics fields — every number here is real, pulled minutes ago.
 */
export function formatGA4ForPrompt(data: GA4AuditData): string {
  if (!data.success) {
    return `**ANALYTICS DATA (GA4): COULD NOT BE FETCHED — ${data.error}. The user may provide manual analytics data below instead.**`
  }

  const period = `last ${data.daysBack || 30} days`

  let section = `**ANALYTICS DATA (GA4 Data API, live — ${period}):**
- Monthly traffic: ~${Math.round((data.totalSessions || 0) * (30 / (data.daysBack || 30))).toLocaleString()} sessions/month (${data.totalSessions?.toLocaleString()} in the period)
- Unique users: ${data.totalUsers?.toLocaleString()}
- Pageviews: ${data.pageviews?.toLocaleString()}
- Conversion rate: ${data.conversionRate}% (${data.totalConversions?.toLocaleString()} conversions)
- Bounce rate: ${data.bounceRate}%
- Engagement rate: ${data.engagementRate}%
- Average session duration: ${formatDuration(data.avgSessionDuration || 0)}`

  if (data.deviceSplit) {
    section += `\n- Device split: ${data.deviceSplit.mobile}% Mobile / ${data.deviceSplit.desktop}% Desktop / ${data.deviceSplit.tablet}% Tablet`
  }

  if (data.topExitPages && data.topExitPages.length > 0) {
    section += `\n- Top exit pages: ${data.topExitPages.map(p => `${p.page} (${p.exits} exits)`).join(', ')}`
  }

  if (data.topSources && data.topSources.length > 0) {
    section += `\n- Top traffic sources: ${data.topSources.map(s => `${s.source}/${s.medium} (${s.sessions})`).join(', ')}`
  }

  if (data.pageMetrics) {
    section += `\n\n**PAGE-SPECIFIC METRICS (for the audited URL):**
- Page-level pageviews: ${data.pageMetrics.pageviews.toLocaleString()}
- Page-level bounce rate: ${Math.round(data.pageMetrics.bounceRate * 10) / 10}%
- Avg time on page: ${formatDuration(data.pageMetrics.avgTimeOnPage)}`
  }

  return section
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
}
