import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normaliseLead, computeLeadQuality, hashKey, newIngestKey, normalisePath } from '../lib/lead-quality'

test('normaliseLead maps CRM statuses, cleans values and drops personal data', () => {
  const r = normaliseLead('c1', { externalId: ' CRM-1 ', status: 'Closed Won', value: 'R45,000', landingPage: 'https://www.acme.co.za/Quote/?utm=x', utmSource: 'google', ...({ email: 'jane@x.com', name: 'Jane', phone: '082' } as any) }) as any
  assert.equal(r.external_id, 'CRM-1')
  assert.equal(r.status, 'won')
  assert.equal(r.value, 45000)
  assert.equal(r.landing_page, '/quote')
  assert.ok(r.closed_at)                       // won leads get a close date
  for (const pii of ['email', 'name', 'phone']) assert.equal(pii in r, false)
})

test('normaliseLead rejects bad input with a clear message', () => {
  assert.match(String(normaliseLead('c', { externalId: '' })), /externalId/)
  assert.match(String(normaliseLead('c', { externalId: '1', status: 'banana' })), /Unknown status/)
  assert.match(String(normaliseLead('c', { externalId: '1', createdAt: 'not a date' })), /createdAt/)
  assert.match(String(normaliseLead('c', { externalId: '1', value: 'abc' })), /value/)
})

test('ingest keys are hashed, never stored in plain text', () => {
  const { key, hash } = newIngestKey()
  assert.match(key, /^fsk_/)
  assert.equal(hash, hashKey(key))
  assert.notEqual(hash, key)
  assert.equal(hash.length, 64)
})

const lead = (page: string, status: string, value: number | null = null, utm: string | null = 'google') =>
  ({ status, value, landing_page: page, utm_source: utm, utm_medium: utm ? 'cpc' : null, channel: null, created_at: '2026-10-05T00:00:00Z' })

test('quality by page and source, with insights for low-quality volume', () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => lead('/quote', i < 10 ? 'qualified' : 'new')),           // 50% qualified
    ...Array.from({ length: 20 }, (_, i) => lead('/promo', i < 2 ? 'qualified' : 'unqualified', null, 'facebook')), // 10%
    lead('/quote', 'won', 50000), lead('/quote', 'won', 30000)
  ]
  const q = computeLeadQuality(rows, { from: '2026-10-01', to: '2026-10-31' })
  assert.equal(q.totals.leads, 42)
  assert.equal(q.totals.won, 2)
  assert.equal(q.totals.revenue, 80000)
  const promo = q.byPage.find(p => p.key === '/promo')!
  assert.equal(promo.qualifiedRate, 10)
  assert.ok(q.insights.some(i => i.startsWith('/promo') && /only 10% qualify/.test(i)))
  assert.ok(q.bySource.some(s => s.key === 'facebook / cpc'))
  assert.equal(q.valuePerLead, Math.round(80000 / 42))
})

test('flags missing source data', () => {
  const rows = Array.from({ length: 10 }, () => ({ ...lead('', 'new'), landing_page: null }))
  const q = computeLeadQuality(rows, { from: '', to: '' })
  assert.ok(q.insights.some(i => /no landing page/.test(i)))
  assert.equal(q.valuePerLead, null)
})

test('normalisePath', () => {
  assert.equal(normalisePath('/Quote/'), '/quote')
  assert.equal(normalisePath('quote?x=1'), '/quote')
  assert.equal(normalisePath('https://a.com/'), '/')
})
