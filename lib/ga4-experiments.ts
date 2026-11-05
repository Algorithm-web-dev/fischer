import { getGA4Client, type DateRange } from './ga4-audit'

/**
 * Reads A/B test results straight from GA4.
 *
 * Requirements (one-off per client, see README "A/B test results from GA4"):
 * - The testing tool writes the visitor's variant to a USER-scoped custom
 *   dimension (most tools — VWO, Convert, AB Tasty, Optimizely — have a GA4
 *   integration that does this, or a one-line gtag('set','user_properties',…)).
 * - That user property is registered as a custom dimension in GA4 Admin, so it
 *   is queryable as `customUser:<name>`.
 *
 * Visitors = users in each variant; conversions = users who completed a key
 * event (or the client's specific conversion event).
 */
export async function fetchExperimentResults(params: {
  propertyId: string
  dimension: string               // e.g. "customUser:exp_variant"
  controlValue: string            // e.g. "VWO-12-control"
  variantValue: string            // e.g. "VWO-12-variant-1"
  range: DateRange
  conversionEvent?: string | null
}): Promise<{ control: { visitors: number; conversions: number }; variant: { visitors: number; conversions: number } }> {
  const ga = getGA4Client()
  const rateMetric = params.conversionEvent ? `userKeyEventRate:${params.conversionEvent}` : 'userKeyEventRate'
  const [report] = await ga.runReport({
    property: `properties/${params.propertyId}`,
    dateRanges: [params.range],
    dimensions: [{ name: params.dimension }],
    dimensionFilter: { filter: { fieldName: params.dimension, inListFilter: { values: [params.controlValue, params.variantValue] } } },
    metrics: [{ name: 'totalUsers' }, { name: rateMetric }]
  })
  const row = (value: string) => {
    const r = report.rows?.find(x => x.dimensionValues?.[0]?.value === value)
    const visitors = Number(r?.metricValues?.[0]?.value ?? 0)
    const rate = Number(r?.metricValues?.[1]?.value ?? 0)
    return { visitors, conversions: Math.round(visitors * rate) }
  }
  const control = row(params.controlValue)
  const variant = row(params.variantValue)
  if (control.visitors === 0 && variant.visitors === 0) {
    throw new Error(`GA4 has no users for ${params.dimension} = "${params.controlValue}" / "${params.variantValue}" in this period. Check the dimension is registered and the values match exactly.`)
  }
  return { control, variant }
}
