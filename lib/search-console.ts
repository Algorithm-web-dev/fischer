import { accessToken, type GoogleClientFields } from './google'
import type { DateRange } from './ga4-audit'

/**
 * Google Search Console — which search queries bring people to a page, and
 * how well the page's listing earns the click. Used to check message match:
 * does the headline answer what people actually searched for?
 */
export interface SearchQueryRow { query: string; clicks: number; impressions: number; ctr: number; position: number }

export interface SearchConsoleData {
  siteUrl: string
  pageUrl: string | null
  range: DateRange
  totals: { clicks: number; impressions: number; ctr: number; position: number }
  queries: SearchQueryRow[]
}

export async function fetchSearchQueries(
  client: GoogleClientFields & { gsc_site_url?: string | null },
  opts: { pageUrl?: string | null; range: DateRange; limit?: number }
): Promise<SearchConsoleData> {
  if (!client.gsc_site_url) throw new Error('No Search Console site selected for this client.')
  const token = await accessToken(client)
  const filters = opts.pageUrl ? [{ filters: [{ dimension: 'page', operator: 'equals', expression: opts.pageUrl }] }] : undefined
  const post = (body: unknown) => fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(client.gsc_site_url!)}/searchAnalytics/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  const [qRes, tRes] = await Promise.all([
    post({ startDate: opts.range.startDate, endDate: opts.range.endDate, dimensions: ['query'], dimensionFilterGroups: filters, rowLimit: opts.limit ?? 25 }),
    post({ startDate: opts.range.startDate, endDate: opts.range.endDate, dimensionFilterGroups: filters, rowLimit: 1 })
  ])
  if (!qRes.ok) throw new Error(`Search Console ${qRes.status}: ${(await qRes.text()).slice(0, 200)}`)
  const q = await qRes.json()
  const t = tRes.ok ? await tRes.json() : { rows: [] }
  const r1 = (n: number) => Math.round(n * 10) / 10
  const tot = t.rows?.[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 }
  return {
    siteUrl: client.gsc_site_url, pageUrl: opts.pageUrl ?? null, range: opts.range,
    totals: { clicks: tot.clicks ?? 0, impressions: tot.impressions ?? 0, ctr: r1((tot.ctr ?? 0) * 100), position: r1(tot.position ?? 0) },
    queries: (q.rows ?? []).map((r: any) => ({ query: r.keys?.[0] ?? '', clicks: r.clicks, impressions: r.impressions, ctr: r1(r.ctr * 100), position: r1(r.position) }))
  }
}

export function formatSearchForPrompt(d: SearchConsoleData): string {
  if (!d.queries.length) return `**GOOGLE SEARCH CONSOLE:** no search queries recorded for this page in ${d.range.startDate} → ${d.range.endDate}.`
  return `**WHAT PEOPLE SEARCHED FOR (Google Search Console, ${d.range.startDate} → ${d.range.endDate}, this page):**
${d.totals.clicks.toLocaleString()} clicks from ${d.totals.impressions.toLocaleString()} impressions (CTR ${d.totals.ctr}%, average position ${d.totals.position}).
Top queries: ${d.queries.slice(0, 15).map(q => `"${q.query}" (${q.clicks} clicks, pos ${q.position})`).join('; ')}
Check message match: do the headline and first screen answer these searches? A mismatch between what people searched for and what the page leads with is a finding (evidence source: search_console).`
}
