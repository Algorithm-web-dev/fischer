import Anthropic from '@anthropic-ai/sdk'
import { anthropic, FISCHER_MODEL } from './claude'
import { scrapePage } from './scraper'
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

const COMPETITOR_TOOL_SCHEMA = {
  name: 'submit_competitor_audit',
  description: 'Submit the lightweight comparative CRO audit for this competitor.',
  input_schema: {
    type: 'object' as const,
    properties: {
      fischerScore: { type: 'integer', minimum: 1, maximum: 100 },
      rating: { type: 'string', enum: ['Critical', 'Poor', 'Average', 'Good', 'Excellent'] },
      topFrictionPoints: {
        type: 'array', minItems: 3, maxItems: 5,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] }
          },
          required: ['title', 'severity']
        }
      }
    },
    required: ['fischerScore', 'rating', 'topFrictionPoints']
  }
}

export async function runCompetitorAudit(
  url: string
): Promise<{ result: CompetitorAuditResult; scraped: ScrapedContent | null; scrapeError?: string }> {
  const scrapeResult = await scrapePage(url)

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

Submit your assessment via the submit_competitor_audit tool.`

  const response = await anthropic.messages.create({
    model: FISCHER_MODEL,
    max_tokens: 1024,
    system: 'You are Fischer — a CRO Intelligence Agent — running a fast comparative audit on a competitor page. Be concise; this is a benchmarking pass, not a full audit.',
    messages: [{ role: 'user', content: prompt }],
    tools: [COMPETITOR_TOOL_SCHEMA],
    tool_choice: { type: 'tool', name: 'submit_competitor_audit' }
  })

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
  )
  if (!toolUse) throw new Error('Competitor audit did not return a structured result.')

  return {
    result: toolUse.input as CompetitorAuditResult,
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

  const response = await anthropic.messages.create({
    model: FISCHER_MODEL,
    max_tokens: 300,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }] as any,
    messages: [{
      role: 'user',
      content: `Search for estimated monthly website traffic for ${domain}. Use SimilarWeb, Semrush, or any available public traffic data. Respond with ONLY a short estimate like "50k-100k monthly visits" or "under 10k monthly visits (low confidence)" — no other commentary.`
    }]
  })

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
  const estimate = textBlock?.text.trim() || 'Unknown'

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

const SYNTHESIS_TOOL_SCHEMA = {
  name: 'submit_market_share_analysis',
  description: 'Submit the synthesised market share / competitive intelligence analysis.',
  input_schema: {
    type: 'object' as const,
    properties: {
      marketPosition: { type: 'string', description: '2-3 sentences: where does the client sit in the competitive CRO landscape?' },
      competitiveGaps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            competitor: { type: 'string' },
            gap: { type: 'string' },
            revenueOpportunity: { type: 'string' }
          },
          required: ['competitor', 'gap', 'revenueOpportunity']
        }
      },
      revenueOpportunity: { type: 'string', description: 'Overall estimated monthly revenue opportunity if the top gaps are closed.' },
      recoveryRoadmap: {
        type: 'array', minItems: 3, maxItems: 3,
        items: {
          type: 'object',
          properties: { step: { type: 'integer' }, description: { type: 'string' } },
          required: ['step', 'description']
        }
      }
    },
    required: ['marketPosition', 'competitiveGaps', 'revenueOpportunity', 'recoveryRoadmap']
  }
}

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

Answer: where does the client sit competitively? Which specific CRO gaps are costing market share vs each competitor? What's the estimated monthly revenue opportunity if the top gaps are closed? What's a prioritised 3-step recovery roadmap?

Submit via submit_market_share_analysis.`

  const response = await anthropic.messages.create({
    model: FISCHER_MODEL,
    max_tokens: 2048,
    system: 'You are Fischer\'s Market Intelligence layer — commercial, specific, and grounded only in the scores and data given. Do not invent competitor details beyond what was provided.',
    messages: [{ role: 'user', content: prompt }],
    tools: [SYNTHESIS_TOOL_SCHEMA],
    tool_choice: { type: 'tool', name: 'submit_market_share_analysis' }
  })

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
  )
  if (!toolUse) throw new Error('Market share synthesis did not return a structured result.')

  return toolUse.input as MarketShareSynthesis
}
