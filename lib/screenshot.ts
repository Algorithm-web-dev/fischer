import chromium from '@sparticuz/chromium'
import puppeteer, { Browser } from 'puppeteer-core'

export interface ViewportShot {
  viewport: 'desktop' | 'mobile'
  width: number
  height: number
  base64: string // no data: prefix — ready to drop into an Anthropic image content block
  mediaType?: string // set for manual uploads; auto-captures are always JPEG
}

export interface ScreenshotResult {
  success: boolean       // true if at least one viewport succeeded
  shots: ViewportShot[]
  errors: Partial<Record<'desktop' | 'mobile', string>>  // per-viewport failure reasons
}

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 375, height: 812 } // iPhone 13-ish — matches the most common mobile CVR baseline
}

/**
 * Captures above-the-fold screenshots at both desktop and mobile viewports.
 * This is what lets Fischer actually SEE the page — visual hierarchy, CTA
 * prominence, clutter, contrast — none of which text/DOM extraction can judge.
 *
 * Each viewport is attempted independently — a failure on mobile (e.g. a
 * mobile-specific redirect or block) doesn't take down the desktop capture,
 * and the caller can request manual upload for just the viewport that failed.
 *
 * Runs entirely inside this Vercel function via a serverless-trimmed Chromium
 * binary. No external screenshot service, no separate crawler infrastructure.
 */
export async function captureScreenshots(
  url: string,
  viewports: (keyof typeof VIEWPORTS)[] = ['desktop', 'mobile']
): Promise<ScreenshotResult> {
  let browser: Browser | null = null
  const shots: ViewportShot[] = []
  const errors: Partial<Record<'desktop' | 'mobile', string>> = {}

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: null,
      executablePath: await chromium.executablePath(),
      headless: true
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Chromium failed to launch'
    const failed: Partial<Record<'desktop' | 'mobile', string>> = {}
    for (const v of viewports) failed[v] = msg
    return { success: false, shots: [], errors: failed }
  }

  for (const name of viewports) {
    const size = VIEWPORTS[name]
    try {
      const page = await browser.newPage()
      await page.setViewport(size)

      // Slightly more forgiving UA than the default headless string — some
      // sites serve different (or blocked) content to obvious bot agents.
      await page.setUserAgent(
        name === 'mobile'
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      )

      await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 })

      // Give lazy-loaded hero content / web fonts a moment to settle —
      // above-the-fold screenshots are worthless if the hero is still blank.
      await new Promise(resolve => setTimeout(resolve, 1200))

      const buffer = await page.screenshot({ type: 'jpeg', quality: 80 }) // above-the-fold only, not full page
      await page.close()

      shots.push({
        viewport: name,
        width: size.width,
        height: size.height,
        base64: Buffer.from(buffer).toString('base64')
      })
    } catch (err) {
      errors[name] = err instanceof Error ? err.message : `${name} screenshot failed`
    }
  }

  await browser.close()

  return { success: shots.length > 0, shots, errors }
}
