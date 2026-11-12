import type { PageCapture, ViewportCapture } from './capture'

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

const MIN_RELIABLE_WORD_COUNT = 50

// Bot-protection / error interstitials. If we screenshot one of these we'd be
// auditing Cloudflare's challenge page, not the client's site.
const BLOCK_PATTERNS = [
  /just a moment/i, /attention required/i, /access denied/i, /verify you are human/i,
  /checking your browser/i, /request blocked/i, /are you a robot/i, /captcha/i,
  /403 forbidden/i, /service unavailable/i, /page not found/i, /^404\b/i
]

export function looksBlocked(title: string | undefined, h1: string | null | undefined, wordCount: number): string | null {
  const probe = `${title ?? ''} | ${h1 ?? ''}`
  const hit = BLOCK_PATTERNS.find(p => p.test(probe))
  if (hit && wordCount < 400) return `The page served a bot-protection or error screen ("${(title || h1 || '').slice(0, 60)}") instead of the real content.`
  return null
}

function viewportReason(v: ViewportCapture, blocked: string | null): string | undefined {
  if (!v.ok || v.segments.length === 0) return v.error || `${v.viewport} screenshot capture failed.`
  if (blocked) return blocked
  return undefined
}

/**
 * Decides, per piece, whether auto-capture got what Fischer needs. Only the
 * pieces that failed are requested from the user as manual input.
 *
 * Text is only required when it couldn't be extracted AND we have no
 * screenshots to read it from — an image-heavy page with few words is a
 * legitimate page, not a failed capture.
 */
export function assessConfidence(capture: PageCapture): ConfidenceCheck {
  const reasons: ConfidenceCheck['reasons'] = {}
  const content = capture.content
  const blocked = looksBlocked(content?.title, capture.desktop.layout?.h1AboveFold ?? null, content?.wordCount ?? 0)

  const desktopReason = viewportReason(capture.desktop, blocked)
  const mobileReason = viewportReason(capture.mobile, blocked)
  if (desktopReason) reasons.desktop = desktopReason
  if (mobileReason) reasons.mobile = mobileReason

  let htmlOk = true
  if (blocked) {
    htmlOk = false
    reasons.html = blocked
  } else if (!content) {
    htmlOk = false
    reasons.html = capture.contentError || 'Could not extract page text.'
  } else if (content.fetchedWithJs && desktopReason) {
    htmlOk = false
    reasons.html = 'Page appears to be JavaScript-rendered and the browser capture failed, so the text is incomplete.'
  } else if (content.wordCount < MIN_RELIABLE_WORD_COUNT && desktopReason) {
    htmlOk = false
    reasons.html = `Only ${content.wordCount} words extracted and no screenshots to read from.`
  }

  return { htmlOk, desktopOk: !desktopReason, mobileOk: !mobileReason, reasons }
}

export function isFullyConfident(check: ConfidenceCheck): boolean {
  return check.htmlOk && check.desktopOk && check.mobileOk
}
