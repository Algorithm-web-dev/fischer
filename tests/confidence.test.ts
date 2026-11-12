import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessConfidence, isFullyConfident, looksBlocked } from '../lib/confidence'
import type { PageCapture, ViewportCapture } from '../lib/capture'
import type { ScrapedContent } from '../lib/scraper'

function content(over: Partial<ScrapedContent> = {}): ScrapedContent {
  return {
    url: 'https://example.com', title: 'Acme Solar', metaDescription: '', headings: [], ctaButtons: [], forms: [],
    trustSignals: [], bodyTextSample: 'a', wordCount: 300, imageCount: 0, hasVideoEmbed: false, fetchedWithJs: false, ...over
  }
}
function vp(name: 'desktop' | 'mobile', ok = true, error?: string): ViewportCapture {
  return {
    viewport: name, ok, error, width: name === 'desktop' ? 1440 : 390, truncated: false, consoleErrors: [], failedRequests: 0,
    segments: ok ? [{ index: 0, y: 0, height: 900, base64: 'abc' }] : []
  }
}
function cap(over: Partial<PageCapture> = {}): PageCapture {
  return { desktop: vp('desktop'), mobile: vp('mobile'), content: content(), contentSource: 'rendered', ...over }
}

test('fully confident when content and both viewports captured', () => {
  const c = assessConfidence(cap())
  assert.equal(isFullyConfident(c), true)
  assert.deepEqual(c.reasons, {})
})

test('a failed mobile capture only flags mobile', () => {
  const c = assessConfidence(cap({ mobile: vp('mobile', false, 'Navigation timeout') }))
  assert.equal(c.desktopOk, true)
  assert.equal(c.mobileOk, false)
  assert.equal(c.htmlOk, true)
  assert.equal(c.reasons.mobile, 'Navigation timeout')
})

test('thin text is fine when screenshots exist (image-heavy pages are legitimate)', () => {
  const c = assessConfidence(cap({ content: content({ wordCount: 12 }) }))
  assert.equal(c.htmlOk, true)
  assert.equal(isFullyConfident(c), true)
})

test('thin text with no desktop screenshot needs manual HTML', () => {
  const c = assessConfidence(cap({ content: content({ wordCount: 12 }), desktop: vp('desktop', false, 'crash') }))
  assert.equal(c.htmlOk, false)
  assert.match(c.reasons.html!, /12 words/)
})

test('no content at all flags html with the fetch error', () => {
  const c = assessConfidence(cap({ content: null, contentSource: 'none', contentError: 'HTTP 500' }))
  assert.equal(c.htmlOk, false)
  assert.equal(c.reasons.html, 'HTTP 500')
})

test('bot-protection page fails every piece so we never audit a Cloudflare screen', () => {
  const c = assessConfidence(cap({ content: content({ title: 'Just a moment...', wordCount: 20 }) }))
  assert.equal(c.htmlOk, false)
  assert.equal(c.desktopOk, false)
  assert.equal(c.mobileOk, false)
  assert.match(c.reasons.desktop!, /bot-protection/)
})

test('a long real page that mentions "captcha" is not treated as blocked', () => {
  assert.equal(looksBlocked('How our captcha works', null, 1500), null)
})
