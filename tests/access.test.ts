import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessDecision } from '../lib/access'

const allow = (r: ReturnType<typeof accessDecision>) => r.allow

test('no role → no access anywhere', () => {
  const r = accessDecision(null, '/clients', 'GET')
  assert.equal(r.allow, false)
  if (!r.allow) assert.equal(r.redirect, '/?error=no_access')
})

test('client users stay inside the portal', () => {
  assert.ok(allow(accessDecision('client', '/portal', 'GET')))
  assert.ok(allow(accessDecision('client', '/portal/report/abc/2026-10', 'GET')))
  const r = accessDecision('client', '/clients/abc', 'GET')
  assert.equal(r.allow, false)
  if (!r.allow) assert.equal(r.redirect, '/portal')
  assert.equal(allow(accessDecision('client', '/api/clients', 'GET')), false)
  assert.equal(allow(accessDecision('client', '/api/audit', 'POST')), false)
})

test('viewers are read-only', () => {
  assert.ok(allow(accessDecision('viewer', '/api/clients', 'GET')))
  assert.equal(allow(accessDecision('viewer', '/api/clients', 'PATCH')), false)
  assert.equal(allow(accessDecision('viewer', '/api/audit', 'POST')), false)
})

test('admin-only areas', () => {
  for (const p of ['/admin', '/api/team', '/api/errors', '/api/clients/x/export']) {
    assert.equal(allow(accessDecision('analyst', p, 'GET')), false, p)
    assert.ok(allow(accessDecision('admin', p, 'GET')), p)
  }
  assert.equal(allow(accessDecision('analyst', '/api/clients/x', 'DELETE')), false)
  assert.ok(allow(accessDecision('admin', '/api/clients/x', 'DELETE')))
  assert.ok(allow(accessDecision('analyst', '/api/clients/x', 'GET')))
})

test('analysts can do client work; team is sent away from the portal', () => {
  assert.ok(allow(accessDecision('analyst', '/api/audit', 'POST')))
  const r = accessDecision('analyst', '/portal', 'GET')
  assert.equal(r.allow, false)
  if (!r.allow) assert.equal(r.redirect, '/clients')
})
