import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costUsd } from '../lib/llm'
import { encryptSecret, decryptSecret, isEncrypted } from '../lib/secrets'

test('cost per call from token usage', () => {
  // Opus 5.5: $4 in / $20 out per MTok
  assert.equal(costUsd('claude-opus-5-5', { input_tokens: 25_000, output_tokens: 10_000 }), 0.3)
  // Sonnet 5.5 is half the price
  assert.equal(costUsd('claude-sonnet-5-5', { input_tokens: 25_000, output_tokens: 10_000 }), 0.15)
  // cache reads at 10%, writes at 125% of input price
  assert.equal(costUsd('claude-opus-5-5', { cache_read_input_tokens: 1_000_000 }), 0.4)
  assert.equal(costUsd('claude-opus-5-5', { cache_creation_input_tokens: 1_000_000 }), 5)
  // web searches at $10 per 1000
  assert.equal(costUsd('claude-opus-5-5', {}, 3), 0.03)
  // unknown model → tokens recorded elsewhere, cost 0
  assert.equal(costUsd('some-future-model', { input_tokens: 1000 }), 0)
})

test('secrets are encrypted at rest and round-trip', () => {
  process.env.FISCHER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
  const enc = encryptSecret('clarity-token-123')
  assert.ok(isEncrypted(enc))
  assert.ok(!enc.includes('clarity-token-123'))
  assert.notEqual(encryptSecret('clarity-token-123'), enc) // random IV
  assert.equal(decryptSecret(enc), 'clarity-token-123')
  assert.equal(encryptSecret(enc), enc)                     // never double-encrypts
  assert.equal(decryptSecret('legacy-plain-token'), 'legacy-plain-token')
  // tampering is detected
  const parts = enc.split(':'); parts[4] = Buffer.from('tampered').toString('base64url')
  assert.throws(() => decryptSecret(parts.join(':')))
  // wrong key fails
  process.env.FISCHER_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
  assert.throws(() => decryptSecret(enc))
  delete process.env.FISCHER_ENCRYPTION_KEY
})
