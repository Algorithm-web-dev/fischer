import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeBenchmarks, band, normaliseIndustry, MIN_CLIENTS } from '../lib/benchmarks'
import { computeLeaks } from '../lib/leaks'
import { summariseLibrary, tagTest, type LibraryEntry } from '../lib/test-library'

const client = (id: string, industry: string | null, sessions: number, conversions: number, mobile?: [number, number], desktop?: [number, number]) => ({
  clientId: id, industry, sessions, conversions,
  devices: { ...(mobile ? { mobile: { sessions: mobile[0], conversions: mobile[1] } } : {}), ...(desktop ? { desktop: { sessions: desktop[0], conversions: desktop[1] } } : {}) }
})

test('industry benchmark needs at least 3 qualifying clients (anonymity)', () => {
  const b = computeBenchmarks([
    client('a', 'Automotive', 10000, 200), client('b', 'automotive ', 10000, 300),
    client('c', 'Solar', 10000, 100)
  ], ['2026-08', '2026-09', '2026-10'])
  assert.equal(MIN_CLIENTS, 3)
  assert.equal(b.industries.length, 0)
  assert.ok(b.allClients) // 3 clients overall
})

test('median, quartiles and device medians per industry; tiny sites excluded', () => {
  const b = computeBenchmarks([
    client('a', 'Automotive', 10000, 100, [6000, 30], [4000, 70]),    // 1%
    client('b', 'automotive', 10000, 200, [6000, 60], [4000, 140]),   // 2%
    client('c', 'AUTOMOTIVE', 10000, 300, [6000, 120], [4000, 180]),  // 3%
    client('d', 'automotive', 500, 50)                                // too small, ignored
  ], [])
  const a = b.industries[0]
  assert.equal(a.industry, 'automotive')
  assert.equal(a.overall.clients, 3)
  assert.equal(a.overall.median, 2)
  assert.equal(a.overall.p25, 1.5)
  assert.equal(a.devices.mobile.median, 1)
  assert.equal(a.devices.desktop.median, 3.5)
  assert.equal(band(1.2, a.overall), 'bottom quarter')
  assert.equal(band(2.9, a.overall), 'top quarter')
  assert.equal(normaliseIndustry('  Real  Estate '), 'real estate')
})

test('benchmark floor reveals leaks on a uniformly weak site', () => {
  const cells = [
    { page: '/', device: 'mobile', sessions: 5000, conversions: 25, revenue: 0 },     // 0.5%
    { page: '/quote', device: 'mobile', sessions: 5000, conversions: 25, revenue: 0 } // 0.5%
  ]
  const range = { startDate: '2026-10-01', endDate: '2026-10-30' }
  const own = computeLeaks({ cells, channels: [], range, valuePerConversion: 1000, valueBasis: 'client_setting' })
  assert.equal(own.pages.length, 0) // every page equals the site average → nothing to see
  const floored = computeLeaks({ cells, channels: [], range, valuePerConversion: 1000, valueBasis: 'client_setting', targetFloors: { mobile: 1.6 } })
  assert.equal(floored.pages.length, 2)
  assert.equal(floored.pages[0].cells[0].targetRate, 1.6)
  assert.equal(floored.pages[0].cells[0].lostConversions, 55) // 5000 × 1.1%
})

test('tests are tagged by what they changed', () => {
  assert.deepEqual(tagTest('Shorten quote form to 4 fields').sort(), ['form'])
  assert.ok(tagTest('Sticky mobile CTA button').includes('mobile'))
  assert.ok(tagTest('Sticky mobile CTA button').includes('cta'))
  assert.deepEqual(tagTest('Something unusual'), ['other'])
})

test('library summary: win rate and average winning lift per change type', () => {
  const e = (tags: string[], winner: LibraryEntry['winner'], lift: number | null): LibraryEntry =>
    ({ id: Math.random().toString(), industry: 'solar', pageType: null, tags, name: 'n', change: '', winner, relativeLift: lift, confidence: 95, endDate: null })
  const s = summariseLibrary([e(['form'], 'variant', 20), e(['form'], 'variant', 10), e(['form'], 'none', 1), e(['form'], 'control', -8), e(['trust'], 'none', 2)])
  const form = s.find(x => x.tag === 'form')!
  assert.equal(form.tests, 4)
  assert.equal(form.wins, 2)
  assert.equal(form.winRate, 50)
  assert.equal(form.avgWinningLift, 15)
  assert.equal(s[0].tag, 'form')
})
