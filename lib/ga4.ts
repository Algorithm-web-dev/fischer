import { BetaAnalyticsDataClient } from '@google-analytics/data'

let client: BetaAnalyticsDataClient | null = null

/**
 * Lazily-created GA4 Data API client, authenticated via a service account.
 * The service account needs "Viewer" access granted on each client's GA4
 * property (Admin > Property Access Management > Add users) — this key
 * alone doesn't grant access to anything, per-property sharing still applies.
 */
function getClient(): BetaAnalyticsDataClient {
  if (client) return client

  const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!credsJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not configured — guardrail checks cannot run without it.')
  }

  const credentials = JSON.parse(credsJson)
  client = new BetaAnalyticsDataClient({ credentials })
  return client
}

export interface GA4MetricResult {
  success: boolean
  value?: number
  error?: string
}

/**
 * Pulls a single metric's total value for a GA4 property over the last N
 * days. Deliberately simple (one metric, one date range, no dimensions) —
 * guardrail checks need a single comparable number, not a full report.
 */
export async function fetchGA4Metric(
  propertyId: string,
  metricName: string,
  daysBack: number = 7
): Promise<GA4MetricResult> {
  try {
    const analyticsClient = getClient()

    const [response] = await analyticsClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: `${daysBack}daysAgo`, endDate: 'today' }],
      metrics: [{ name: metricName }]
    })

    const rawValue = response.rows?.[0]?.metricValues?.[0]?.value
    if (rawValue == null) {
      return { success: false, error: `No data returned for metric "${metricName}" on property ${propertyId}.` }
    }

    return { success: true, value: parseFloat(rawValue) }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown GA4 API error'
    }
  }
}

/**
 * Evaluates a guardrail's current value against its baseline and threshold.
 * Kept separate from the fetch so the threshold logic is unit-testable
 * without needing real GA4 credentials.
 */
export function evaluateGuardrail(
  currentValue: number,
  baselineValue: number | null,
  thresholdType: 'max_drop_pct' | 'min_value' | 'max_value',
  thresholdValue: number
): 'ok' | 'breached' {
  switch (thresholdType) {
    case 'max_drop_pct': {
      if (baselineValue == null || baselineValue === 0) return 'ok' // no baseline yet — can't evaluate a drop
      const dropPct = ((baselineValue - currentValue) / baselineValue) * 100
      return dropPct > thresholdValue ? 'breached' : 'ok'
    }
    case 'min_value':
      return currentValue < thresholdValue ? 'breached' : 'ok'
    case 'max_value':
      return currentValue > thresholdValue ? 'breached' : 'ok'
    default:
      return 'ok'
  }
}
