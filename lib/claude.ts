import Anthropic from '@anthropic-ai/sdk'
import type { ScrapedContent } from './scraper'

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!
})

// Current model alias — do not hardcode a dated snapshot string here again;
// aliases get routed to the current recommended version automatically.
export const FISCHER_MODEL = 'claude-sonnet-4-6'

// ============================================================
// Structured output schema
// Claude fills this via forced tool-use (see runFischerAudit below),
// not free-form markdown. This is what makes the frontend reliable —
// any consumer (this app's UI, a Lovable-built UI, the backlog sync)
// gets typed JSON instead of parsing headers out of prose.
// ============================================================
export interface FrictionPoint {
  title: string
  severity: 'high' | 'medium' | 'low'
  location: string
  issue: string
  whyItKillsConversion: string
  fix: string
}

export interface RevenueImpact {
  monthlyTraffic: number
  currentConversionRate: number
  currentMonthlyConversions: number
  currentMonthlyRevenue: number
  conservativeLiftPct: number
  conservativeAdditionalRevenue: number
  realisticLiftPct: number
  realisticAdditionalRevenue: number
  aggressiveLiftPct: number
  aggressiveAdditionalRevenue: number
  highestPriorityFix: string
  highestPriorityFixReason: string
}

export interface ABTestHypothesis {
  name: string
  hypothesis: string
  control: string
  variant: string
  primaryMetric: string
  secondaryMetric: string
  estimatedLiftPct: string
  effort: 'low' | 'medium' | 'high'
  priority: number
}

export interface PriorityActionPlan {
  thisWeek: string[]
  thisMonth: string[]
  thisQuarter: string[]
}

export interface AuditResult {
  fischerScore: number // 1-100 overall conversion health
  summary: string
  confidenceNote: string // flags if the scrape was incomplete/JS-rendered — see scraper.ts
  frictionPoints: FrictionPoint[]
  revenueImpact: RevenueImpact
  abTestHypotheses: ABTestHypothesis[]
  actionPlan: PriorityActionPlan
}

const AUDIT_TOOL_SCHEMA = {
  name: 'submit_fischer_audit',
  description: 'Submit the completed structured CRO audit.',
  input_schema: {
    type: 'object' as const,
    properties: {
      fischerScore: { type: 'integer', minimum: 1, maximum: 100, description: 'Overall conversion health score.' },
      summary: { type: 'string', description: '3-4 sentence executive overview.' },
      confidenceNote: {
        type: 'string',
        description: 'One sentence on data quality — e.g. flag if the page appeared to be JS-rendered and content may be incomplete.'
      },
      frictionPoints: {
        type: 'array', minItems: 5, maxItems: 10,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            location: { type: 'string' },
            issue: { type: 'string' },
            whyItKillsConversion: { type: 'string' },
            fix: { type: 'string', description: 'Exact, specific, actionable — the precise copy/element/change.' }
          },
          required: ['title', 'severity', 'location', 'issue', 'whyItKillsConversion', 'fix']
        }
      },
      revenueImpact: {
        type: 'object',
        properties: {
          monthlyTraffic: { type: 'number' },
          currentConversionRate: { type: 'number' },
          currentMonthlyConversions: { type: 'number' },
          currentMonthlyRevenue: { type: 'number' },
          conservativeLiftPct: { type: 'number' },
          conservativeAdditionalRevenue: { type: 'number' },
          realisticLiftPct: { type: 'number' },
          realisticAdditionalRevenue: { type: 'number' },
          aggressiveLiftPct: { type: 'number' },
          aggressiveAdditionalRevenue: { type: 'number' },
          highestPriorityFix: { type: 'string' },
          highestPriorityFixReason: { type: 'string' }
        },
        required: ['monthlyTraffic', 'currentConversionRate', 'currentMonthlyRevenue',
          'conservativeAdditionalRevenue', 'realisticAdditionalRevenue', 'aggressiveAdditionalRevenue',
          'highestPriorityFix', 'highestPriorityFixReason']
      },
      abTestHypotheses: {
        type: 'array', minItems: 3, maxItems: 5,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            hypothesis: { type: 'string' },
            control: { type: 'string' },
            variant: { type: 'string' },
            primaryMetric: { type: 'string' },
            secondaryMetric: { type: 'string' },
            estimatedLiftPct: { type: 'string' },
            effort: { type: 'string', enum: ['low', 'medium', 'high'] },
            priority: { type: 'integer', minimum: 1, maximum: 5 }
          },
          required: ['name', 'hypothesis', 'control', 'variant', 'primaryMetric', 'effort', 'priority']
        }
      },
      actionPlan: {
        type: 'object',
        properties: {
          thisWeek: { type: 'array', items: { type: 'string' } },
          thisMonth: { type: 'array', items: { type: 'string' } },
          thisQuarter: { type: 'array', items: { type: 'string' } }
        },
        required: ['thisWeek', 'thisMonth', 'thisQuarter']
      }
    },
    required: ['fischerScore', 'summary', 'confidenceNote', 'frictionPoints', 'revenueImpact', 'abTestHypotheses', 'actionPlan']
  }
}

export const FISCHER_SYSTEM_PROMPT = `You are Fischer, Algorithm Agency's AI-powered CRO (Conversion Rate Optimisation) specialist. You are named after Bobby Fischer — the chess grandmaster renowned for seeing the single precise move that changes the entire game. Your job is identical: find the exact friction points costing a business revenue, and prescribe precise, high-impact fixes.

## DATA SOURCES YOU HAVE ACCESS TO

Fischer now connects to multiple live data sources. Each audit may include any combination of:

1. **Scraped page content** — real HTML fetched server-side (headings, CTA text, forms, trust signals, body copy). This is the actual page, not a search snippet.
2. **Screenshots** — real above-the-fold captures at desktop (1440×900) and mobile (375×812) viewports. You literally see the page as a user would.
3. **Google PageSpeed Insights** — real Core Web Vitals (LCP, INP, CLS) from Google's own testing infrastructure.
4. **Google Analytics 4 (live API pull)** — real traffic, conversion rate, bounce rate, device split, exit pages, traffic sources. These are NOT manually typed estimates — they come directly from the GA4 Data API minutes before this audit ran.
5. **Microsoft Clarity (live API pull)** — real user frustration signals: rage clicks, dead clicks, excessive scrolling, quick-back clicks, JavaScript errors, scroll depth. This is actual human behaviour data from real sessions.

When Clarity data shows specific frustration signals (rage clicks > 3%, dead clicks > 10%, quick-backs > 15%), these MUST appear in your friction points — they are hard evidence of a problem, not a theory.

## ANALYSIS RULES

You analyse the ACTUAL page content provided to you and cross-reference it with all available data sources. You do not guess at what a page probably contains — you work from the real extracted content given to you. If any data source is missing or incomplete, say so in your confidenceNote rather than inventing detail.

When screenshots are provided, use them for what text alone cannot tell you: is the primary CTA actually the most visually prominent element? Is there enough contrast? Is the page cluttered above the fold? Does mobile meaningfully differ from desktop?

You must be SPECIFIC. Never say "improve your CTA" — say exactly what the CTA should say and why, quoting the actual current CTA text. Never say "reduce friction" — name the exact field from the actual form data. Never say "add trust signals" — name what type, where, and what copy.

When GA4 data is provided, use the REAL numbers for revenue impact calculations — do not estimate traffic or conversion rate when you have the actual figures. When Clarity data shows a frustration signal, cite it directly: "Clarity shows a 12% rage click rate on the pricing section" is actionable; "users may find pricing confusing" is not.

## A/B TEST HYPOTHESES

Your A/B test hypotheses must be implementation-ready, not vague ideas:
- **control**: Describe the EXACT current state, referencing actual page elements you can see
- **variant**: Describe the EXACT change — specific copy, specific element, specific placement
- **primaryMetric**: Name the exact GA4 metric or conversion event to track
- **hypothesis**: Use the format "If [specific change], then [measurable outcome], because [evidence from this audit]"
- **estimatedLiftPct**: Ground this in the severity of the problem — a rage-click-inducing CTA rewrite has higher potential than a copy tweak

Calculate all revenue figures in South African Rands (ZAR) unless the client data indicates otherwise.

Submit your completed audit using the submit_fischer_audit tool. Do not respond in free text — the tool call is your entire output.`

export interface AuditInput {
  clientName: string
  pageUrl: string
  pageType: string
  businessGoal: string

  // --- Analytics: auto-pulled from GA4 when client has ga4_property_id,
  // OR manually typed via the form as a fallback for clients without GA4 ---
  monthlyTraffic: string
  currentConversionRate: string
  avgOrderValue: string
  deviceSplit: string
  bounceRate: string
  avgSessionDuration: string
  topExitPages: string
  additionalContext: string

  // --- Client record ID for auto-pulling integrations ---
  clientId?: string

  // --- Manual capture override (see lib/scraper.ts parseHtml) ---
  manualHtml?: string
  manualScreenshotDesktop?: string
  manualScreenshotMobile?: string
}

import type { PageSpeedResult } from './pagespeed'
import type { GA4AuditData } from './ga4-audit'
import type { ClarityPageData } from './clarity'
import { formatGA4ForPrompt } from './ga4-audit'
import { formatClarityForPrompt } from './clarity'

export interface AuditPromptOptions {
  input: AuditInput
  scraped: ScrapedContent | null
  scrapeError?: string
  hasScreenshots?: boolean
  pagespeed?: { mobile: PageSpeedResult; desktop: PageSpeedResult }
  ga4Data?: GA4AuditData
  clarityData?: { data: ClarityPageData; isPageLevel: boolean }
  industry?: string
  currency?: string
}

export function buildAuditPrompt(opts: AuditPromptOptions): string {
  const { input, scraped, scrapeError, hasScreenshots, pagespeed, ga4Data, clarityData, industry, currency } = opts

  const scrapedSection = scraped
    ? `**ACTUAL PAGE CONTENT (scraped server-side, this is real — not a guess):**
- Page title: ${scraped.title}
- Meta description: ${scraped.metaDescription || '(none)'}
- Word count: ${scraped.wordCount}${scraped.fetchedWithJs ? ' — LOW WORD COUNT RELATIVE TO PAGE SIZE: this page may be JS-rendered and this scrape may be missing content normally shown after client-side rendering. Flag this in your confidenceNote.' : ''}
- Headings: ${scraped.headings.map(h => `[${h.level}] ${h.text}`).join(' | ') || '(none found)'}
- CTA button/link text found: ${scraped.ctaButtons.join(' | ') || '(none found)'}
- Forms found: ${scraped.forms.length === 0 ? '(none found)' : scraped.forms.map((f, i) =>
    `Form ${i + 1}: ${f.fieldCount} fields (${f.fieldLabels.join(', ')}), submit button says "${f.submitText}"`).join(' / ')}
- Trust signals found on page: ${scraped.trustSignals.join(' | ') || '(none found)'}
- Images: ${scraped.imageCount}, Video embed present: ${scraped.hasVideoEmbed ? 'yes' : 'no'}
- Body text sample (first ~3000 characters of visible text):
"""
${scraped.bodyTextSample}
"""`
    : `**PAGE CONTENT COULD NOT BE FETCHED:** ${scrapeError || 'Unknown error'}. You have NO real page content for this audit — do not invent specifics about page copy, CTAs, or forms. Base your audit only on the analytics data provided, be explicit in confidenceNote that this is a data-only audit with no visual/content inspection, and keep friction point recommendations to general, defensible CRO principles rather than page-specific claims.`

  const screenshotNote = hasScreenshots
    ? `\n**SCREENSHOTS PROVIDED:** Desktop and mobile above-the-fold screenshots are attached to this message, ahead of this text prompt. Use them to judge visual hierarchy, CTA prominence, contrast, and clutter — reference specific visual observations, not generic design advice.\n`
    : `\n**NO SCREENSHOTS PROVIDED:** You are working from text/DOM data only for this audit. Do not make claims about visual hierarchy, color, contrast, or clutter — you cannot see the page. Confine friction points to what the text/DOM data actually supports, and note the lack of visual inspection in your confidenceNote.\n`

  const pagespeedSection = pagespeed
    ? `\n**PAGE SPEED (Google PageSpeed Insights, real data):**
- Desktop: ${formatPageSpeed(pagespeed.desktop)}
- Mobile: ${formatPageSpeed(pagespeed.mobile)}
A slow page can be the single biggest conversion killer even when copy/CTA/forms are all fine — if either score above is poor, this MUST appear as one of your friction points, with the specific metric cited.\n`
    : `\n**PAGE SPEED DATA NOT AVAILABLE for this audit — do not make claims about load time or Core Web Vitals.**\n`

  // Analytics: prefer live GA4 data over manually typed fields
  const analyticsSection = ga4Data?.success
    ? formatGA4ForPrompt(ga4Data)
    : `**ANALYTICS DATA (manually provided — not live from GA4):**
- Monthly traffic: ${input.monthlyTraffic} visitors
- Current conversion rate: ${input.currentConversionRate}%
- Average order/lead value: ${currency === 'ZAR' || !currency ? 'R' : currency}${input.avgOrderValue}
- Device split: ${input.deviceSplit}
- Bounce rate: ${input.bounceRate}%
- Average session duration: ${input.avgSessionDuration}
- Top exit pages: ${input.topExitPages}`

  // Clarity: real user behaviour data
  const claritySection = clarityData
    ? '\n' + formatClarityForPrompt(clarityData.data, clarityData.isPageLevel)
    : '\n**NO CLARITY DATA AVAILABLE — no real user behaviour signals for this audit. Do not invent frustration metrics.**'

  const industryNote = industry ? `\n**INDUSTRY:** ${industry} — use industry-specific conversion benchmarks where relevant.` : ''

  const currencyNote = currency && currency !== 'ZAR'
    ? `\n**CURRENCY:** Calculate all revenue figures in ${currency}.`
    : '\n**CURRENCY:** Calculate all revenue figures in South African Rands (ZAR).'

  return `Run a full Fischer CRO audit on the following page.

**CLIENT:** ${input.clientName}
**PAGE URL:** ${input.pageUrl}
**PAGE TYPE:** ${input.pageType}
**PRIMARY BUSINESS GOAL:** ${input.businessGoal}${industryNote}${currencyNote}
${screenshotNote}${pagespeedSection}
${scrapedSection}

${analyticsSection}
${claritySection}

**ADDITIONAL CONTEXT:**
${input.additionalContext || 'None provided.'}

Analyse ALL the data above — page content, screenshots, PageSpeed, analytics, Clarity user behaviour — and cross-reference them. Look for patterns where multiple data sources confirm the same problem (e.g. Clarity rage clicks on an element + scraper showing that element has weak copy + screenshot showing it's visually buried). These multi-source confirmations are your highest-confidence friction points.

Submit a complete Fischer audit via the submit_fischer_audit tool.`
}

function formatPageSpeed(ps: PageSpeedResult): string {
  if (!ps.success) return `unavailable (${ps.error || 'unknown error'})`
  const parts = [`Performance score ${ps.performanceScore ?? 'N/A'}/100`]
  if (ps.lcp) parts.push(`LCP ${ps.lcp.value}ms (${ps.lcp.category})`)
  if (ps.inp) parts.push(`INP ${ps.inp.value}ms (${ps.inp.category})`)
  if (ps.cls) parts.push(`CLS ${ps.cls.value} (${ps.cls.category})`)
  parts.push(ps.fieldDataAvailable ? '[real-user field data]' : '[lab data only, no real-user data available]')
  return parts.join(', ')
}

/**
 * Runs the audit as a single non-streaming call and returns parsed, typed
 * output. Forced tool-use guarantees a submit_fischer_audit call — no
 * markdown parsing, no silent breakage if wording varies.
 *
 * Screenshots (if provided) go in as real image content blocks ahead of the
 * text prompt — Claude sees the actual rendered page, not just a text
 * description of what a scraper found in the DOM.
 */
export async function runFischerAudit(
  input: AuditInput,
  scraped: ScrapedContent | null,
  scrapeError?: string,
  screenshots?: { viewport: 'desktop' | 'mobile'; base64: string; mediaType?: string }[],
  pagespeed?: { mobile: PageSpeedResult; desktop: PageSpeedResult },
  ga4Data?: GA4AuditData,
  clarityData?: { data: ClarityPageData; isPageLevel: boolean },
  industry?: string,
  currency?: string
): Promise<AuditResult> {
  const prompt = buildAuditPrompt({
    input,
    scraped,
    scrapeError,
    hasScreenshots: screenshots && screenshots.length > 0,
    pagespeed,
    ga4Data,
    clarityData,
    industry,
    currency
  })

  const content: Anthropic.MessageParam['content'] = []

  if (screenshots && screenshots.length > 0) {
    for (const shot of screenshots) {
      content.push({ type: 'text', text: `Screenshot below is the ${shot.viewport} above-the-fold view:` })
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: (shot.mediaType ?? 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: shot.base64
        }
      })
    }
  }

  content.push({ type: 'text', text: prompt })

  const response = await anthropic.messages.create({
    model: FISCHER_MODEL,
    max_tokens: 16000,
    system: FISCHER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    tools: [AUDIT_TOOL_SCHEMA],
    tool_choice: { type: 'tool', name: 'submit_fischer_audit' }
  })

  if (response.stop_reason === 'max_tokens') {
    throw new Error('Fischer output was truncated before the audit completed - raise max_tokens.')
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
  )

  if (!toolUse) {
    throw new Error('Fischer did not return a structured audit — no tool_use block in response.')
  }

  const result = toolUse.input as AuditResult

  if (!Array.isArray(result.frictionPoints) || result.frictionPoints.length === 0) {
    throw new Error('Fischer returned an audit with no friction points - output was incomplete.')
  }
  if (!result.revenueImpact || typeof result.fischerScore !== 'number') {
    throw new Error('Fischer returned an incomplete audit - missing revenue impact or score.')
  }

  return result
}
