import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fingerprintPage, diffFingerprints } from '../lib/page-diff'
import { isValidHttpUrl } from '../lib/validate'
import { pathVariants, monthRange } from '../lib/ga4-audit'
import type { ScrapedContent } from '../lib/scraper'
import type { LayoutFacts } from '../lib/capture'

const content = (over: Partial<ScrapedContent> = {}): ScrapedContent => ({
  url: 'u', title: 'Acme Solar', metaDescription: '', headings: [{ level: 'h1', text: 'Cut your bill by 60%' }, { level: 'h2', text: 'How it works' }],
  ctaButtons: ['Get a free quote'], forms: [{ fieldCount: 9, fieldLabels: [], submitText: 'Submit' }], trustSignals: ['Rated 4.8'],
  bodyTextSample: '', wordCount: 400, imageCount: 5, hasVideoEmbed: false, fetchedWithJs: false, ...over
})
const layout = (over: Partial<LayoutFacts> = {}): LayoutFacts => ({
  pageHeight: 4000, viewportHeight: 900, h1AboveFold: 'Cut your bill by 60%', h1Count: 1,
  ctasAboveFold: [{ text: 'Get a free quote', tag: 'a', top: 200, left: 40, width: 170, height: 46, background: '', color: '', fontSize: 16 }],
  ctasBelowFold: [], formAboveFold: false, formFieldCount: 9, hasStickyHeader: true, popupsDetected: [],
  horizontalOverflow: false, smallTapTargets: 0, imagesBroken: 0, ...over
})

test('identical pages show no change', () => {
  const a = fingerprintPage(content(), layout(), layout())
  const d = diffFingerprints(a, fingerprintPage(content(), layout(), layout()))
  assert.equal(d.changed, false)
})

test('first audit has nothing to compare', () => {
  const d = diffFingerprints(null, fingerprintPage(content(), layout(), layout()))
  assert.equal(d.changed, false)
  assert.match(d.summary, /First capture/)
})

test('detects a shorter form and a new hero CTA as significant changes', () => {
  const before = fingerprintPage(content(), layout(), layout())
  const after = fingerprintPage(
    content({ forms: [{ fieldCount: 4, fieldLabels: [], submitText: 'Get my quote' }] }),
    layout({ formFieldCount: 4, ctasAboveFold: [{ text: 'See my savings', tag: 'a', top: 200, left: 40, width: 170, height: 46, background: '', color: '', fontSize: 16 }] }),
    layout()
  )
  const d = diffFingerprints(before, after)
  assert.equal(d.changed, true)
  assert.equal(d.significant, true)
  const fields = d.changes.map(c => c.field)
  assert.ok(fields.includes('form_fields'))
  assert.ok(fields.includes('form_submit'))
  assert.ok(fields.includes('above_fold_cta_desktop_added'))
  assert.ok(fields.includes('above_fold_cta_desktop_removed'))
})

test('minor copy length wobble is ignored', () => {
  const d = diffFingerprints(fingerprintPage(content(), layout()), fingerprintPage(content({ wordCount: 430 }), layout()))
  assert.equal(d.changed, false)
})

test('URL validation blocks internal hosts', () => {
  assert.equal(isValidHttpUrl('https://www.subaru.co.za/'), true)
  assert.equal(isValidHttpUrl('ftp://x.com'), false)
  assert.equal(isValidHttpUrl('http://localhost:3000'), false)
  assert.equal(isValidHttpUrl('http://169.254.169.254/latest/meta-data'), false)
  assert.equal(isValidHttpUrl('http://10.0.0.5/'), false)
  assert.equal(isValidHttpUrl('http://[::1]/'), false)
})

test('GA4 helpers: exact path variants and calendar month ranges', () => {
  assert.deepEqual(pathVariants('https://a.com/'), ['/'])
  assert.deepEqual(pathVariants('https://a.com/pricing/?x=1'), ['/pricing', '/pricing/'])
  assert.deepEqual(monthRange('2026-02'), { startDate: '2026-02-01', endDate: '2026-02-28' })
  assert.deepEqual(monthRange('2024-02'), { startDate: '2024-02-01', endDate: '2024-02-29' })
})
