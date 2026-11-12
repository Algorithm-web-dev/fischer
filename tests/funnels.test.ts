import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeFunnel, funnelKindForGoal } from '../lib/funnels'

const range = { startDate: '2026-10-01', endDate: '2026-10-31' }
const rows = (o: Record<string, [number, number]>) =>
  Object.entries(o).flatMap(([event, [desktop, mobile]]) => [{ event, device: 'desktop', users: desktop }, { event, device: 'mobile', users: mobile }])

test('lead funnel: form completion is the reported drop, with value sensitivity', () => {
  const f = computeFunnel({
    kind: 'lead', range, valuePerConversion: 1000,
    counts: rows({ __users__: [4000, 6000], form_start: [400, 600], form_submit: [200, 100], click_to_call: [30, 90] })
  })
  assert.equal(f.measured, true)
  assert.equal(f.steps[1].users, 1000)
  assert.equal(f.steps[2].rateFromPrevious, 30)          // 300 / 1000
  assert.equal(f.worstStep?.to, 'Submitted a form')
  assert.equal(f.worstStep?.dropOff, 700)
  // 10% relative lift on a 30% step with 1000 entering = 30 more submissions
  assert.equal(f.sensitivity?.extraConversions, 30)
  assert.equal(f.sensitivity?.extraValue, 30000)
  // mobile completes 16.7% vs desktop 50% → flagged
  assert.equal(f.deviceGaps.length, 1)
  assert.equal(f.deviceGaps[0].desktopRate, 50)
  assert.equal(f.contactActions.find(c => c.event === 'click_to_call')?.users, 120)
})

test('lead funnel falls back to the client conversion event when form_submit is not tracked', () => {
  const f = computeFunnel({ kind: 'lead', range, valuePerConversion: 0, conversionEvent: 'generate_lead',
    counts: rows({ __users__: [1000, 1000], form_start: [100, 100], generate_lead: [40, 20] }) })
  assert.equal(f.measured, true)
  assert.equal(f.steps[2].label, 'Converted')
  assert.equal(f.steps[2].rateFromPrevious, 30)
})

test('missing events → not measured, with a note, no invented drop', () => {
  const f = computeFunnel({ kind: 'lead', range, valuePerConversion: 0, counts: rows({ __users__: [100, 100] }) })
  assert.equal(f.measured, false)
  assert.deepEqual(f.missingEvents, ['form_start', 'form_submit'])
  assert.equal(f.worstStep, null)
  assert.ok(f.notes.some(n => /tracking kit/.test(n)))
  assert.ok(f.notes.some(n => /WhatsApp/.test(n)))
})

test('e-commerce funnel finds the weakest step and skips add_payment_info when absent', () => {
  const f = computeFunnel({ kind: 'ecommerce', range, valuePerConversion: 800,
    counts: rows({ view_item: [5000, 5000], add_to_cart: [800, 700], begin_checkout: [500, 400], purchase: [300, 100] }) })
  assert.equal(f.steps.length, 4)
  assert.equal(f.worstStep?.to, 'Added to cart')   // 15% is the lowest step rate
  assert.ok(f.deviceGaps.some(g => g.step.includes('Purchased')))
})

test('goal → funnel kind', () => {
  assert.equal(funnelKindForGoal('E-commerce Sales'), 'ecommerce')
  assert.equal(funnelKindForGoal('Lead Generation'), 'lead')
})
