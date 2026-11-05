import { accessToken, adsVersion, type GoogleClientFields } from './google'
import type { DateRange } from './ga4-audit'

/**
 * Google Ads spend per landing page (landing_page_view), so the leak map can
 * say "R18,400 of ad spend went to a page converting at 0.6%" instead of only
 * "paid traffic converts below average".
 *
 * Needs a Google connection with Ads access, GOOGLE_ADS_DEVELOPER_TOKEN, and
 * the client's Ads customer id (and the manager/MCC id when accessed through
 * one). GOOGLE_ADS_API_VERSION overrides the API version.
 */
export interface AdsLandingPageRow { path: string; url: string; costMicros: number; cost: number; clicks: number; conversions: number }

export async function fetchAdsLandingPages(
  client: GoogleClientFields & { google_ads_customer_id?: string | null; google_ads_login_customer_id?: string | null },
  range: DateRange
): Promise<AdsLandingPageRow[]> {
  const dev = process.env.GOOGLE_ADS_DEVELOPER_TOKEN
  if (!dev) throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN is not set.')
  if (!client.google_ads_customer_id) throw new Error('No Google Ads account selected for this client.')
  const cid = client.google_ads_customer_id.replace(/-/g, '')
  const token = await accessToken(client)
  const query = `SELECT landing_page_view.unexpanded_final_url, metrics.cost_micros, metrics.clicks, metrics.conversions
    FROM landing_page_view WHERE segments.date BETWEEN '${range.startDate}' AND '${range.endDate}'`
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'developer-token': dev, 'Content-Type': 'application/json' }
  if (client.google_ads_login_customer_id) headers['login-customer-id'] = client.google_ads_login_customer_id.replace(/-/g, '')
  const res = await fetch(`https://googleads.googleapis.com/${adsVersion()}/customers/${cid}/googleAds:searchStream`, {
    method: 'POST', headers, body: JSON.stringify({ query })
  })
  if (!res.ok) throw new Error(`Google Ads ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const chunks = await res.json()
  return aggregateAdsRows((Array.isArray(chunks) ? chunks : [chunks]).flatMap((c: any) => c.results ?? []))
}

/** Pure — unit tested. Merges rows by landing path (query strings/trailing slashes ignored). */
export function aggregateAdsRows(results: any[]): AdsLandingPageRow[] {
  const map = new Map<string, AdsLandingPageRow>()
  for (const r of results) {
    const url = r.landingPageView?.unexpandedFinalUrl ?? ''
    let path: string
    try { path = new URL(url).pathname } catch { continue }
    path = path.length > 1 ? path.replace(/\/+$/, '') : path
    const e = map.get(path) ?? { path, url, costMicros: 0, cost: 0, clicks: 0, conversions: 0 }
    e.costMicros += Number(r.metrics?.costMicros ?? 0)
    e.clicks += Number(r.metrics?.clicks ?? 0)
    e.conversions += Number(r.metrics?.conversions ?? 0)
    e.cost = Math.round(e.costMicros / 1_000_000)
    map.set(path, e)
  }
  return Array.from(map.values()).sort((a, b) => b.costMicros - a.costMicros)
}
