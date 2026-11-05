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

// Override per-deployment with FISCHER_MODEL if you want a cheaper tier
// (e.g. claude-sonnet-5-5) for high-volume scheduled re-audits.
export const FISCHER_MODEL = process.env.FISCHER_MODEL || 'claude-opus-5-5'

const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface StructuredCallOptions<S extends z.ZodType> {
  schema: S
  system: string
  content: Anthropic.Beta.BetaContentBlockParam[] | string
  maxTokens?: number
  effort?: Effort
}

export async function structuredCall<S extends z.ZodType>(
  opts: StructuredCallOptions<S>
): Promise<z.infer<S>> {
  // Streamed (then collected) so long audits with many screenshots can't hit
  // HTTP timeouts; adaptive thinking tokens count toward max_tokens.
  const stream = anthropic.beta.messages.stream({
    model: FISCHER_MODEL,
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
export async function webSearchCall(prompt: string, maxTokens = 2000): Promise<string> {
  const response = await anthropic.beta.messages.create({
    model: FISCHER_MODEL,
    max_tokens: maxTokens,
    output_config: { effort: 'low' },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
    messages: [{ role: 'user', content: prompt }],
    betas: [FALLBACK_BETA],
    fallbacks: 'default'
  })
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join(' ')
    .trim()
  return text
}
