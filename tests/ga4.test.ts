import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateGuardrail } from '../lib/ga4'

test('max_drop_pct: breaches when the drop exceeds the threshold', () => {
  // baseline 100, current 90 -> 10% drop, threshold 2% -> should breach
  assert.equal(evaluateGuardrail(90, 100, 'max_drop_pct', 2), 'breached')
})

test('max_drop_pct: does not breach when the drop is within threshold', () => {
  // baseline 100, current 99 -> 1% drop, threshold 2% -> should be ok
  assert.equal(evaluateGuardrail(99, 100, 'max_drop_pct', 2), 'ok')
})

test('max_drop_pct: an increase is never a breach', () => {
  assert.equal(evaluateGuardrail(150, 100, 'max_drop_pct', 2), 'ok')
})

test('max_drop_pct: with no baseline yet, evaluates as ok (nothing to compare against)', () => {
  assert.equal(evaluateGuardrail(50, null, 'max_drop_pct', 2), 'ok')
})

test('max_drop_pct: a zero baseline does not divide-by-zero crash', () => {
  assert.doesNotThrow(() => evaluateGuardrail(10, 0, 'max_drop_pct', 2))
  assert.equal(evaluateGuardrail(10, 0, 'max_drop_pct', 2), 'ok')
})

test('min_value: breaches when current value falls below the threshold', () => {
  assert.equal(evaluateGuardrail(1.2, null, 'min_value', 1.5), 'breached')
})

test('min_value: ok when current value meets the threshold', () => {
  assert.equal(evaluateGuardrail(1.5, null, 'min_value', 1.5), 'ok')
})

test('max_value: breaches when current value exceeds the threshold', () => {
  assert.equal(evaluateGuardrail(5.5, null, 'max_value', 5), 'breached')
})

test('max_value: ok when current value is within the threshold', () => {
  assert.equal(evaluateGuardrail(4, null, 'max_value', 5), 'ok')
})

// Exact boundary case worth pinning down explicitly, since off-by-one here
// would mean a guardrail exactly at the threshold silently flips status
// depending on which way the comparison operator leans.
test('max_drop_pct boundary: a drop exactly equal to the threshold does not breach (strictly greater-than)', () => {
  // baseline 100, current 98 -> exactly 2% drop, threshold 2%
  assert.equal(evaluateGuardrail(98, 100, 'max_drop_pct', 2), 'ok')
})
