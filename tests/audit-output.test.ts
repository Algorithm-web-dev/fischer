import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateFindings, finaliseAudit, availableSources, buildAuditPrompt, type AuditContext, type AuditOutput, type FrictionPoint } from '../lib/claude'
import type { PageCapture } from '../lib/capture'

function capture(): PageCapture {
  const seg = [{ index: 0, y: 0, height: 1800, base64: 'x' }]
  return {
    desktop: { viewport: 'desktop', ok: true, width: 1440, segments: seg, truncated: false, consoleErrors: [], failedRequests: 0 },
    mobile: { viewport: 'mobile', ok: true, width: 390, segments: seg, truncated: false, consoleErrors: [], failedRequests: 0 },
    content: { url: 'u', title: 't', metaDescription: '', headings: [], ctaButtons: [], forms: [], trustSignals: [], bodyTextSample: '', wordCount: 300, imageCount: 0, hasVideoEmbed: false, fetchedWithJs: false },
    contentSource: 'rendered'
  }
}

const fp = (over: Partial<FrictionPoint>): FrictionPoint => ({
  title: 'CTA below the fold on mobile', severity: 'high', category: 'call_to_action', location: 'Hero, mobile section 1',
  evidence: 'Layout measurements show no CTA above the 844px fold on mobile; first CTA "Get a quote" at y=1210.',
  evidenceSources: ['layout_measurements', 'screenshot_mobile'], confidence: 'high',
  issue: 'i', whyItKillsConversion: 'w', fix: 'f', ...over
})

test('findings citing only unavailable data are moved to unverified', () => {
  const ctx: AuditContext = { input: { clientName: 'c', pageUrl: 'https://a.com', pageType: 'p', businessGoal: 'g' }, capture: capture() }
  const avail = availableSources(ctx)
  assert.equal(avail.has('clarity'), false)
  const { verified, unverified } = validateFindings([
    fp({}),
    fp({ title: 'Rage clicks on pricing', evidenceSources: ['clarity'], evidence: 'Clarity shows 12% rage clicks on the pricing toggle.' }),
    fp({ title: 'Vague', evidence: 'n/a' })
  ], avail)
  assert.equal(verified.length, 1)
  assert.equal(unverified.length, 2)
  assert.match(unverified[0].validationNote!, /not available/)
  assert.match(unverified[1].validationNote!, /No concrete evidence/)
})

test('mixed sources keep the finding but drop the invented source', () => {
  const ctx: AuditContext = { input: { clientName: 'c', pageUrl: 'https://a.com', pageType: 'p', businessGoal: 'g' }, capture: capture() }
  const { verified } = validateFindings([fp({ evidenceSources: ['screenshot_desktop', 'ga4'] })], availableSources(ctx))
  assert.deepEqual(verified[0].evidenceSources, ['screenshot_desktop'])
  assert.match(verified[0].validationNote!, /ga4/)
})

const output: AuditOutput = {
  fischerScore: 140, scoreBreakdown: { valueProposition: 60, callsToAction: 40, trust: 70, friction: 50, mobile: 0, performance: 55 },
  summary: 's', confidenceNote: 'c', dataGaps: [], strengths: [], frictionPoints: [fp({})], previousIssueFollowUp: [],
  liftEstimate: { conservativePct: 5, realisticPct: 10, aggressivePct: 18, rationale: 'r' },
  highestPriorityFix: 'h', highestPriorityFixReason: 'r',
  abTestHypotheses: [
    { name: 'B', basedOnIssue: 'x', hypothesis: 'h', control: 'c', variant: 'v', primaryMetric: 'm', secondaryMetric: 's', expectedLiftPct: 15, device: 'mobile', effort: 'low', priority: 9 },
    { name: 'A', basedOnIssue: 'x', hypothesis: 'h', control: 'c', variant: 'v', primaryMetric: 'm', secondaryMetric: 's', expectedLiftPct: 10, device: 'all', effort: 'low', priority: 1 }
  ],
  actionPlan: { thisWeek: [], thisMonth: [], thisQuarter: [] }
}

test('finalise clamps scores, computes money from manual figures and plans tests', () => {
  const ctx: AuditContext = {
    input: { clientName: 'c', pageUrl: 'https://a.com', pageType: 'p', businessGoal: 'g', monthlyTraffic: '20 000', currentConversionRate: '2.5', avgOrderValue: 'R1,200' },
    capture: capture(), currency: 'ZAR'
  }
  const r = finaliseAudit(output, ctx)
  assert.equal(r.fischerScore, 100)
  assert.equal(r.scoreBreakdown.mobile, 1)
  assert.equal(r.revenueImpact.basis, 'manual')
  assert.equal(r.revenueImpact.currentMonthlyRevenue, 20000 * 0.025 * 1200)
  assert.equal(r.revenueImpact.realisticAdditionalRevenue, 60000)
  assert.equal(r.abTestHypotheses[0].name, 'A') // sorted by priority
  assert.equal(r.abTestHypotheses[1].priority, 5) // clamped
  assert.ok(r.abTestHypotheses[0].plan)
})

test('no analytics → no invented money', () => {
  const ctx: AuditContext = { input: { clientName: 'c', pageUrl: 'https://a.com', pageType: 'p', businessGoal: 'g' }, capture: capture() }
  const r = finaliseAudit(output, ctx)
  assert.equal(r.revenueImpact.basis, 'none')
  assert.equal(r.revenueImpact.currentMonthlyRevenue, 0)
  assert.equal(r.abTestHypotheses[0].plan, undefined)
})

test('prompt includes previous issues and logged changes on a follow-up audit', () => {
  const ctx: AuditContext = {
    input: { clientName: 'c', pageUrl: 'https://a.com', pageType: 'p', businessGoal: 'g' }, capture: capture(),
    previous: { auditId: 'p1', completedAt: '2026-10-01T00:00:00Z', fischerScore: 52, frictionPoints: [{ title: 'Nine-field quote form', severity: 'high', location: 'Form', fix: 'Cut to 4 fields' }] },
    changesSincePrevious: [{ change_date: '2026-10-12', title: 'Quote form reduced to 4 fields', source: 'backlog' }]
  }
  const p = buildAuditPrompt(ctx)
  assert.match(p, /Nine-field quote form/)
  assert.match(p, /Quote form reduced to 4 fields/)
  assert.match(p, /logged is not the same as live/)
})
