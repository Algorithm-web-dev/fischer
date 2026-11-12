import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanOps, sanitizeHtml, type DomOp } from '../lib/dom-ops'

const op = (o: Partial<DomOp>): DomOp => ({ selector: 'h1', action: 'setText', value: '', style: [], attribute: '', ...o })

test('sanitizeHtml strips scripts, handlers and dangerous URLs', () => {
  const s = sanitizeHtml('<p onclick="x()">Hi<script>alert(1)</script></p><a href="javascript:alert(2)">x</a><iframe src="//evil"></iframe><img src=x onerror=alert(3)>')
  assert.ok(!/script|onclick|onerror|iframe|javascript:/i.test(s), s)
  assert.match(s, /<p>Hi<\/p>/)
})

test('cleanOps keeps safe edits and rejects unsafe ones', () => {
  const { ops, rejected } = cleanOps([
    op({ action: 'setText', value: 'New headline' }),
    op({ action: 'setAttribute', attribute: 'onclick', value: 'x()' }),
    op({ action: 'setAttribute', attribute: 'href', value: 'javascript:alert(1)' }),
    op({ action: 'setAttribute', attribute: 'type', value: 'tel' }),
    op({ action: 'setStyle', style: [{ property: 'background', value: 'url(https://evil/x.png)' }, { property: 'color', value: '#fff' }, { property: 'behavior', value: 'x' }] }),
    op({ action: 'setStyle', style: [{ property: 'behavior', value: 'x' }] }),
    op({ selector: '<script>', action: 'hide' }),
    op({ action: 'insertAfter', value: '<p>ok</p><script>bad()</script>' })
  ])
  assert.equal(ops.length, 4)
  assert.equal(rejected.length, 4)
  assert.deepEqual(ops.find(o => o.action === 'setStyle')!.style, [{ property: 'color', value: '#fff' }])
  assert.equal(ops.find(o => o.action === 'insertAfter')!.value, '<p>ok</p>')
  assert.ok(ops.some(o => o.action === 'setAttribute' && o.attribute === 'type'))
})

test('caps the number of edits', () => {
  assert.equal(cleanOps(Array.from({ length: 50 }, () => op({}))).ops.length, 20)
})
