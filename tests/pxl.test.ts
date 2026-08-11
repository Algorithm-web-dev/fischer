import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PXL_CRITERIA } from '../lib/pxl'

test('PXL_CRITERIA has exactly 10 criteria, per the PXL model', () => {
  assert.equal(PXL_CRITERIA.length, 10)
})

test('every PXL criterion has a unique key (no accidental duplicates)', () => {
  const keys = PXL_CRITERIA.map(c => c.key)
  const uniqueKeys = new Set(keys)
  assert.equal(uniqueKeys.size, keys.length, 'duplicate keys would silently overwrite each other in the scoring object')
})

test('every PXL criterion has a non-empty question and a positive weight', () => {
  for (const c of PXL_CRITERIA) {
    assert.ok(c.question.length > 10, `criterion "${c.key}" has a suspiciously short question`)
    assert.ok(c.weight > 0, `criterion "${c.key}" must have a positive weight`)
  }
})

test('max possible PXL score is the sum of all weights and is deterministic', () => {
  const maxScore = PXL_CRITERIA.reduce((sum, c) => sum + c.weight, 0)
  assert.ok(maxScore > 0)
  // Pinned to the current weighting (see lib/pxl.ts) — if someone adjusts a
  // weight, this test SHOULD fail and force an explicit update, not silently pass.
  assert.equal(maxScore, 16, 'if this fails after an intentional reweighting, update this constant to match')
})
