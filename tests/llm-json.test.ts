import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { parseJsonReply, isGrammarTooLarge } from '../lib/llm'
import { AuditOutputSchema } from '../lib/claude'

const S = z.object({ a: z.number(), kind: z.enum(['x', 'y']) })

test('parseJsonReply accepts fenced JSON with surrounding prose', () => {
  const r = parseJsonReply('Here you go:\n```json\n{"a": 1, "kind": "x"}\n```', S)
  assert.deepEqual(r, { ok: true, value: { a: 1, kind: 'x' } })
})

test('parseJsonReply reports schema mismatches by path', () => {
  const r = parseJsonReply('{"a": "1", "kind": "z"}', S)
  assert.equal(r.ok, false)
  if (!r.ok) { assert.match(r.error, /a:/); assert.match(r.error, /kind:/) }
})

test('parseJsonReply rejects non-JSON', () => {
  assert.equal(parseJsonReply('sorry', S).ok, false)
  assert.equal(parseJsonReply('{not json}', S).ok, false)
})

test('isGrammarTooLarge recognises the API error', () => {
  const err = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools."}}'), { status: 400 })
  assert.equal(isGrammarTooLarge(err), true)
  assert.equal(isGrammarTooLarge(Object.assign(new Error('400 max_tokens too large'), { status: 400 })), false)
  assert.equal(isGrammarTooLarge(Object.assign(new Error('overloaded'), { status: 529 })), false)
})

test('audit schema converts to JSON Schema for the prompt', () => {
  const js = z.toJSONSchema(AuditOutputSchema, { unrepresentable: 'any' }) as { properties: Record<string, unknown> }
  assert.ok(js.properties.frictionPoints)
  assert.ok(JSON.stringify(js).includes('screenshot_desktop'))
})
