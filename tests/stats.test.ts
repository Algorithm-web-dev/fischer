import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalCdf, normalInv, twoProportionTest, sampleSizePerArm, planTest, computeRevenueImpact, pctChange } from '../lib/stats'

const close = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`)

test('normal distribution helpers match known values', () => {
  close(normalCdf(1.96), 0.975, 0.0005)
  close(normalCdf(0), 0.5, 1e-7)
  close(normalInv(0.975), 1.959964, 0.0001)
  close(normalInv(0.8), 0.841621, 0.0001)
  close(normalInv(0.01), -2.326348, 0.0001)
})

test('clear winner is significant', () => {
  const r = twoProportionTest({ visitors: 10000, conversions: 200 }, { visitors: 10000, conversions: 260 })
  assert.equal(r.controlRate, 2)
  assert.equal(r.variantRate, 2.6)
  assert.equal(r.relativeLift, 30)
  assert.equal(r.significant, true)
  assert.equal(r.winner, 'variant')
  assert.ok(r.pValue < 0.01)
  assert.ok(r.ciLow > 0 && r.ciHigh > r.ciLow)
})

test('noise is not significant', () => {
  const r = twoProportionTest({ visitors: 1000, conversions: 20 }, { visitors: 1000, conversions: 23 })
  assert.equal(r.significant, false)
  assert.equal(r.winner, 'none')
  assert.match(r.verdict, /No significant difference/)
})

test('a losing variant is called', () => {
  const r = twoProportionTest({ visitors: 10000, conversions: 300 }, { visitors: 10000, conversions: 220 })
  assert.equal(r.winner, 'control')
})

test('under-sampled tests say keep running even if p is low', () => {
  const r = twoProportionTest({ visitors: 500, conversions: 5 }, { visitors: 500, conversions: 20 }, { plannedSamplePerArm: 5000 })
  assert.equal(r.sampleSufficient, false)
  assert.match(r.verdict, /Not enough traffic/)
})

test('rejects impossible inputs', () => {
  assert.throws(() => twoProportionTest({ visitors: 0, conversions: 0 }, { visitors: 10, conversions: 1 }))
  assert.throws(() => twoProportionTest({ visitors: 10, conversions: 11 }, { visitors: 10, conversions: 1 }))
})

test('sample size matches standard calculators (2% baseline, +20% MDE ≈ 21k/arm)', () => {
  const n = sampleSizePerArm(2, 20)
  assert.ok(n > 20000 && n < 22500, String(n))
})

test('test plan uses real traffic and enforces a 14-day minimum', () => {
  const big = planTest({ baselineRatePct: 3, expectedLiftPct: 30, monthlyPageSessions: 900000 })
  assert.equal(big.estimatedDays, 14)
  assert.equal(big.feasible, true)
  const small = planTest({ baselineRatePct: 1, expectedLiftPct: 5, monthlyPageSessions: 3000 })
  assert.equal(small.feasible, false)
  assert.match(small.note, /bolder change/)
  const none = planTest({ baselineRatePct: 2, expectedLiftPct: 10, monthlyPageSessions: 0 })
  assert.equal(none.estimatedDays, null)
})

test('revenue impact is plain arithmetic on real inputs', () => {
  const r = computeRevenueImpact({ monthlyTraffic: 10000, conversionRatePct: 2, valuePerConversion: 1500, lifts: { conservative: 5, realistic: 10, aggressive: 20 }, basis: 'ga4', currency: 'ZAR' })
  assert.equal(r.currentMonthlyConversions, 200)
  assert.equal(r.currentMonthlyRevenue, 300000)
  assert.equal(r.conservativeAdditionalRevenue, 15000)
  assert.equal(r.realisticAdditionalRevenue, 30000)
  assert.equal(r.aggressiveAdditionalRevenue, 60000)
})

test('pctChange', () => {
  assert.equal(pctChange(2, 2.5), 25)
  assert.equal(pctChange(0, 5), null)
  assert.equal(pctChange(null, 5), null)
})
