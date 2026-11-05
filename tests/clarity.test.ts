import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseClarityExport, matchPage, aggregatePages, aggregateStoredDays, normaliseUrl, formatClarityForPrompt } from '../lib/clarity'

// Shape of the real Clarity Data Export API response (array of metrics)
const sample = [
  { metricName: 'Traffic', information: [
    { totalSessionCount: '1000', totalBotSessionCount: '20', distantUserCount: '800', PagesPerSessionPercentage: 1.8, Url: 'https://www.acme.co.za/pricing' },
    { totalSessionCount: '3000', totalBotSessionCount: '40', distantUserCount: '2500', PagesPerSessionPercentage: 2.2, Url: 'https://www.acme.co.za/' },
    { totalSessionCount: '200', totalBotSessionCount: '0', distantUserCount: '150', PagesPerSessionPercentage: 1.1, Url: 'https://www.acme.co.za/pricing?utm_source=google' }
  ] },
  { metricName: 'RageClickCount', information: [
    { sessionsCount: '60', sessionsWithMetricPercentage: 6, sessionsWithoutMetricPercentage: 94, Url: 'https://www.acme.co.za/pricing' },
    { sessionsCount: '30', sessionsWithMetricPercentage: 1, sessionsWithoutMetricPercentage: 99, Url: 'https://www.acme.co.za/' }
  ] },
  { metricName: 'DeadClickCount', information: [
    { sessionsCount: '150', sessionsWithMetricPercentage: 15, Url: 'https://www.acme.co.za/pricing' }
  ] },
  { metricName: 'ScrollDepth', information: [
    { averageScrollDepth: 35.5, Url: 'https://www.acme.co.za/pricing' },
    { averageScrollDepth: 60, Url: 'https://www.acme.co.za/' }
  ] },
  { metricName: 'EngagementTime', information: [
    { totalTime: '120', activeTime: '45', Url: 'https://www.acme.co.za/pricing' }
  ] }
]

test('parses the real array-of-metrics response into per-URL rows', () => {
  const parsed = parseClarityExport(sample as any)
  const pricing = parsed.pages.find(p => p.url === 'https://www.acme.co.za/pricing')!
  assert.equal(pricing.totalSessions, 1000)
  assert.equal(pricing.rageClickSessions, 60)
  assert.equal(pricing.rageClickRate, 6)
  assert.equal(pricing.deadClickRate, 15)
  assert.equal(pricing.avgScrollDepth, 35.5)
  assert.equal(pricing.avgEngagementTime, 45)
  assert.equal(parsed.site.totalSessions, 4200)
})

test('the old bug is gone: metrics are not all zero', () => {
  const parsed = parseClarityExport(sample as any)
  assert.ok(parsed.site.rageClickSessions > 0)
})

test('matchPage ignores www, query strings and trailing slashes', () => {
  const parsed = parseClarityExport(sample as any)
  const rows = matchPage(parsed.pages, 'https://acme.co.za/pricing/')
  assert.equal(rows.length, 2)
  const agg = aggregatePages(rows, 'x')
  assert.equal(agg.totalSessions, 1200)
  // session-weighted: (6*1000 + 0*200) / 1200 = 5
  assert.equal(agg.rageClickRate, 5)
})

test('derives a rate from counts when the percentage is missing', () => {
  const parsed = parseClarityExport([
    { metricName: 'Traffic', information: [{ totalSessionCount: '200', Url: 'https://a.com/x' }] },
    { metricName: 'QuickbackClick', information: [{ sessionsCount: '50', Url: 'https://a.com/x' }] }
  ] as any)
  assert.equal(parsed.pages[0].quickbackRate, 25)
})

test('stored days aggregate; missing page falls back to site-wide and says so', () => {
  const day = parseClarityExport(sample as any)
  const page = aggregateStoredDays([day, day], 'https://acme.co.za/pricing')
  assert.equal(page.isPageLevel, true)
  assert.equal(page.data!.totalSessions, 2400)
  const missing = aggregateStoredDays([day], 'https://acme.co.za/contact')
  assert.equal(missing.isPageLevel, false)
  assert.match(formatClarityForPrompt(missing), /SITE-WIDE/)
})

test('prompt flags rates above benchmark only with enough sessions', () => {
  const day = parseClarityExport(sample as any)
  const res = aggregateStoredDays([day], 'https://acme.co.za/pricing')
  const text = formatClarityForPrompt(res)
  assert.match(text, /rage-click rate/)
  assert.match(text, /dead-click rate/)
})

test('normaliseUrl', () => {
  assert.equal(normaliseUrl('https://WWW.Acme.co.za/Pricing/?a=1#x'), 'acme.co.za/pricing')
  assert.equal(normaliseUrl('https://acme.co.za'), 'acme.co.za/')
})
