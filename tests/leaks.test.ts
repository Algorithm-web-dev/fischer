import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeLeaks, leakForUrl, RECOVERY_FACTOR } from '../lib/leaks'

const range = { startDate: '2026-10-01', endDate: '2026-10-30' } // 30 days

const cells = [
  // site desktop: (60+30)/(2000+1000) = 3%   site mobile: (40+20+10)/(4000+2000+1000) = 1%
  { page: '/', device: 'desktop', sessions: 2000, conversions: 60, revenue: 0 },    // 3% = target → no leak
  { page: '/', device: 'mobile', sessions: 4000, conversions: 40, revenue: 0 },     // 1% = target → no leak
  { page: '/quote', device: 'desktop', sessions: 1000, conversions: 30, revenue: 0 },// 3% → no leak
  { page: '/quote', device: 'mobile', sessions: 2000, conversions: 20, revenue: 0 }, // 1% → no leak
  { page: '/pricing', device: 'mobile', sessions: 1000, conversions: 10, revenue: 0 }, // 1% → no leak
  { page: '/tiny', device: 'mobile', sessions: 50, conversions: 0, revenue: 0 }      // below min sessions
]

test('no leaks when every cell converts at the site rate for its device', () => {
  const a = computeLeaks({ cells: cells.slice(0, 5), channels: [], range, valuePerConversion: 1000, valueBasis: 'client_setting' })
  assert.equal(a.pages.length, 0)
  assert.equal(a.totals.recoverableValue, 0)
  assert.equal(a.site.byDevice.desktop.conversionRate, 3)
  assert.equal(a.site.byDevice.mobile.conversionRate, 1)
})

test('a page converting below its device average is a leak, valued and recovered at half', () => {
  const leaky = [
    { page: '/', device: 'desktop', sessions: 3000, conversions: 120, revenue: 0 },   // 4%
    { page: '/quote', device: 'desktop', sessions: 1000, conversions: 0, revenue: 0 } // 0%  → site desktop = 3%
  ]
  const a = computeLeaks({ cells: leaky, channels: [], range, valuePerConversion: 2000, valueBasis: 'client_setting', siteOrigin: 'https://acme.co.za/' })
  assert.equal(a.pages.length, 1)
  const p = a.pages[0]
  assert.equal(p.page, '/quote')
  assert.equal(p.url, 'https://acme.co.za/quote')
  // lost = 1000 × 3% = 30 conversions; gap R60k; recoverable R30k
  assert.equal(p.cells[0].lostConversions, 30)
  assert.equal(p.gapValue, 60000)
  assert.equal(p.recoverableValue, 60000 * RECOVERY_FACTOR)
  assert.equal(p.share, 100)
  assert.equal(a.totals.recoverableMonthly, 30000)
})

test('totals by page and device add up (no double counting)', () => {
  const mixed = [
    { page: '/a', device: 'desktop', sessions: 1000, conversions: 50, revenue: 0 },
    { page: '/b', device: 'desktop', sessions: 1000, conversions: 10, revenue: 0 },
    { page: '/a', device: 'mobile', sessions: 2000, conversions: 40, revenue: 0 },
    { page: '/b', device: 'mobile', sessions: 2000, conversions: 0, revenue: 0 }
  ]
  const a = computeLeaks({ cells: mixed, channels: [], range, valuePerConversion: 100, valueBasis: 'client_setting' })
  const byPage = a.pages.reduce((s, p) => s + p.recoverableValue, 0)
  const byDevice = a.byDevice.reduce((s, d) => s + d.recoverableValue, 0)
  assert.equal(byPage, a.totals.recoverableValue)
  assert.equal(byDevice, a.totals.recoverableValue)
})

test('mobile gap is reported separately when mobile < 70% of desktop', () => {
  const a = computeLeaks({
    cells: [
      { page: '/', device: 'desktop', sessions: 2000, conversions: 80, revenue: 0 },  // 4%
      { page: '/', device: 'mobile', sessions: 5000, conversions: 50, revenue: 0 }    // 1% (target 2.8%)
    ], channels: [], range, valuePerConversion: 1000, valueBasis: 'client_setting'
  })
  assert.ok(a.mobileGap)
  assert.equal(a.mobileGap!.targetRate, 2.8)
  assert.equal(a.mobileGap!.lostConversions, 90)   // 5000 × 1.8%
  assert.equal(a.mobileGap!.value, 45000)
})

test('paid channels converting below site average are flagged', () => {
  const a = computeLeaks({
    cells: [{ page: '/', device: 'desktop', sessions: 10000, conversions: 200, revenue: 0 }], // 2%
    channels: [
      { page: '/promo', channel: 'Paid Search', sessions: 2000, conversions: 10 },  // 0.5%
      { page: '/', channel: 'Organic Search', sessions: 5000, conversions: 50 },    // not paid
      { page: '/', channel: 'Paid Social', sessions: 1000, conversions: 40 }        // 4%, fine
    ], range, valuePerConversion: 0, valueBasis: 'none'
  })
  assert.equal(a.paidTraffic.length, 1)
  assert.equal(a.paidTraffic[0].page, '/promo')
  assert.equal(a.paidTraffic[0].lostConversions, 30)
  assert.ok(a.notes.some(n => /value per conversion/.test(n)))
})

test('zero conversions → tracking warning, not a fake leak', () => {
  const a = computeLeaks({ cells: [{ page: '/', device: 'mobile', sessions: 5000, conversions: 0, revenue: 0 }], channels: [], range, valuePerConversion: 100, valueBasis: 'client_setting' })
  assert.equal(a.pages.length, 0)
  assert.ok(a.notes.some(n => /no conversions/.test(n)))
})

test('leakForUrl matches by path', () => {
  const a = computeLeaks({
    cells: [
      { page: '/', device: 'desktop', sessions: 3000, conversions: 120, revenue: 0 },
      { page: '/quote', device: 'desktop', sessions: 1000, conversions: 0, revenue: 0 }
    ], channels: [], range, valuePerConversion: 1, valueBasis: 'client_setting'
  })
  assert.equal(leakForUrl(a, 'https://www.acme.co.za/quote/?utm=x')?.page, '/quote')
  assert.equal(leakForUrl(a, 'https://acme.co.za/other'), null)
})
