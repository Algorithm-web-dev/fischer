import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyseTrackingRequests, buildTrackingIssues, type GA4EventRow } from '../lib/tracking'

const reqs = [
  'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123',
  'https://www.googletagmanager.com/gtag/js?id=G-AAAA111',
  'https://region1.google-analytics.com/g/collect?v=2&tid=G-AAAA111&gcs=G111&en=page_view',
  'https://www.clarity.ms/tag/k3xyz9',
  'https://k.clarity.ms/collect',
  'https://connect.facebook.net/en_US/fbevents.js',
  'https://www.googletagmanager.com/gtag/js?id=AW-123456789'
]

test('detects tags, IDs, hits and consent from network requests', () => {
  const d = analyseTrackingRequests(reqs, [['consent', 'default', { analytics_storage: 'denied' }], { event: 'gtm.js' }, { event: 'form_start' }])
  assert.deepEqual(d.ga4MeasurementIds, ['G-AAAA111'])
  assert.equal(d.ga4Hits, 1)
  assert.equal(d.ga4ServerSide, false)
  assert.deepEqual(d.gtmContainers, ['GTM-ABC123'])
  assert.deepEqual(d.clarityProjectIds, ['k3xyz9'])
  assert.equal(d.clarityHits, 1)
  assert.equal(d.metaPixel, true)
  assert.deepEqual(d.googleAdsIds, ['AW-123456789'])
  assert.equal(d.analyticsConsent, 'granted')
  assert.deepEqual(d.consentDefault, { analytics_storage: 'denied' })
  assert.deepEqual(d.dataLayerEvents, ['form_start'])
})

test('server-side GA4 (own domain) counts as sending', () => {
  const d = analyseTrackingRequests(['https://sgtm.acme.co.za/g/collect?v=2&tid=G-X1&gcs=G100'], [])
  assert.equal(d.ga4ServerSide, true)
  assert.equal(d.analyticsConsent, 'denied')
})

const events: GA4EventRow[] = [
  { name: 'page_view', count: 9000, isKeyEvent: false },
  { name: 'generate_lead', count: 120, isKeyEvent: true },
  { name: 'form_start', count: 400, isKeyEvent: false }
]

test('healthy setup produces no high issues', () => {
  const d = analyseTrackingRequests(reqs, [['consent', 'default', {}]])
  const issues = buildTrackingIssues({ detected: d, events, client: { clarity_project_id: 'k3xyz9', ga4_conversion_event: 'generate_lead' } })
  assert.equal(issues.filter(i => i.severity === 'high').length, 0)
})

test('missing GA4, wrong Clarity project and missing conversion event are high issues', () => {
  const d = analyseTrackingRequests(['https://www.clarity.ms/tag/other1'], [])
  const issues = buildTrackingIssues({ detected: d, events: [{ name: 'page_view', count: 10, isKeyEvent: false }], client: { clarity_project_id: 'k3xyz9', ga4_conversion_event: 'generate_lead' } })
  const codes = issues.map(i => i.code)
  assert.ok(codes.includes('ga4_missing'))
  assert.ok(codes.includes('clarity_missing'))
  assert.ok(codes.includes('no_key_events'))
  assert.ok(codes.includes('conversion_event_missing'))
  assert.equal(issues[0].severity, 'high')
})

test('tag loads but sends nothing; duplicate IDs flagged', () => {
  const d = analyseTrackingRequests(['https://www.googletagmanager.com/gtag/js?id=G-ONE', 'https://www.googletagmanager.com/gtag/js?id=G-TWO'], [])
  const codes = buildTrackingIssues({ detected: d, events: null }).map(i => i.code)
  assert.ok(codes.includes('ga4_not_sending'))
  assert.ok(codes.includes('ga4_duplicate'))
})

test('e-commerce sites without funnel events get a high issue', () => {
  const d = analyseTrackingRequests(reqs, [['consent', 'default', {}]])
  const issues = buildTrackingIssues({ detected: d, events: [{ name: 'purchase', count: 5, isKeyEvent: true }], businessGoal: 'E-commerce Sales', client: { clarity_project_id: 'k3xyz9' } })
  const funnel = issues.find(i => i.code === 'standard_events_missing')
  assert.equal(funnel?.severity, 'high')
  assert.match(funnel!.message, /add_to_cart/)
})
