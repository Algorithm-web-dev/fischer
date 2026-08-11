import * as cheerio from 'cheerio'

/**
 * What Fischer actually needs to see to audit a page properly — not a search
 * snippet, the real rendered-server content: headings, CTAs, forms, trust
 * signals, and enough body copy to judge clarity and friction.
 */
export interface ScrapedContent {
  url: string
  title: string
  metaDescription: string
  headings: { level: string; text: string }[]
  ctaButtons: string[]        // text of <button>, <a class*="btn">, input[type=submit], etc.
  forms: {
    fieldCount: number
    fieldLabels: string[]
    submitText: string
  }[]
  trustSignals: string[]      // text near words like "guarantee", "secure", "reviews", testimonials
  bodyTextSample: string      // first ~3000 chars of visible text, for general tone/clarity read
  wordCount: number
  imageCount: number
  hasVideoEmbed: boolean
  fetchedWithJs: boolean       // false = static HTML only; flags JS-heavy SPA risk (see caveats)
}

export interface ScrapeResult {
  success: boolean
  content?: ScrapedContent
  error?: string
}

const CTA_KEYWORDS = ['buy', 'shop', 'add to cart', 'book', 'sign up', 'signup', 'get started',
  'subscribe', 'download', 'request', 'contact', 'call', 'enquire', 'inquire', 'apply',
  'submit', 'order', 'quote', 'demo', 'trial', 'learn more']

const TRUST_KEYWORDS = ['guarantee', 'secure', 'ssl', 'certified', 'accredited', 'review',
  'testimonial', 'rated', 'trusted by', 'as seen', 'award', 'verified', 'money back']

export async function scrapePage(url: string): Promise<ScrapeResult> {
  let res: Response
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    res = await fetch(url, {
      headers: {
        // Identify as a real browser — many sites block unlabelled server-side fetches
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow'
    })
    clearTimeout(timeout)
  } catch (err) {
    return {
      success: false,
      error: `Could not reach ${url}: ${err instanceof Error ? err.message : 'unknown error'}`
    }
  }

  if (!res.ok) {
    return { success: false, error: `${url} returned HTTP ${res.status}` }
  }

  const html = await res.text()
  return { success: true, content: parseHtml(html, url) }
}

/**
 * The actual extraction logic — pulled out of scrapePage so it can also run
 * on manually-pasted HTML (e.g. copied from browser DevTools after the page
 * has fully rendered its JavaScript). This is genuinely more reliable than
 * our own server-side fetch for JS-heavy SPAs or anything gated behind login,
 * since DevTools captures the DOM as the browser actually rendered it.
 */
export function parseHtml(html: string, url: string): ScrapedContent {
  const $ = cheerio.load(html)

  // Strip non-visible content before extracting text
  $('script, style, noscript, svg').remove()

  const title = $('title').first().text().trim()
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() || ''

  const headings: { level: string; text: string }[] = []
  $('h1, h2, h3').each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ')
    if (text) headings.push({ level: el.tagName.toLowerCase(), text })
  })

  const ctaButtons: string[] = []
  $('button, a, input[type="submit"], input[type="button"]').each((_, el) => {
    const text = ($(el).text() || $(el).attr('value') || '').trim().replace(/\s+/g, ' ')
    if (!text || text.length > 60) return
    const lower = text.toLowerCase()
    if (CTA_KEYWORDS.some(kw => lower.includes(kw))) {
      ctaButtons.push(text)
    }
  })

  const forms: ScrapedContent['forms'] = []
  $('form').each((_, formEl) => {
    const fieldLabels: string[] = []
    $(formEl).find('input, select, textarea').each((_, fieldEl) => {
      const type = $(fieldEl).attr('type') || 'text'
      if (['submit', 'button', 'hidden'].includes(type)) return
      const label = $(fieldEl).attr('placeholder')
        || $(fieldEl).attr('aria-label')
        || $(fieldEl).attr('name')
        || type
      fieldLabels.push(label)
    })
    const submitEl = $(formEl).find('button[type="submit"], input[type="submit"]').first()
    const submitText = (submitEl.text() || submitEl.attr('value') || 'Submit').trim()
    if (fieldLabels.length > 0) {
      forms.push({ fieldCount: fieldLabels.length, fieldLabels, submitText })
    }
  })

  const trustSignals: string[] = []
  $('body').find('*').each((_, el) => {
    if (trustSignals.length >= 15) return
    const text = $(el).clone().children().remove().end().text().trim()
    if (!text || text.length > 150) return
    const lower = text.toLowerCase()
    if (TRUST_KEYWORDS.some(kw => lower.includes(kw))) {
      trustSignals.push(text.replace(/\s+/g, ' '))
    }
  })

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim()
  const wordCount = bodyText.split(' ').filter(Boolean).length
  const imageCount = $('img').length
  const hasVideoEmbed = $('video, iframe[src*="youtube"], iframe[src*="vimeo"]').length > 0

  // Heuristic: if body text is suspiciously short relative to page size, it's likely
  // a JS-rendered SPA that returns an empty shell over plain fetch. Flag it so the
  // caller (and the audit prompt) can lower confidence rather than silently guessing.
  // Note: this heuristic is far less relevant for manually-pasted DevTools HTML,
  // since that's already post-render — see isManualPaste note in callers.
  const fetchedWithJs = wordCount < 50 && html.length > 5000

  return {
    url,
    title,
    metaDescription,
    headings: headings.slice(0, 30),
    ctaButtons: Array.from(new Set(ctaButtons)).slice(0, 20),
    forms,
    trustSignals: Array.from(new Set(trustSignals)),
    bodyTextSample: bodyText.slice(0, 3000),
    wordCount,
    imageCount,
    hasVideoEmbed,
    fetchedWithJs
  }
}
