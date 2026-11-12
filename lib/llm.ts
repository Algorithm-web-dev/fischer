import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { z } from 'zod'

/**
 * Single place every Claude call in Fischer goes through.
 *
 * - Structured output via `output_config.format` (JSON schema generated from a
 *   Zod schema and validated on the way back). The current models reject the
 *   old "forced tool_choice" trick this codebase used to rely on, and
 *   structured outputs are the supported way to get guaranteed-valid JSON.
 * - Server-side refusal fallback (`fallbacks: "default"`) so an over-cautious
 *   safety decline on a perfectly normal CRO request is retried on a fallback
 *   model inside the same call instead of failing the audit.
 */

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
})

// Model for audits a person runs (baselines, ad-hoc) and other analysis calls.
export const FISCHER_MODEL = process.env.FISCHER_MODEL || 'claude-opus-5-5'
// Routine monthly re-audits run on the cheaper Sonnet tier by default (roughly
// half the cost of Opus); baselines and manual audits use FISCHER_MODEL.
export const FISCHER_SCHEDULED_MODEL = process.env.FISCHER_SCHEDULED_MODEL || 'claude-sonnet-5-5'

const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** What a call was for — recorded with its token usage and cost (llm_usage table). */
export interface UsageTag { feature: string; clientId?: string | null; auditId?: string | null }

export interface StructuredCallOptions<S extends z.ZodType> {
  schema: S
  system: string
  content: Anthropic.Beta.BetaContentBlockParam[] | string
  maxTokens?: number
  effort?: Effort
  model?: string
  track?: UsageTag
}

// USD per million tokens (input, output). Cache reads bill at 10% of input,
// cache writes at 125%. Update when pricing changes; unknown models are
// recorded with cost 0 and their token counts.
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'claude-fable-5-1': { in: 10, out: 50 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 }
}
const WEB_SEARCH_USD = 0.01 // per search

export function costUsd(model: string, u: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }, webSearches = 0): number {
  const p = PRICES[model] ?? Object.entries(PRICES).find(([k]) => model.startsWith(k))?.[1]
  if (!p) return Math.round(webSearches * WEB_SEARCH_USD * 10000) / 10000
  const cost = ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out
    + (u.cache_read_input_tokens ?? 0) * p.in * 0.1 + (u.cache_creation_input_tokens ?? 0) * p.in * 1.25) / 1_000_000
    + webSearches * WEB_SEARCH_USD
  return Math.round(cost * 10000) / 10000
}

async function recordUsage(tag: UsageTag | undefined, response: { model: string; usage: any }) {
  if (!tag) return
  try {
    const { createSupabaseServiceClient } = await import('./supabase')
    const u = response.usage ?? {}
    const searches = u.server_tool_use?.web_search_requests ?? 0
    await createSupabaseServiceClient().from('llm_usage').insert({
      feature: tag.feature, client_id: tag.clientId ?? null, audit_id: tag.auditId ?? null, model: response.model,
      input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0, cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      web_searches: searches, cost_usd: costUsd(response.model, u, searches)
    })
  } catch (err) {
    console.error('[fischer] could not record usage:', err)
  }
}

export async function structuredCall<S extends z.ZodType>(
  opts: StructuredCallOptions<S>
): Promise<z.infer<S>> {
  // Streamed (then collected) so long audits with many screenshots can't hit
  // HTTP timeouts; adaptive thinking tokens count toward max_tokens.
  const stream = anthropic.beta.messages.stream({
    model: opts.model ?? FISCHER_MODEL,
    max_tokens: opts.maxTokens ?? 32000,
    system: opts.system,
    messages: [{ role: 'user', content: opts.content }],
    output_config: {
      effort: opts.effort ?? 'high',
      format: betaZodOutputFormat(opts.schema)
    },
    betas: [FALLBACK_BETA],
    fallbacks: 'default'
  })
  const response = await stream.finalMessage()
  await recordUsage(opts.track, response)

  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined this request (refusal).')
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('The model ran out of output tokens before finishing — raise maxTokens.')
  }
  if (response.parsed_output == null) {
    throw new Error('The model did not return output matching the expected schema.')
  }
  return response.parsed_output as z.infer<S>
}

/** Plain-text call with the web search server tool (used for traffic estimates). */
export async function webSearchCall(prompt: string, maxTokens = 2000, track?: UsageTag): Promise<string> {
  const response = await anthropic.beta.messages.create({
    model: FISCHER_MODEL,
    max_tokens: maxTokens,
    output_config: { effort: 'low' },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
    messages: [{ role: 'user', content: prompt }],
    betas: [FALLBACK_BETA],
    fallbacks: 'default'
  })
  await recordUsage(track, response)
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join(' ')
    .trim()
  return text
}
