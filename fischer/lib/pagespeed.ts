export interface PageSpeedResult {
  success: boolean
  strategy: 'mobile' | 'desktop'
  performanceScore?: number     // 0-100, Lighthouse lab score
  lcp?: { value: number; category: 'FAST' | 'AVERAGE' | 'SLOW' }
  inp?: { value: number; category: 'FAST' | 'AVERAGE' | 'SLOW' }
  cls?: { value: number; category: 'FAST' | 'AVERAGE' | 'SLOW' }
  fcp?: { value: number; category: 'FAST' | 'AVERAGE' | 'SLOW' }
  ttfb?: { value: number; category: 'FAST' | 'AVERAGE' | 'SLOW' }
  fieldDataAvailable: boolean    // true if real-user CrUX data existed (vs lab-only)
  error?: string
}

/**
 * Google's PageSpeed Insights API — free, 25,000 queries/day, no infrastructure
 * to run. A slow page can be the single biggest conversion killer and neither
 * the scraper nor the screenshots can see it — this is the third, independent
 * data source Fischer needed. Runs mobile and desktop as separate calls, per
 * Google's own recommendation (results genuinely differ enough to matter).
 */
export async function fetchPageSpeed(
  url: string,
  strategy: 'mobile' | 'desktop'
): Promise<PageSpeedResult> {
  const apiKey = process.env.GOOGLE_PAGESPEED_API_KEY
  if (!apiKey) {
    return { success: false, strategy, fieldDataAvailable: false, error: 'GOOGLE_PAGESPEED_API_KEY not configured.' }
  }

  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&key=${apiKey}&category=performance`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 25000) // PSI can be slow, especially cold

    const res = await fetch(endpoint, { signal: controller.signal })
    clearTimeout(timeout)

    if (!res.ok) {
      const body = await res.text()
      return { success: false, strategy, fieldDataAvailable: false, error: `PageSpeed API returned ${res.status}: ${body.slice(0, 200)}` }
    }

    const data = await res.json()

    const audits = data.lighthouseResult?.audits
    const performanceScore = data.lighthouseResult?.categories?.performance?.score
    const fieldMetrics = data.loadingExperience?.metrics

    return {
      success: true,
      strategy,
      performanceScore: performanceScore != null ? Math.round(performanceScore * 100) : undefined,
      lcp: extractMetric(fieldMetrics?.LARGEST_CONTENTFUL_PAINT_MS, audits?.['largest-contentful-paint']),
      inp: extractMetric(fieldMetrics?.INTERACTION_TO_NEXT_PAINT, audits?.['interaction-to-next-paint']),
      cls: extractMetric(fieldMetrics?.CUMULATIVE_LAYOUT_SHIFT_SCORE, audits?.['cumulative-layout-shift']),
      fcp: extractMetric(fieldMetrics?.FIRST_CONTENTFUL_PAINT_MS, audits?.['first-contentful-paint']),
      ttfb: extractMetric(undefined, audits?.['server-response-time']),
      fieldDataAvailable: !!fieldMetrics
    }
  } catch (err) {
    return {
      success: false,
      strategy,
      fieldDataAvailable: false,
      error: err instanceof Error ? err.message : 'Unknown PageSpeed error'
    }
  }
}

export async function fetchPageSpeedBoth(url: string): Promise<{ mobile: PageSpeedResult; desktop: PageSpeedResult }> {
  const [mobile, desktop] = await Promise.all([
    fetchPageSpeed(url, 'mobile'),
    fetchPageSpeed(url, 'desktop')
  ])
  return { mobile, desktop }
}

function extractMetric(
  fieldMetric: { category?: string; percentile?: number } | undefined,
  labAudit: { numericValue?: number } | undefined
): { value: number; category: 'FAST' | 'AVERAGE' | 'SLOW' } | undefined {
  if (fieldMetric?.percentile != null) {
    return {
      value: fieldMetric.percentile,
      category: (fieldMetric.category as 'FAST' | 'AVERAGE' | 'SLOW') || 'AVERAGE'
    }
  }
  if (labAudit?.numericValue != null) {
    // No field (CrUX) data — fall back to lab data, no category classification available
    return { value: Math.round(labAudit.numericValue), category: 'AVERAGE' }
  }
  return undefined
}
