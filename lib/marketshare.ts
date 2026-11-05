import { z } from 'zod'
import { structuredCall, webSearchCall } from './llm'
import { capturePage } from './capture'
import type { ScrapedContent } from './scraper'

// ============================================================
// Competitor audit — a lighter version of the main Fischer audit.
// Same scrape pipeline, shorter Claude prompt (score + top friction only,
// not the full revenue-impact/A-B-test depth), since this runs once per
// competitor and several competitors run per client.
// ============================================================
export interface CompetitorFrictionPoint {
  title: string
  severity: 'high' | 'medium' | 'low'
}

export interface CompetitorAuditResult {
  fischerScore: number
  rating: 'Critical' | 'Poor' | 'Average' | 'Good' | 'Excellent'
  topFrictionPoints: CompetitorFrictionPoint[]
}

const CompetitorSchema = z.object({
  fischerScore: z.number().describe('1-100'),
  rating: z.enum(['Critical', 'Poor', 'Average', 'Good', 'Excellent']),
  topFrictionPoints: z.array(z.object({
    title: z.string(),
    severity: z.enum(['high', 'medium', 'low'])
  })).describe('Top 3-5, evidence-based only.')
})

export async function runCompetitorAudit(
  url: string
): Promise<{ result: CompetitorAuditResult; scraped: ScrapedContent | null; scrapeError?: string }> {
  // Same real-browser capture as client audits (desktop only, for cost), so
  // competitor scores are comparable with the client's own.
  const capture = await capturePage(url, ['desktop'])
  const scrapeResult = capture.content
    ? { success: true as const, content: capture.content, error: undefined }
    : { success: false as const, content: undefined, error: capture.contentError || capture.desktop.error }
  const shots = capture.desktop.segments.slice(0, 3)

  const contentSection = scrapeResult.success
    ? `**PAGE CONTENT:**
- Title: ${scrapeResult.content!.title}
- Headings: ${scrapeResult.content!.headings.map(h => h.text).join(' | ') || '(none)'}
- CTAs found: ${scrapeResult.content!.ctaButtons.join(' | ') || '(none)'}
- Forms: ${scrapeResult.content!.forms.length}
- Trust signals: ${scrapeResult.content!.trustSignals.join(' | ') || '(none)'}
- Body sample: ${scrapeResult.content!.bodyTextSample.slice(0, 1500)}`
    : `**PAGE COULD NOT BE FETCHED:** ${scrapeResult.error}. Score conservatively and note the limitation — do not invent specifics.`

  const prompt = `You are Fischer, running a lightweight comparative CRO audit on a COMPETITOR's page (not the client's own page) — this is for competitive benchmarking, not a full audit. Score conversion health and identify the top 3-5 friction points only, using the same methodology as a standard Fischer audit but far more concise.

**COMPETITOR URL:** ${url}
${contentSection}

Only list friction points you can see in the screenshots or text.`

  const content = [
    ...shots.flatMap((sh, i) => [
      { type: 'text' as const, text: `Desktop section ${i + 1}:` },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: sh.base64 } }
    ]),
    { type: 'text' as const, text: prompt }
  ]
  const result = await structuredCall({
    schema: CompetitorSchema,
    system: 'You are Fischer — a CRO Intelligence Agent — running a fast comparative audit on a competitor page. Be concise and evidence-based; this is a benchmarking pass, not a full audit.',
    content,
    maxTokens: 8000,
    effort: 'medium'
  })
  result.fischerScore = Math.max(1, Math.min(100, Math.round(result.fischerScore)))

  return {
    result,
    scraped: scrapeResult.success ? scrapeResult.content! : null,
    scrapeError: scrapeResult.error
  }
}

// ============================================================
// Traffic estimation — Claude web_search as the zero-marginal-cost default.
// Indicative, not precise; good enough for "bigger or smaller than us."
// DataForSEO is the documented upgrade path for clients who need precision
// (~$0.60/1000 requests) — not built here, this stays free-tier by default.
// ============================================================
export interface TrafficEstimate {
  monthlyVisits: string   // kept as a string — "50k-100k" style ranges are honest, a fake precise number isn't
  source: 'web_search'
  confidence: 'low' | 'medium'
}

export async function estimateTraffic(url: string): Promise<TrafficEstimate> {
  const domain = new URL(url).hostname

  const raw = await webSearchCall(
    `Search for estimated monthly website traffic for ${domain}. Use SimilarWeb, Semrush, or any available public traffic data. End your answer with ONE line in the form "ESTIMATE: 50k-100k monthly visits" (or "ESTIMATE: Unknown").`
  )
  const estimate = raw.match(/ESTIMATE:\s*(.+)/i)?.[1]?.trim() || 'Unknown'

  return {
    monthlyVisits: estimate,
    source: 'web_search',
    confidence: estimate.toLowerCase().includes('unknown') ? 'low' : 'medium'
  }
}

// ============================================================
// Synthesis — the four-section market share output already proven out in
// the June build: Market Position, Competitive Gaps, Revenue Opportunity,
// Recovery Roadmap. This is what feeds the "Fischer Intelligence" slot in
// the monthly report (CRO SOP Section 09).
// ============================================================
export interface CompetitiveGap {
  competitor: string
  gap: string
  revenueOpportunity: string
}

export interface MarketShareSynthesis {
  marketPosition: string
  competitiveGaps: CompetitiveGap[]
  revenueOpportunity: string
  recoveryRoadmap: { step: number; description: string }[]
}

const SynthesisSchema = z.object({
  marketPosition: z.string().describe('2-3 sentences: where does the client sit in the competitive CRO landscape?'),
  competitiveGaps: z.array(z.object({ competitor: z.string(), gap: z.string(), revenueOpportunity: z.string() })),
  revenueOpportunity: z.string().describe('Overall estimated monthly revenue opportunity if the top gaps are closed.'),
  recoveryRoadmap: z.array(z.object({ step: z.number(), description: z.string() })).describe('Exactly 3 steps.')
})

export async function synthesizeMarketShare(params: {
  clientUrl: string
  clientScore: number
  monthlyTraffic?: string
  avgOrderValue?: string
  competitors: { name: string; url: string; score: number; topFrictionPoints: CompetitorFrictionPoint[]; traffic: TrafficEstimate }[]
}): Promise<MarketShareSynthesis> {
  const prompt = `You are Fischer's Market Intelligence layer. You have Fischer Score audits for a client and its named competitors. Generate a market share analysis.

**CLIENT:** ${params.clientUrl} — Fischer Score: ${params.clientScore}${params.monthlyTraffic ? ` — Monthly traffic: ${params.monthlyTraffic}` : ''}${params.avgOrderValue ? ` — AOV: R${params.avgOrderValue}` : ''}

**COMPETITORS:**
${params.competitors.map(c => `- ${c.name} (${c.url}): Fischer Score ${c.score}, ~${c.traffic.monthlyVisits} (${c.traffic.confidence} confidence). Top friction: ${c.topFrictionPoints.map(f => f.title).join(', ')}`).join('\n')}

Answer: where does the client sit competitively? Which specific CRO gaps are costing market share vs each competitor? What's the estimated monthly revenue opportunity if the top gaps are closed? What's a prioritised 3-step recovery roadmap?`

  return structuredCall({
    schema: SynthesisSchema,
    system: 'You are Fischer\'s Market Intelligence layer — commercial, specific, and grounded only in the scores and data given. Do not invent competitor details beyond what was provided.',
    content: prompt,
    maxTokens: 8000,
    effort: 'medium'
  })
}
