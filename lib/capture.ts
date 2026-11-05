import type { Browser, Page } from 'puppeteer-core'
import { parseHtml, scrapePage, type ScrapedContent } from './scraper'

/**
 * Real-browser page capture — the thing Fischer audits from.
 *
 * Previously the audit was built on a plain server-side `fetch()` of the raw
 * HTML (which on any modern JS site is a near-empty shell) plus a single
 * above-the-fold screenshot. The model was effectively guessing about
 * everything below the first 900px and about anything rendered by JavaScript.
 *
 * Now, per viewport (desktop + mobile), we:
 *   1. Load the page in headless Chromium and wait for it to settle
 *   2. Dismiss cookie/consent banners so they don't cover the page
 *   3. Scroll the whole page to trigger lazy-loaded images/sections
 *   4. Capture the FULL page as a series of screenshot sections (each sized to
 *      stay sharp for the model's vision input) — not just the top 900px
 *   5. Measure what's actually visible above the fold (H1, CTAs and their
 *      size/position/colour) straight from the rendered layout
 *   6. Extract text content from the RENDERED DOM (post-JavaScript), so the
 *      content data matches what visitors and the screenshots actually see
 */

export type ViewportName = 'desktop' | 'mobile'

export const VIEWPORTS: Record<ViewportName, {
  width: number; height: number; isMobile: boolean; segmentHeight: number; maxSegments: number; userAgent: string
}> = {
  desktop: {
    width: 1440, height: 900, isMobile: false,
    segmentHeight: 1800, maxSegments: 6,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  },
  mobile: {
    width: 390, height: 844, isMobile: true,
    segmentHeight: 1700, maxSegments: 7,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  }
}

export interface ScreenshotSegment {
  index: number
  y: number            // CSS px from top of page where this section starts
  height: number
  base64: string       // no data: prefix
  mediaType?: ImageMediaType  // defaults to image/jpeg (our own captures); manual uploads may be PNG/WebP
}

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

/** Detects the real image type from the file's first bytes (manual uploads can be PNG, WebP…). */
export function detectImageType(base64: string): ImageMediaType | null {
  const head = Buffer.from(base64.slice(0, 24), 'base64')
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg'
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head.slice(0, 4).toString('ascii') === 'RIFF' && head.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (head.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  return null
}

export interface AboveFoldCta {
  text: string
  tag: string
  top: number
  left: number
  width: number
  height: number
  background: string
  color: string
  fontSize: number
}

export interface LayoutFacts {
  pageHeight: number
  viewportHeight: number
  h1AboveFold: string | null
  h1Count: number
  ctasAboveFold: AboveFoldCta[]
  ctasBelowFold: { text: string; top: number }[]
  formAboveFold: boolean
  formFieldCount: number
  hasStickyHeader: boolean
  popupsDetected: string[]
  horizontalOverflow: boolean    // mobile layout wider than the screen (sideways scrolling)
  smallTapTargets: number        // tappable elements < 40px tall (mobile usability)
  imagesBroken: number
}

export interface ViewportCapture {
  viewport: ViewportName
  ok: boolean
  error?: string
  width: number
  segments: ScreenshotSegment[]
  truncated: boolean             // page longer than we capture
  layout?: LayoutFacts
  consoleErrors: string[]
  failedRequests: number
  finalUrl?: string
  httpStatus?: number
  renderedHtml?: string
  loadTimeMs?: number
}

export interface PageCapture {
  desktop: ViewportCapture
  mobile: ViewportCapture
  content: ScrapedContent | null   // from the rendered DOM when possible, static fetch as fallback
  contentSource: 'rendered' | 'static' | 'none'
  contentError?: string
}

export async function launchBrowser(): Promise<Browser> {
  const puppeteer = (await import('puppeteer-core')).default
  const localPath = process.env.CHROME_EXECUTABLE_PATH
  if (localPath) {
    return puppeteer.launch({
      executablePath: localPath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars']
    })
  }
  const chromium = (await import('@sparticuz/chromium')).default
  return puppeteer.launch({
    args: [...chromium.args, '--hide-scrollbars'],
    executablePath: await chromium.executablePath(),
    headless: true
  })
}

export async function capturePage(
  url: string,
  viewports: ViewportName[] = ['desktop', 'mobile']
): Promise<PageCapture> {
  const empty = (v: ViewportName, error: string): ViewportCapture => ({
    viewport: v, ok: false, error, width: VIEWPORTS[v].width, segments: [], truncated: false,
    consoleErrors: [], failedRequests: 0
  })

  let browser: Browser | null = null
  const results: Partial<Record<ViewportName, ViewportCapture>> = {}

  try {
    browser = await launchBrowser()
  } catch (err) {
    const msg = `Browser failed to launch: ${err instanceof Error ? err.message : String(err)}`
    for (const v of viewports) results[v] = empty(v, msg)
  }

  if (browser) {
    // Sequential, not parallel: serverless functions have limited memory and
    // two full-page captures at once is the most common cause of crashes.
    for (const v of viewports) {
      results[v] = await captureViewport(browser, url, v).catch(err =>
        empty(v, err instanceof Error ? err.message : String(err)))
    }
    await browser.close().catch(() => {})
  }

  const desktop = results.desktop ?? empty('desktop', 'Not requested')
  const mobile = results.mobile ?? empty('mobile', 'Not requested')

  // Prefer the rendered DOM (post-JS) for text extraction.
  const rendered = desktop.renderedHtml || mobile.renderedHtml
  let content: ScrapedContent | null = null
  let contentSource: PageCapture['contentSource'] = 'none'
  let contentError: string | undefined

  if (rendered) {
    content = parseHtml(rendered, desktop.finalUrl || mobile.finalUrl || url)
    content.fetchedWithJs = false // rendered DOM — the JS-shell heuristic doesn't apply
    contentSource = 'rendered'
  } else {
    const fallback = await scrapePage(url)
    if (fallback.success) {
      content = fallback.content!
      contentSource = 'static'
    } else {
      contentError = fallback.error
    }
  }

  // The rendered HTML is large and only needed for parsing — don't carry it around.
  delete desktop.renderedHtml
  delete mobile.renderedHtml

  return { desktop, mobile, content, contentSource, contentError }
}

async function captureViewport(browser: Browser, url: string, name: ViewportName): Promise<ViewportCapture> {
  const cfg = VIEWPORTS[name]
  const page = await browser.newPage()
  const consoleErrors: string[] = []
  let failedRequests = 0

  page.on('console', msg => {
    if (msg.type() === 'error' && consoleErrors.length < 20) consoleErrors.push(msg.text().slice(0, 200))
  })
  page.on('pageerror', err => {
    if (consoleErrors.length < 20) consoleErrors.push(String((err as Error)?.message ?? err).slice(0, 200))
  })
  page.on('requestfailed', () => { failedRequests++ })

  try {
    await page.setUserAgent(cfg.userAgent)
    await page.setViewport({
      width: cfg.width, height: cfg.height, deviceScaleFactor: 1,
      isMobile: cfg.isMobile, hasTouch: cfg.isMobile
    })

    const started = Date.now()
    let httpStatus: number | undefined
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })
      httpStatus = response?.status()
    } catch (err) {
      // Sites with analytics beacons / chat widgets often never reach network idle.
      // If the document itself loaded, carry on with what rendered.
      const hasBody = await page.evaluate('document.body ? document.body.innerText.length : 0').catch(() => 0)
      if (!hasBody) throw err
    }
    const loadTimeMs = Date.now() - started

    if (httpStatus && httpStatus >= 400) {
      throw new Error(`Page returned HTTP ${httpStatus}`)
    }

    await sleep(1000)
    await dismissOverlays(page)
    await autoScroll(page, cfg.segmentHeight * cfg.maxSegments)
    await page.evaluate('window.scrollTo(0, 0)')
    await sleep(800)

    // Layout facts measured from the real render, at the top of the page.
    const layout = (await page.evaluate(LAYOUT_SCRIPT)) as LayoutFacts

    const pageHeight = Math.max(layout.pageHeight, cfg.height)
    const maxHeight = cfg.segmentHeight * cfg.maxSegments
    const captureHeight = Math.min(pageHeight, maxHeight)

    const segments: ScreenshotSegment[] = []
    for (let y = 0, i = 0; y < captureHeight; y += cfg.segmentHeight, i++) {
      const h = Math.min(cfg.segmentHeight, captureHeight - y)
      if (h < 200 && i > 0) break // a sliver of footer isn't worth an image
      const buf = await page.screenshot({
        type: 'jpeg', quality: 72,
        clip: { x: 0, y, width: cfg.width, height: h },
        captureBeyondViewport: true
      })
      segments.push({ index: i, y, height: h, base64: Buffer.from(buf).toString('base64') })
    }

    const renderedHtml = await page.content()

    return {
      viewport: name, ok: segments.length > 0, width: cfg.width, segments,
      truncated: pageHeight > maxHeight, layout, consoleErrors, failedRequests,
      finalUrl: page.url(), httpStatus, renderedHtml, loadTimeMs
    }
  } finally {
    await page.close().catch(() => {})
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function autoScroll(page: Page, maxPx: number) {
  // Scroll in viewport-sized steps so IntersectionObserver-based lazy loading fires.
  await page.evaluate(`(async () => {
    const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
    const limit = ${maxPx};
    for (let y = 0; y < Math.min(document.documentElement.scrollHeight, limit); y += step) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 150));
    }
    window.scrollTo(0, Math.min(document.documentElement.scrollHeight, limit));
    await new Promise(r => setTimeout(r, 400));
  })()`)
}

/**
 * Clicks "accept"-style buttons on consent banners (OneTrust, Cookiebot,
 * generic). We record that a banner existed (it IS part of the visitor's first
 * impression) but remove it so it doesn't hide the page in every screenshot.
 */
async function dismissOverlays(page: Page) {
  await page.evaluate(`(() => {
    const selectors = ['#onetrust-accept-btn-handler', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      '#CybotCookiebotDialogBodyButtonAccept', '.cc-allow', '.cookie-accept', '[data-testid="cookie-accept"]',
      'button[aria-label*="accept" i]', 'button[aria-label*="agree" i]'];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) { el.click(); window.__fischerConsent = s; return; }
    }
    const words = ['accept all', 'accept cookies', 'allow all', 'i agree', 'agree', 'accept', 'got it', 'ok, got it', 'allow cookies'];
    const candidates = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"]'));
    for (const el of candidates) {
      const t = (el.innerText || '').trim().toLowerCase();
      if (t && t.length < 30 && words.includes(t) && el.offsetParent !== null) {
        el.click(); window.__fischerConsent = t; return;
      }
    }
  })()`).catch(() => {})
  await sleep(600)
}

// Kept as a string: functions passed to page.evaluate get transpiled by the
// bundler and can reference helpers that don't exist inside the browser.
const LAYOUT_SCRIPT = `(() => {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const absTop = (el) => el.getBoundingClientRect().top + window.scrollY;
  const textOf = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');

  const h1s = Array.from(document.querySelectorAll('h1')).filter(visible);
  const h1Above = h1s.find(h => absTop(h) < vh);

  const ctaWords = /(buy|shop|add to (cart|bag)|book|sign ?up|get started|start|subscribe|download|request|contact|call|enquire|inquire|apply|order|quote|demo|trial|join|register|reserve|claim|get|try|learn more|find out|view|see|explore|checkout|continue)/i;
  const clickable = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]'))
    .filter(visible);

  const isButtonLike = (el) => {
    const s = getComputedStyle(el);
    const bg = s.backgroundColor;
    const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    const hasBorder = parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none';
    const r = el.getBoundingClientRect();
    return el.tagName === 'BUTTON' || el.tagName === 'INPUT' || ((hasBg || hasBorder) && r.height >= 28 && r.width >= 60);
  };
  const inNav = (el) => !!el.closest('nav, header, footer, [role="navigation"]');

  const ctas = clickable.filter(el => {
    const t = textOf(el);
    return t && t.length <= 50 && (isButtonLike(el) || (!inNav(el) && ctaWords.test(t)));
  });

  const ctasAbove = ctas.filter(el => absTop(el) < vh).slice(0, 15).map(el => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return { text: textOf(el), tag: el.tagName.toLowerCase(), top: Math.round(absTop(el)), left: Math.round(r.left),
      width: Math.round(r.width), height: Math.round(r.height), background: s.backgroundColor, color: s.color,
      fontSize: Math.round(parseFloat(s.fontSize)) };
  });
  const ctasBelow = ctas.filter(el => absTop(el) >= vh).slice(0, 25).map(el => ({ text: textOf(el), top: Math.round(absTop(el)) }));

  const forms = Array.from(document.querySelectorAll('form')).filter(visible);
  const formAbove = forms.some(f => absTop(f) < vh);
  const fieldCount = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')).filter(visible).length;

  const header = document.querySelector('header, [role="banner"], nav');
  const hs = header ? getComputedStyle(header) : null;
  const sticky = !!hs && (hs.position === 'fixed' || hs.position === 'sticky');

  const popups = [];
  if (window.__fischerConsent) popups.push('Cookie/consent banner (auto-dismissed for screenshots): ' + window.__fischerConsent);
  Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal, .popup')).filter(visible).slice(0, 3)
    .forEach(el => popups.push('Dialog still visible: ' + textOf(el).slice(0, 80)));

  const small = vw < 600 ? clickable.filter(el => { const r = el.getBoundingClientRect(); return r.height > 0 && r.height < 40 && !inNav(el); }).length : 0;
  const broken = Array.from(document.images).filter(img => img.complete && img.naturalWidth === 0 && img.src).length;

  return {
    pageHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    viewportHeight: vh,
    h1AboveFold: h1Above ? textOf(h1Above).slice(0, 200) : null,
    h1Count: h1s.length,
    ctasAboveFold: ctasAbove,
    ctasBelowFold: ctasBelow,
    formAboveFold: formAbove,
    formFieldCount: fieldCount,
    hasStickyHeader: sticky,
    popupsDetected: popups,
    horizontalOverflow: document.documentElement.scrollWidth > vw + 4,
    smallTapTargets: small,
    imagesBroken: broken
  };
})()`
