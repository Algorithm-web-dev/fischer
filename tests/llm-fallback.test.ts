import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { anthropic, structuredCall } from '../lib/llm'

const S = z.object({ score: z.number(), level: z.enum(['high', 'low']) })

function reply(text: string) {
  return { finalMessage: async () => ({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text }] }) }
}

test('structuredCall falls back to validated JSON mode and retries once on a mismatch', async () => {
  const calls: any[] = []
  const original = anthropic.beta.messages.stream
  ;(anthropic.beta.messages as any).stream = (params: any) => {
    calls.push(params)
    if (calls.length === 1) throw Object.assign(new Error('400 The compiled grammar is too large, which would cause performance issues.'), { status: 400 })
    if (calls.length === 2) return reply('{"score": 70, "level": "medium"}')
    return reply('```json\n{"score": 70, "level": "high"}\n```')
  }
  try {
    const out = await structuredCall({ schema: S, system: 'sys', content: 'audit this' })
    assert.deepEqual(out, { score: 70, level: 'high' })
    assert.equal(calls.length, 3)
    assert.ok(calls[0].output_config.format, 'first try is strict')
    assert.equal(calls[1].output_config.format, undefined)
    assert.match(calls[1].system, /JSON Schema/)
    assert.match(calls[2].messages.at(-1).content, /level/)
    // The schema is remembered: the next call skips the strict attempt.
    calls.length = 0
    ;(anthropic.beta.messages as any).stream = (params: any) => { calls.push(params); return reply('{"score": 1, "level": "low"}') }
    await structuredCall({ schema: S, system: 'sys', content: 'again' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].output_config.format, undefined)
  } finally {
    ;(anthropic.beta.messages as any).stream = original
  }
})

test('other API errors are not swallowed', async () => {
  const original = anthropic.beta.messages.stream
  ;(anthropic.beta.messages as any).stream = () => { throw Object.assign(new Error('401 invalid x-api-key'), { status: 401 }) }
  try {
    await assert.rejects(structuredCall({ schema: z.object({ q: z.string() }), system: 's', content: 'c' }), /401/)
  } finally {
    ;(anthropic.beta.messages as any).stream = original
  }
})
