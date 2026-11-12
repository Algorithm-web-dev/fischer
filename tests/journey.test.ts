import { test } from 'node:test'
import assert from 'node:assert/strict'
import { journeyIssues, type FormInspection } from '../lib/journey'

const form = (over: Partial<FormInspection> = {}): FormInspection => ({
  fieldCount: 3, requiredCount: 2, submitText: 'Get my quote', submitVisible: true, html5Validation: true, noValidate: false, captcha: false,
  fields: [
    { name: 'name', type: 'text', hasLabel: true, autocomplete: 'name', height: 48, required: true },
    { name: 'phone', type: 'tel', hasLabel: true, autocomplete: 'tel', height: 48, required: true },
    { name: 'email', type: 'email', hasLabel: true, autocomplete: 'email', height: 48, required: false }
  ], ...over
})
const base = { kind: 'lead' as const, startUrl: 'u', viewport: 'mobile' as const, ranAt: '', checkout: null, consoleErrors: [] }

test('a well-built lead journey has no issues', () => {
  const issues = journeyIssues({ ...base, steps: [{ name: 'Load page', ok: true, detail: '' }], form: form(), contact: { tel: true, whatsapp: true, email: false } })
  assert.deepEqual(issues, [])
})

test('failed steps are high-severity issues', () => {
  const issues = journeyIssues({ ...base, steps: [{ name: 'Find form', ok: false, detail: 'No visible form found.' }], form: null, contact: { tel: true, whatsapp: false, email: false } })
  assert.equal(issues[0].severity, 'high')
  assert.match(issues[0].message, /No visible form/)
})

test('form usability problems are caught', () => {
  const bad = form({
    fieldCount: 8, requiredCount: 0, html5Validation: false, captcha: true,
    fields: [
      { name: 'phone', type: 'text', hasLabel: false, autocomplete: null, height: 30, required: false },
      { name: 'email', type: 'text', hasLabel: false, autocomplete: null, height: 30, required: false }
    ]
  })
  const codes = journeyIssues({ ...base, steps: [], form: bad, contact: { tel: false, whatsapp: false, email: false } }).map(i => i.code)
  for (const c of ['too_many_fields', 'missing_labels', 'phone_keyboard', 'email_keyboard', 'no_autocomplete', 'small_fields', 'no_validation', 'captcha', 'no_quick_contact']) {
    assert.ok(codes.includes(c), `missing ${c}`)
  }
})

test('hidden submit button is high severity', () => {
  const issues = journeyIssues({ ...base, steps: [], form: form({ submitVisible: false }), contact: { tel: true, whatsapp: false, email: false } })
  assert.equal(issues.find(i => i.code === 'submit_hidden')?.severity, 'high')
})

test('checkout: forced login is high, hidden shipping is medium', () => {
  const issues = journeyIssues({
    ...base, kind: 'ecommerce', steps: [], form: null, contact: { tel: false, whatsapp: false, email: false },
    checkout: { reached: true, guestCheckout: false, forcedLogin: true, shippingShown: false, paymentMethods: ['visa'] }
  })
  assert.equal(issues.find(i => i.code === 'forced_login')?.severity, 'high')
  assert.equal(issues.find(i => i.code === 'shipping_hidden')?.severity, 'medium')
  assert.ok(!issues.some(i => i.code === 'no_quick_contact')) // only checked for lead journeys
})
