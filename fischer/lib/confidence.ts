import type { ScrapeResult } from './scraper'
import type { ScreenshotResult } from './screenshot'

export interface ConfidenceCheck {
  htmlOk: boolean
  desktopOk: boolean
  mobileOk: boolean
  reasons: {
    html?: string
    desktop?: string
    mobile?: string
  }
}

// Below this word count, treat the scrape as too thin to audit reliably —
// same threshold the scraper itself uses to flag likely JS-rendering gaps.
const MIN_RELIABLE_WORD_COUNT = 50

/**
 * Decides whether auto-capture actually got what Fischer needs, per piece
 * (HTML content, desktop screenshot, mobile screenshot) — not just pass/fail
 * on the whole audit. This is what lets the frontend ask for manual input on
 * ONLY the piece that failed, instead of an all-or-nothing manual mode.
 */
export function assessConfidence(
  scrapeResult: ScrapeResult,
  screenshotResult: ScreenshotResult
): ConfidenceCheck {
  const reasons: ConfidenceCheck['reasons'] = {}

  let htmlOk = true
  if (!scrapeResult.success) {
    htmlOk = false
    reasons.html = scrapeResult.error || 'Could not fetch the page.'
  } else if (scrapeResult.content!.fetchedWithJs) {
    htmlOk = false
    reasons.html = 'Page appears to be JS-rendered — auto-fetch likely missed content that loads after the initial page load.'
  } else if (scrapeResult.content!.wordCount < MIN_RELIABLE_WORD_COUNT) {
    htmlOk = false
    reasons.html = `Only ${scrapeResult.content!.wordCount} words extracted — too thin to audit reliably.`
  }

  const desktopOk = screenshotResult.shots.some(s => s.viewport === 'desktop')
  if (!desktopOk) {
    reasons.desktop = screenshotResult.errors.desktop || 'Desktop screenshot capture failed.'
  }

  const mobileOk = screenshotResult.shots.some(s => s.viewport === 'mobile')
  if (!mobileOk) {
    reasons.mobile = screenshotResult.errors.mobile || 'Mobile screenshot capture failed.'
  }

  return { htmlOk, desktopOk, mobileOk, reasons }
}

/** True if every piece auto-capture needed is actually usable — no manual input required. */
export function isFullyConfident(check: ConfidenceCheck): boolean {
  return check.htmlOk && check.desktopOk && check.mobileOk
}
