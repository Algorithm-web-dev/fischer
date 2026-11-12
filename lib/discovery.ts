import * as cheerio from 'cheerio'
import { isValidHttpUrl } from './validate'

/**
 * Site discovery: reads the client's sitemap (via robots.txt or the usual
 * locations, falling back to homepage links), finds the pages that matter for
 * conversion — forms, quote/booking/contact pages, product/cart/checkout,
 * pricing, sign-up — and checks for broken pages. Only URLs on the client's
 * own host are fetched.
 */
export type PageKind = 'lead_form' | 'quote' | 'booking' | 'checkout' | 'cart' | 'product' | 'category' | 'pricing' | 'signup' | 'home' | 'landing' | 'content' | 'other'

const RULES: [PageKind, RegExp][] = [
  ['checkout', /\/(checkout|payment|pay)(\.\w+)?(\/|$)/i],
  ['cart', /\/(cart|basket|bag|trolley)(\.\w+)?(\/|$)/i],
  ['quote', /(quote|estimate|pricing-request|get-a-price)/i],
  ['booking', /(book|booking|appointment|schedule|reserve|test-?drive)/i],
  ['lead_form', /(contact|enquir|inquir|get-in-touch|request|apply|application|callback|lead)/i],
  ['signup', /(sign-?up|register|join|trial|demo)/i],
  ['pricing', /(pricing|prices|plans|packages|rates)/i],
  ['product', /\/(product|products|p|item|shop\/[^/]+\/[^/]+)\/[^/]+/i],
  ['category', /\/(category|categories|collections?|shop|range|models?)(\/|$)/i],
  ['landing', /\/(lp|landing|offer|promo|campaign|special)s?(\/|$|-)/i],
  ['content', /\/(blog|news|articles?|insights|resources|press|careers|jobs|privacy|terms|legal|cookie)/i]
]

/** Pure — unit tested. */
export function classifyUrl(url: string): PageKind {
  let path: string
  try { path = new URL(url).pathname } catch { return 'other' }
  if (path === '/' || path === '') return 'home'
  for (const [kind, re] of RULES) if (re.test(path)) return kind
  return 'other'
}

/** Pure — unit tested. Extracts <loc> URLs from a sitemap or sitemap index. */
export function parseSitemapLocs(xml: string): string[] {
  return Array.from(xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)).map(m => m[1].replace(/&amp;/g, '&'))
}

const PRIORITY: PageKind[] = ['checkout', 'cart', 'quote', 'booking', 'lead_form', 'signup', 'pricing', 'landing', 'product', 'category', 'home']

export interface DiscoveredPage { url: string; kind: PageKind; status: number | null; hasForm: boolean; formFields: number; title: string | null }
export interface DiscoveryResult {
  origin: string
  source: 'sitemap' | 'links'
  urlsFound: number
  byKind: Record<string, number>
  pages: DiscoveredPage[]       // the conversion-relevant pages, checked
  broken: { url: string; status: number | null }[]
  checked: number
  scannedAt: string
}

const UA = 'Mozilla/5.0 (compatible; FischerBot/1.0; +conversion audit)'

async function get(url: string, timeoutMs = 10000): Promise<{ status: number | null; text: string }> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: controller.signal })
    const text = res.ok ? (await res.text()).slice(0, 3_000_000) : ''
    return { status: res.status, text }
  } catch { return { status: null, text: '' } } finally { clearTimeout(t) }
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]) } }))
  return out
}

export async function discoverSite(primaryUrl: string, opts: { maxCheck?: number } = {}): Promise<DiscoveryResult> {
  if (!isValidHttpUrl(primaryUrl)) throw new Error('The client website must be a public http(s) URL.')
  const origin = new URL(primaryUrl).origin
  const host = new URL(primaryUrl).hostname.replace(/^www\./, '')
  const sameHost = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '') === host && isValidHttpUrl(u) } catch { return false } }

  // 1. Sitemaps
  const robots = await get(`${origin}/robots.txt`, 8000)
  const sitemapUrls = Array.from(robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)).map(m => m[1]).filter(sameHost)
  if (!sitemapUrls.length) sitemapUrls.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`)
  const urls = new Set<string>()
  const queue = [...sitemapUrls]
  let fetched = 0
  while (queue.length && fetched < 15 && urls.size < 3000) {
    const sm = queue.shift()!
    fetched++
    const r = await get(sm)
    if (!r.text) continue
    for (const loc of parseSitemapLocs(r.text)) {
      if (!sameHost(loc)) continue
      if (/\.xml(\.gz)?(\?|$)/i.test(loc)) { if (!/\.gz/i.test(loc)) queue.push(loc) }
      else urls.add(loc.split('#')[0])
    }
  }
  let source: DiscoveryResult['source'] = 'sitemap'

  // 2. Fallback: homepage links
  if (urls.size === 0) {
    source = 'links'
    const home = await get(origin)
    const $ = cheerio.load(home.text)
    $('a[href]').each((_, a) => {
      try { const u = new URL($(a).attr('href')!, origin).toString().split('#')[0]; if (sameHost(u)) urls.add(u) } catch { /* skip */ }
    })
    urls.add(origin + '/')
  }

  const all = Array.from(urls)
  const byKind: Record<string, number> = {}
  for (const u of all) { const k = classifyUrl(u); byKind[k] = (byKind[k] ?? 0) + 1 }

  // 3. Pick conversion-relevant pages (a few of each kind, high-intent first) and check them
  const maxCheck = opts.maxCheck ?? 40
  const picked: string[] = []
  for (const kind of PRIORITY) {
    const ofKind = all.filter(u => classifyUrl(u) === kind)
    picked.push(...ofKind.slice(0, kind === 'product' || kind === 'category' ? 3 : 6))
  }
  if (!picked.some(u => classifyUrl(u) === 'home')) picked.unshift(origin + '/')
  const toCheck = Array.from(new Set(picked)).slice(0, maxCheck)
  // plus a sample of everything else for broken-page detection
  const sample = all.filter(u => !toCheck.includes(u)).filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 30)) === 0).slice(0, 30)

  const pages = await pool(toCheck, 6, async (url): Promise<DiscoveredPage> => {
    const r = await get(url)
    let hasForm = false, formFields = 0, title: string | null = null
    if (r.text) {
      const $ = cheerio.load(r.text)
      title = $('title').first().text().trim().slice(0, 120) || null
      $('form').each((_, f) => {
        const n = $(f).find('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea').length
        if (n >= 2 && !/search/i.test($(f).attr('role') ?? '') && !/search/i.test($(f).attr('action') ?? '')) { hasForm = true; formFields = Math.max(formFields, n) }
      })
    }
    return { url, kind: classifyUrl(url), status: r.status, hasForm, formFields, title }
  })
  const sampled = await pool(sample, 6, async url => ({ url, status: (await get(url, 8000)).status }))
  const broken = [...pages.map(p => ({ url: p.url, status: p.status })), ...sampled].filter(p => p.status == null || p.status >= 400)

  return { origin, source, urlsFound: all.length, byKind, pages, broken, checked: pages.length + sampled.length, scannedAt: new Date().toISOString() }
}
