import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateAdsRows } from '../lib/google-ads'
import { signState, verifyState } from '../lib/google'
import { formatSearchForPrompt } from '../lib/search-console'

test('Ads rows merge by landing path and convert micros to currency', () => {
  const rows = aggregateAdsRows([
    { landingPageView: { unexpandedFinalUrl: 'https://acme.co.za/quote?gclid=1' }, metrics: { costMicros: '1500000000', clicks: '300', conversions: 6 } },
    { landingPageView: { unexpandedFinalUrl: 'https://acme.co.za/quote/' }, metrics: { costMicros: '500000000', clicks: '100', conversions: 2 } },
    { landingPageView: { unexpandedFinalUrl: 'https://acme.co.za/' }, metrics: { costMicros: '250000000', clicks: '90', conversions: 4 } },
    { landingPageView: { unexpandedFinalUrl: 'not a url' }, metrics: { costMicros: '9' } }
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].path, '/quote')
  assert.equal(rows[0].cost, 2000)
  assert.equal(rows[0].clicks, 400)
  assert.equal(rows[0].conversions, 8)
  assert.equal(rows[1].path, '/')
})

test('OAuth state is signed, bound to the user, and expires', () => {
  process.env.FISCHER_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64')
  const s = signState({ clientId: 'c1', userId: 'u1' })
  assert.deepEqual(verifyState(s), { clientId: 'c1', userId: 'u1' })
  const [body, sig] = s.split('.')
  const forged = Buffer.from(JSON.stringify({ clientId: 'c2', userId: 'u1', exp: Date.now() + 1e6 })).toString('base64url')
  assert.equal(verifyState(`${forged}.${sig}`), null)
  assert.equal(verifyState(`${body}.x${sig}`), null)
  assert.equal(verifyState('garbage'), null)
  const realNow = Date.now
  Date.now = () => realNow() + 16 * 60_000
  assert.equal(verifyState(s), null)
  Date.now = realNow
  delete process.env.FISCHER_ENCRYPTION_KEY
})

test('Search Console prompt section lists queries for message-match checks', () => {
  const text = formatSearchForPrompt({
    siteUrl: 'sc-domain:acme.co.za', pageUrl: 'https://acme.co.za/quote', range: { startDate: '2026-08-01', endDate: '2026-10-31' },
    totals: { clicks: 420, impressions: 18000, ctr: 2.3, position: 8.4 },
    queries: [{ query: 'solar panel installation cost', clicks: 120, impressions: 4000, ctr: 3, position: 5.1 }]
  })
  assert.match(text, /solar panel installation cost/)
  assert.match(text, /search_console/)
})
