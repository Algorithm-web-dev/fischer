import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import { structuredCall } from './llm'
import type { ScrapedContent } from './scraper'
import type { PageCapture, ViewportCapture } from './capture'
import type { PageSpeedResult } from './pagespeed'
import type { GA4AuditData } from './ga4-audit'
import type { ClarityResult } from './clarity'
import { formatGA4ForPrompt } from './ga4-audit'
import { formatClarityForPrompt } from './clarity'
import { computeRevenueImpact, planTest, type RevenueImpact, type TestPlan } from './stats'

export { anthropic, FISCHER_MODEL } from './llm'

// ============================================================
// What the model returns (validated against this schema)
// ============================================================

export const EVIDENCE_SOURCES = [
  'screenshot_desktop', 'screenshot_mobile', 'layout_measurements', 'page_content',
  'pagespeed', 'ga4', 'clarity'
] as const
export type EvidenceSource = typeof EVIDENCE_SOURCES[number]

const FrictionSchema = z.object({
  title: z.string().describe('Short, specific name of the problem, e.g. "Quote form asks for 9 fields before showing a price".'),
  severity: z.enum(['high', 'medium', 'low']),
  category: z.enum(['value_proposition', 'call_to_action', 'trust', 'form_friction', 'navigation', 'mobile', 'performance', 'content', 'technical', 'measurement']),
  location: z.string().describe('Where on the page, e.g. "Hero, desktop section 1" or "Quote form, mobile section 3".'),
  evidence: z.string().describe('The concrete observation this finding rests on: quote the exact on-page text, name the measured value, or describe what is visible in a named screenshot section. No evidence = do not include the finding.'),
  evidenceSources: z.array(z.enum(EVIDENCE_SOURCES)).describe('Which supplied data sources the evidence comes from.'),
  confidence: z.enum(['high', 'medium', 'low']).describe('high = directly observed or measured; medium = strongly implied by the data; low = plausible but not confirmed.'),
  issue: z.string(),
  whyItKillsConversion: z.string(),
  fix: z.string().describe('Exact and actionable — the precise copy, element or change.')
})

export const AuditOutputSchema = z.object({
  fischerScore: z.number().describe('1-100 overall conversion health of this page.'),
  scoreBreakdown: z.object({
    valueProposition: z.number(),
    callsToAction: z.number(),
    trust: z.number(),
    friction: z.number().describe('Higher = less friction.'),
    mobile: z.number(),
    performance: z.number()
  }).describe('Each 1-100.'),
  summary: z.string().describe('3-4 sentence executive overview a client can read.'),
  confidenceNote: z.string().describe('One or two sentences on data quality and what was or was not available.'),
  dataGaps: z.array(z.string()).describe('Things you could not assess because data was missing.'),
  strengths: z.array(z.object({ title: z.string(), evidence: z.string() })).describe('What already works well on this page (with evidence). Clients need to know what NOT to change.'),
  frictionPoints: z.array(FrictionSchema).describe('Only evidence-backed problems, most severe first. Fewer, well-evidenced findings beat padding — 0 to 10.'),
  previousIssueFollowUp: z.array(z.object({
    previousTitle: z.string(),
    status: z.enum(['resolved', 'improved', 'still_present', 'worse', 'cannot_verify']),
    evidence: z.string()
  })).describe('One entry per issue from the previous audit (empty if there was no previous audit).'),
  liftEstimate: z.object({
    conservativePct: z.number(),
    realisticPct: z.number(),
    aggressivePct: z.number(),
    rationale: z.string()
  }).describe('Relative conversion-rate lift (%) achievable by fixing the findings. Do NOT compute money — that is done in code.'),
  highestPriorityFix: z.string(),
  highestPriorityFixReason: z.string(),
  abTestHypotheses: z.array(z.object({
    name: z.string(),
    basedOnIssue: z.string().describe('Title of the friction point this test addresses.'),
    hypothesis: z.string().describe('"If [specific change], then [measurable outcome], because [evidence from this audit]".'),
    control: z.string().describe('Exact current state, quoting real on-page copy/elements.'),
    variant: z.string().describe('Exact change — specific copy, element, placement.'),
    primaryMetric: z.string(),
    secondaryMetric: z.string(),
    expectedLiftPct: z.number().describe('Expected relative lift of the primary metric, e.g. 8 for +8%.'),
    device: z.enum(['all', 'mobile', 'desktop']),
    effort: z.enum(['low', 'medium', 'high']),
    priority: z.number().describe('1 (highest) to 5.')
  })).describe('2-5 implementation-ready tests, tied to the findings.'),
  actionPlan: z.object({
    thisWeek: z.array(z.string()),
    thisMonth: z.array(z.string()),
    thisQuarter: z.array(z.string())
  })
})

export type AuditOutput = z.infer<typeof AuditOutputSchema>
export type FrictionPoint = z.infer<typeof FrictionSchema> & { verified?: boolean; validationNote?: string }
export type ABTestHypothesis = AuditOutput['abTestHypotheses'][number] & { plan?: TestPlan }

/** What we store in audits.output — the model output plus code-computed fields. */
export interface AuditResult extends Omit<AuditOutput, 'frictionPoints' | 'abTestHypotheses'> {
  frictionPoints: FrictionPoint[]
  unverifiedFindings: FrictionPoint[]
  abTestHypotheses: ABTestHypothesis[]
  revenueImpact: RevenueImpact
}

// ============================================================
// Prompt
// ============================================================

export const FISCHER_SYSTEM_PROMPT = `You are Fischer, Algorithm Agency's CRO (conversion rate optimisation) analyst. Your job: find the specific, evidenced reasons a page loses conversions and prescribe precise fixes a client will pay for.

## How you work
You audit the page AS RENDERED IN A REAL BROWSER. You receive:
1. Full-page screenshots, desktop and mobile, split into numbered sections from top to bottom. These are the source of truth for what visitors see.
2. Layout measurements taken from the live render (what is above the fold, CTA sizes/colours/positions, forms, overflow, small tap targets, broken images, JS errors).
3. Text extracted from the rendered DOM (headings, CTA labels, form fields, trust signals, body copy).
4. Where connected: Google PageSpeed (Core Web Vitals), GA4 analytics, Microsoft Clarity behaviour data.
5. Where available: the previous audit of this page and the changes logged since then.

## Evidence rules (most important)
- Every finding must rest on something you can point to: quoted on-page text, a measured value, a GA4/Clarity/PageSpeed number, or something visible in a named screenshot section ("mobile section 2"). Put that in "evidence" and list its sources.
- Do not report a problem because it is commonly true of websites. If you cannot see it or measure it here, it does not go in frictionPoints. Mention it under dataGaps if it matters.
- Text extraction can miss things (icons, images of text, iframes, widgets). Before claiming something is absent ("no reviews", "no phone number", "no CTA"), check the screenshots. If the screenshots show it, it is not missing.
- Do not invent numbers. Use only the analytics numbers supplied. If conversion tracking looks broken (e.g. zero conversions), that is itself a finding (category: measurement).
- It is fine — good, even — to return few findings on a strong page. List genuine strengths too.
- Be specific: quote the actual CTA text and propose the replacement copy; name the exact form field to remove; say which trust element goes where.

## Scoring
fischerScore and scoreBreakdown are 1-100. Be consistent across audits of the same page: the score should move only when the page or its performance data actually changed, so monthly comparisons mean something.

## Follow-up audits
If a previous audit is supplied, decide for EACH previous issue whether it is resolved, improved, still present, worse, or cannot be verified — based on the current screenshots and data, not on the change log alone. A logged change that is not visible on the page is "still_present".

## Money
Do not calculate revenue. Give realistic relative lift percentages (conservative / realistic / aggressive) with a rationale; the system computes money from real traffic and order values.`

export interface PreviousAuditContext {
  auditId: string
  completedAt: string
  fischerScore: number
  frictionPoints: { title: string; severity: string; location: string; fix: string }[]
}

export interface ChangeLogEntry {
  change_date: string
  title: string
  description?: string | null
  source: string
}

export interface AuditInput {
  clientName: string
  pageUrl: string
  pageType: string
  businessGoal: string
  // Manual analytics fallback for clients without GA4
  monthlyTraffic?: string
  currentConversionRate?: string
  avgOrderValue?: string
  deviceSplit?: string
  bounceRate?: string
  avgSessionDuration?: string
  topExitPages?: string
  additionalContext?: string
  clientId?: string
  manualHtml?: string
  manualScreenshotDesktop?: string
  manualScreenshotMobile?: string
}

export interface AuditContext {
  input: AuditInput
  capture: PageCapture
  pagespeed?: { mobile: PageSpeedResult; desktop: PageSpeedResult }
  ga4?: GA4AuditData | null
  clarity?: ClarityResult | null
  industry?: string | null
  currency?: string | null
  valuePerConversion?: number | null
  previous?: PreviousAuditContext | null
  changesSincePrevious?: ChangeLogEntry[]
}

export function buildAuditPrompt(ctx: AuditContext): string {
  const { input, capture } = ctx
  const currency = ctx.currency || 'ZAR'

  const parts: string[] = []
  parts.push(`Audit this page.

**CLIENT:** ${input.clientName}
**PAGE URL:** ${input.pageUrl}
**PAGE TYPE:** ${input.pageType}
**PRIMARY GOAL:** ${input.businessGoal}${ctx.industry ? `\n**INDUSTRY:** ${ctx.industry}` : ''}
**CURRENCY:** ${currency}`)

  parts.push(formatViewport(capture.desktop))
  parts.push(formatViewport(capture.mobile))
  parts.push(formatContent(capture.content, capture.contentSource, capture.contentError))
  parts.push(formatPageSpeedSection(ctx.pagespeed))

  if (ctx.ga4?.success) {
    parts.push(formatGA4ForPrompt(ctx.ga4))
  } else {
    const manual = [
      input.monthlyTraffic && `- Monthly traffic: ${input.monthlyTraffic}`,
      input.currentConversionRate && `- Conversion rate: ${input.currentConversionRate}%`,
      input.avgOrderValue && `- Average order / lead value: ${input.avgOrderValue} ${currency}`,
      input.deviceSplit && `- Device split: ${input.deviceSplit}`,
      input.bounceRate && `- Bounce rate: ${input.bounceRate}%`,
      input.avgSessionDuration && `- Avg session duration: ${input.avgSessionDuration}`,
      input.topExitPages && `- Top exit pages: ${input.topExitPages}`
    ].filter(Boolean)
    parts.push(ctx.ga4 && !ctx.ga4.success
      ? `**GA4 IS CONNECTED BUT FAILED:** ${ctx.ga4.error}${manual.length ? `\nManually supplied figures:\n${manual.join('\n')}` : ' — no analytics numbers available. Do not invent any.'}`
      : manual.length
        ? `**ANALYTICS (manually supplied by the account manager, not live):**\n${manual.join('\n')}`
        : `**NO ANALYTICS DATA.** Do not invent traffic or conversion numbers.`)
  }

  if (ctx.clarity?.success && ctx.clarity.data) {
    parts.push(formatClarityForPrompt(ctx.clarity))
  } else if (ctx.clarity && !ctx.clarity.success) {
    parts.push(`**CLARITY IS CONNECTED BUT FAILED:** ${ctx.clarity.error}. No behaviour data — do not invent any.`)
  } else {
    parts.push(`**NO CLARITY DATA** — no real-user behaviour signals. Do not invent rage-click or scroll metrics.`)
  }

  if (ctx.previous) {
    parts.push(`**PREVIOUS AUDIT (${ctx.previous.completedAt.slice(0, 10)}, Fischer Score ${ctx.previous.fischerScore}):**
${ctx.previous.frictionPoints.map((f, i) => `${i + 1}. [${f.severity}] ${f.title} — at ${f.location}. Recommended fix: ${f.fix}`).join('\n')}

Give a previousIssueFollowUp entry for every item above.`)
    if (ctx.changesSincePrevious?.length) {
      parts.push(`**CHANGES LOGGED SINCE THE PREVIOUS AUDIT** (verify against the screenshots — logged is not the same as live):
${ctx.changesSincePrevious.map(c => `- ${c.change_date}: ${c.title}${c.description ? ` — ${c.description}` : ''} (${c.source})`).join('\n')}`)
    }
  } else {
    parts.push(`**This is the first audit of this page** — previousIssueFollowUp must be empty.`)
  }

  if (input.additionalContext) parts.push(`**ADDITIONAL CONTEXT FROM THE ACCOUNT MANAGER:**\n${input.additionalContext}`)

  parts.push(`Cross-reference the sources. Findings confirmed by more than one source (e.g. Clarity dead clicks + a non-clickable element that looks like a button in the screenshot) are your highest-confidence findings.`)
  return parts.join('\n\n')
}

function formatViewport(v: ViewportCapture): string {
  const label = v.viewport.toUpperCase()
  if (!v.ok || v.segments.length === 0) {
    return `**${label} SCREENSHOTS: NOT AVAILABLE** (${v.error || 'capture failed'}). Make no visual claims about the ${v.viewport} layout.`
  }
  const l = v.layout
  const lines = [
    `**${label} (${v.width}px wide) — ${v.segments.length} screenshot section(s) attached above, covering ${v.segments.reduce((s, x) => s + x.height, 0)}px of a ${l?.pageHeight ?? '?'}px page${v.truncated ? ' (page is longer — the bottom was not captured)' : ''}.**`
  ]
  if (l) {
    lines.push(`Layout measurements from the live render (fold at ${l.viewportHeight}px):`)
    lines.push(`- H1 above the fold: ${l.h1AboveFold ? `"${l.h1AboveFold}"` : 'none'} (H1 count on page: ${l.h1Count})`)
    lines.push(`- CTAs above the fold: ${l.ctasAboveFold.length === 0 ? 'NONE detected' : l.ctasAboveFold.map(c => `"${c.text}" (${c.width}×${c.height}px at y=${c.top}, bg ${c.background}, text ${c.color}, ${c.fontSize}px)`).join('; ')}`)
    lines.push(`- Next CTAs further down: ${l.ctasBelowFold.slice(0, 8).map(c => `"${c.text}" at y=${c.top}`).join('; ') || 'none'}`)
    lines.push(`- Form above the fold: ${l.formAboveFold ? 'yes' : 'no'} · visible form fields on page: ${l.formFieldCount}`)
    lines.push(`- Sticky header: ${l.hasStickyHeader ? 'yes' : 'no'}${l.horizontalOverflow ? ' · HORIZONTAL OVERFLOW (page scrolls sideways)' : ''}${l.smallTapTargets ? ` · ${l.smallTapTargets} tap targets under 40px tall` : ''}${l.imagesBroken ? ` · ${l.imagesBroken} broken image(s)` : ''}`)
    if (l.popupsDetected.length) lines.push(`- Overlays: ${l.popupsDetected.join('; ')}`)
  }
  if (v.consoleErrors.length) lines.push(`- JavaScript errors in the console during load: ${v.consoleErrors.length} (e.g. "${v.consoleErrors[0]}")`)
  if (v.loadTimeMs) lines.push(`- Time to network-idle in our headless browser: ${(v.loadTimeMs / 1000).toFixed(1)}s (indicative only; use PageSpeed for real performance)`)
  return lines.join('\n')
}

function formatContent(c: ScrapedContent | null, source: string, error?: string): string {
  if (!c) {
    return `**PAGE TEXT COULD NOT BE EXTRACTED** (${error || 'unknown error'}). Rely on the screenshots for copy, and say so in confidenceNote.`
  }
  return `**TEXT EXTRACTED FROM THE ${source === 'rendered' ? 'RENDERED (post-JavaScript) DOM' : 'STATIC HTML — may be missing JavaScript-rendered content; trust the screenshots over this'}:**
- Title: ${c.title || '(none)'}
- Meta description: ${c.metaDescription || '(none)'}
- Word count: ${c.wordCount}
- Headings: ${c.headings.map(h => `[${h.level}] ${h.text}`).join(' | ') || '(none)'}
- Link/button labels that look like CTAs (includes navigation links): ${c.ctaButtons.join(' | ') || '(none)'}
- Forms: ${c.forms.length === 0 ? '(none in HTML)' : c.forms.map((f, i) => `Form ${i + 1}: ${f.fieldCount} fields (${f.fieldLabels.join(', ')}), submit "${f.submitText}"`).join(' / ')}
- Trust-related text: ${c.trustSignals.join(' | ') || '(none found in text — check screenshots for logos/badges/reviews)'}
- Images: ${c.imageCount} · Video: ${c.hasVideoEmbed ? 'yes' : 'no'}
- Body text (first ~3000 chars):
"""
${c.bodyTextSample}
"""`
}

function formatPageSpeedSection(ps?: { mobile: PageSpeedResult; desktop: PageSpeedResult }): string {
  if (!ps || (!ps.mobile.success && !ps.desktop.success)) {
    return `**PAGESPEED DATA NOT AVAILABLE** — make no claims about load times or Core Web Vitals.`
  }
  const f = (p: PageSpeedResult) => {
    if (!p.success) return `unavailable (${p.error || 'error'})`
    const bits = [`performance ${p.performanceScore ?? 'n/a'}/100`]
    if (p.lcp) bits.push(`LCP ${(p.lcp.value / 1000).toFixed(1)}s (${p.lcp.category})`)
    if (p.inp) bits.push(`INP ${p.inp.value}ms (${p.inp.category})`)
    if (p.cls) bits.push(`CLS ${p.cls.value} (${p.cls.category})`)
    bits.push(p.fieldDataAvailable ? 'real-user field data' : 'lab data only')
    return bits.join(', ')
  }
  return `**PAGESPEED INSIGHTS (Google):**\n- Mobile: ${f(ps.mobile)}\n- Desktop: ${f(ps.desktop)}\nIf mobile LCP is over 2.5s or the performance score is under 50, that is a finding with the metric as evidence.`
}

/** Screenshots go first (as image blocks), each labelled so the model can cite "mobile section 2". */
export function buildContentBlocks(ctx: AuditContext): Anthropic.Beta.BetaContentBlockParam[] {
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = []
  for (const v of [ctx.capture.desktop, ctx.capture.mobile]) {
    v.segments.forEach((s, i) => {
      blocks.push({ type: 'text', text: `${v.viewport.toUpperCase()} section ${i + 1} of ${v.segments.length} (page y ${s.y}–${s.y + s.height}px):` })
      blocks.push({ type: 'image', source: { type: 'base64', media_type: s.mediaType ?? 'image/jpeg', data: s.base64 } })
    })
  }
  blocks.push({ type: 'text', text: buildAuditPrompt(ctx) })
  return blocks
}

// ============================================================
// Post-processing (pure — unit tested)
// ============================================================

export function availableSources(ctx: AuditContext): Set<EvidenceSource> {
  const s = new Set<EvidenceSource>()
  if (ctx.capture.desktop.segments.length) s.add('screenshot_desktop')
  if (ctx.capture.mobile.segments.length) s.add('screenshot_mobile')
  if (ctx.capture.desktop.layout || ctx.capture.mobile.layout) s.add('layout_measurements')
  if (ctx.capture.content) s.add('page_content')
  if (ctx.pagespeed?.desktop.success || ctx.pagespeed?.mobile.success) s.add('pagespeed')
  if (ctx.ga4?.success) s.add('ga4')
  if (ctx.clarity?.success && (ctx.clarity.data?.totalSessions ?? 0) > 0) s.add('clarity')
  return s
}

/**
 * Splits findings into verified and unverified. A finding is unverified when it
 * cites no evidence, or only cites data sources that weren't actually supplied
 * (e.g. "Clarity shows..." when Clarity wasn't connected). Unverified findings
 * are kept for the team to review but excluded from client reports.
 */
export function validateFindings(points: FrictionPoint[], available: Set<EvidenceSource>) {
  const verified: FrictionPoint[] = []
  const unverified: FrictionPoint[] = []
  for (const p of points) {
    const sources = (p.evidenceSources || []).filter(s => available.has(s))
    const invalid = (p.evidenceSources || []).filter(s => !available.has(s))
    const hasEvidence = typeof p.evidence === 'string' && p.evidence.trim().length >= 15
    if (sources.length > 0 && hasEvidence) {
      verified.push({
        ...p, evidenceSources: sources, verified: true,
        validationNote: invalid.length ? `Ignored unavailable source(s): ${invalid.join(', ')}` : undefined
      })
    } else {
      unverified.push({
        ...p, verified: false,
        validationNote: !hasEvidence ? 'No concrete evidence given.' : `Cites only data that was not available in this audit (${invalid.join(', ')}).`
      })
    }
  }
  return { verified, unverified }
}

const clamp = (n: number, lo = 1, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)))

export interface ResolvedAnalytics {
  basis: 'ga4' | 'manual' | 'none'
  monthlySessions: number          // page-level when available, otherwise site
  conversionRatePct: number
  monthlyPageSessions: number      // for test planning
}

export function resolveAnalytics(ctx: AuditContext): ResolvedAnalytics {
  const ga = ctx.ga4
  if (ga?.success && ga.totals && ga.range) {
    const days = Math.max(1, (Date.parse(ga.range.endDate) - Date.parse(ga.range.startDate)) / 86400000 + 1)
    const scale = 30 / days
    const page = ga.page
    const pageSessions = page && page.sessions > 0 ? page.sessions * scale : 0
    return {
      basis: 'ga4',
      monthlySessions: Math.round(pageSessions || ga.totals.sessions * scale),
      conversionRatePct: page && page.sessions > 0 ? page.conversionRate : ga.totals.conversionRate,
      monthlyPageSessions: Math.round(pageSessions || (page?.views ?? 0) * scale)
    }
  }
  const traffic = parseFloat(String(ctx.input.monthlyTraffic || '').replace(/[^0-9.]/g, ''))
  const cvr = parseFloat(String(ctx.input.currentConversionRate || '').replace(/[^0-9.]/g, ''))
  if (traffic > 0 && cvr > 0) {
    return { basis: 'manual', monthlySessions: traffic, conversionRatePct: cvr, monthlyPageSessions: traffic }
  }
  return { basis: 'none', monthlySessions: 0, conversionRatePct: 0, monthlyPageSessions: 0 }
}

export function finaliseAudit(output: AuditOutput, ctx: AuditContext): AuditResult {
  const { verified, unverified } = validateFindings(output.frictionPoints, availableSources(ctx))
  const analytics = resolveAnalytics(ctx)

  const manualAov = parseFloat(String(ctx.input.avgOrderValue || '').replace(/[^0-9.]/g, ''))
  let valuePerConversion = ctx.valuePerConversion || manualAov || 0
  // For e-commerce with revenue tracked in GA4, derive value per conversion from real data.
  if (!valuePerConversion && ctx.ga4?.success && ctx.ga4.totals && ctx.ga4.totals.revenue > 0 && ctx.ga4.totals.conversions > 0) {
    valuePerConversion = Math.round(ctx.ga4.totals.revenue / ctx.ga4.totals.conversions)
  }

  const lifts = {
    conservative: Math.max(0, output.liftEstimate.conservativePct),
    realistic: Math.max(0, output.liftEstimate.realisticPct),
    aggressive: Math.max(0, output.liftEstimate.aggressivePct)
  }
  const revenueImpact = computeRevenueImpact({
    monthlyTraffic: analytics.monthlySessions,
    conversionRatePct: analytics.conversionRatePct,
    valuePerConversion,
    lifts,
    basis: analytics.basis,
    currency: ctx.currency || 'ZAR'
  })

  const abTestHypotheses: ABTestHypothesis[] = output.abTestHypotheses.map(h => {
    let plan: TestPlan | undefined
    if (analytics.conversionRatePct > 0) {
      try {
        plan = planTest({
          baselineRatePct: analytics.conversionRatePct,
          expectedLiftPct: h.expectedLiftPct,
          monthlyPageSessions: analytics.monthlyPageSessions,
          trafficShare: h.device === 'mobile' ? (ctx.ga4?.deviceSplit?.mobile ?? 60) / 100
            : h.device === 'desktop' ? (ctx.ga4?.deviceSplit?.desktop ?? 40) / 100 : 1
        })
      } catch { plan = undefined }
    }
    return { ...h, priority: clamp(h.priority, 1, 5), plan }
  }).sort((a, b) => a.priority - b.priority)

  const b = output.scoreBreakdown
  return {
    ...output,
    fischerScore: clamp(output.fischerScore),
    scoreBreakdown: {
      valueProposition: clamp(b.valueProposition), callsToAction: clamp(b.callsToAction), trust: clamp(b.trust),
      friction: clamp(b.friction), mobile: clamp(b.mobile), performance: clamp(b.performance)
    },
    frictionPoints: verified,
    unverifiedFindings: unverified,
    abTestHypotheses,
    revenueImpact
  }
}

export async function runFischerAudit(ctx: AuditContext): Promise<AuditResult> {
  const output = await structuredCall({
    schema: AuditOutputSchema,
    system: FISCHER_SYSTEM_PROMPT,
    content: buildContentBlocks(ctx),
    maxTokens: 48000,
    effort: 'high'
  })
  return finaliseAudit(output, ctx)
}
