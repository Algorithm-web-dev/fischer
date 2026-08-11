import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessConfidence, isFullyConfident } from '../lib/confidence'
import type { ScrapeResult } from '../lib/scraper'
import type { ScreenshotResult } from '../lib/screenshot'

function goodScrape(): ScrapeResult {
  return {
    success: true,
    content: {
      url: 'https://example.com', title: 'Test', metaDescription: '',
      headings: [], ctaButtons: [], forms: [], trustSignals: [],
      bodyTextSample: 'a'.repeat(500), wordCount: 300, imageCount: 0,
      hasVideoEmbed: false, fetchedWithJs: false
    }
  }
}

function goodScreenshots(): ScreenshotResult {
  return {
    success: true,
    shots: [
      { viewport: 'desktop', width: 1440, height: 900, base64: 'abc' },
      { viewport: 'mobile', width: 375, height: 812, base64: 'def' }
    ],
    errors: {}
  }
}

test('fully confident when scrape is rich and both screenshots succeed', () => {
  const confidence = assessConfidence(goodScrape(), goodScreenshots())
  assert.equal(isFullyConfident(confidence), true)
})

test('flags low confidence when scrape fails outright', () => {
  const failedScrape: ScrapeResult = { success: false, error: 'HTTP 403' }
  const confidence = assessConfidence(failedScrape, goodScreenshots())
  assert.equal(confidence.htmlOk, false)
  assert.equal(isFullyConfident(confidence), false)
  assert.match(confidence.reasons.html!, /403/)
})

test('flags low confidence when scrape succeeds but content is thin', () => {
  const thinScrape = goodScrape()
  thinScrape.content!.wordCount = 10
  const confidence = assessConfidence(thinScrape, goodScreenshots())
  assert.equal(confidence.htmlOk, false)
  assert.match(confidence.reasons.html!, /10 words/)
})

test('flags low confidence when scraper detects likely JS-rendered content', () => {
  const jsScrape = goodScrape()
  jsScrape.content!.fetchedWithJs = true
  const confidence = assessConfidence(jsScrape, goodScreenshots())
  assert.equal(confidence.htmlOk, false)
  assert.match(confidence.reasons.html!, /JS-rendered/)
})

test('desktop and mobile screenshot confidence are independent', () => {
  const partialShots: ScreenshotResult = {
    success: true,
    shots: [{ viewport: 'desktop', width: 1440, height: 900, base64: 'abc' }],
    errors: { mobile: 'Navigation timeout' }
  }
  const confidence = assessConfidence(goodScrape(), partialShots)
  assert.equal(confidence.desktopOk, true, 'desktop succeeded and should be independently OK')
  assert.equal(confidence.mobileOk, false, 'mobile failed and should be independently flagged')
  assert.equal(confidence.reasons.mobile, 'Navigation timeout')
  assert.equal(isFullyConfident(confidence), false)
})

test('a single missing piece is enough to fail isFullyConfident even if everything else is fine', () => {
  const partialShots: ScreenshotResult = {
    success: true,
    shots: [{ viewport: 'desktop', width: 1440, height: 900, base64: 'abc' }],
    errors: { mobile: 'blocked' }
  }
  const confidence = assessConfidence(goodScrape(), partialShots)
  assert.equal(confidence.htmlOk, true)
  assert.equal(confidence.desktopOk, true)
  assert.equal(confidence.mobileOk, false)
  assert.equal(isFullyConfident(confidence), false, 'one missing piece must fail the overall gate')
})
