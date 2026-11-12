import { z } from 'zod'
import { structuredCall } from './llm'

/**
 * The 10 PXL-style criteria — binary (yes/no) rather than subjective 1-10
 * scales, per the CRO SOP Section 04. This is what separates PXL from ICE:
 * objective, checkable questions instead of a gut-feel number. Weights are
 * asymmetric because not every criterion carries equal evidence — e.g. an
 * above-the-fold change genuinely matters more than a low-effort binary.
 */
export const PXL_CRITERIA = [
  { key: 'aboveTheFold', question: 'Is the change above the fold?', weight: 2 },
  { key: 'addsOrRemoves', question: 'Does it add or remove an element, rather than just restyling one?', weight: 1 },
  { key: 'qualitativeEvidence', question: 'Was this idea prompted by qualitative research (session recordings, heatmaps, user feedback) rather than a hunch?', weight: 2 },
  { key: 'addressesFriction', question: 'Does it address a specific friction/anxiety point identified in the audit data?', weight: 2 },
  { key: 'noticedQuickly', question: 'Will a visitor notice this change within about 5 seconds of landing on the page?', weight: 1 },
  { key: 'strengthensValueProp', question: 'Does it strengthen the core value proposition rather than a peripheral element?', weight: 2 },
  { key: 'reducesCognitiveLoad', question: 'Does it reduce cognitive load or simplify a decision the visitor has to make?', weight: 1 },
  { key: 'alignedWithGoal', question: 'Is it directly aligned with the primary conversion goal of this specific page?', weight: 2 },
  { key: 'highTrafficArea', question: 'Does the audit data show this is a high-traffic or high-exposure area of the page?', weight: 1 },
  { key: 'testableHypothesis', question: 'Is there a clear, falsifiable hypothesis behind this change (if X, then Y, because Z)?', weight: 2 }
] as const

export interface PxlScore {
  criteria: Record<string, boolean>   // key -> yes/no
  reasoning: Record<string, string>   // key -> one-line justification, so the score is auditable
  totalScore: number                 // sum of weights for every "yes"
  maxPossibleScore: number            // sum of all weights — lets you compare items fairly
}

const MAX_POSSIBLE_SCORE = PXL_CRITERIA.reduce((sum, c) => sum + c.weight, 0)

const PxlSchema = z.object({
  criteria: z.object(Object.fromEntries(PXL_CRITERIA.map(c => [c.key, z.boolean()])) as Record<string, z.ZodBoolean>),
  reasoning: z.object(Object.fromEntries(PXL_CRITERIA.map(c => [c.key, z.string()])) as Record<string, z.ZodString>)
})

/**
 * Scores a single backlog item against the PXL criteria, grounded in the
 * evidence already attached to it (the audit's friction point description
 * and evidence_refs) — not scored in the abstract from the title alone.
 */
export async function scorePxl(params: {
  title: string
  description: string
  evidenceType: string
  auditContext?: string  // e.g. the source friction point's full context, if available
}): Promise<PxlScore> {
  const prompt = `Score the following CRO backlog item against 10 objective PXL criteria. Answer each with a strict yes/no based only on the evidence given — if the evidence doesn't clearly support "yes," answer "no." Do not be generous; PXL's value comes from being harder to game than a subjective 1-10 scale.

**BACKLOG ITEM:** ${params.title}
**DESCRIPTION:** ${params.description}
**EVIDENCE TYPE:** ${params.evidenceType}
${params.auditContext ? `**AUDIT CONTEXT:**\n${params.auditContext}` : ''}

**CRITERIA:**
${PXL_CRITERIA.map((c, i) => `${i + 1}. ${c.question}`).join('\n')}

Return one boolean and one short reasoning sentence per criterion.`

  const { criteria, reasoning } = await structuredCall({
    track: { feature: 'pxl_score' },
    schema: PxlSchema,
    system: 'You are Fischer scoring a CRO hypothesis against the PXL prioritization framework. Be strict and evidence-based — an unclear case is a "no," not a generous "yes."',
    content: prompt,
    maxTokens: 8000,
    effort: 'low'
  })

  const totalScore = PXL_CRITERIA.reduce((sum, c) => sum + (criteria[c.key] ? c.weight : 0), 0)

  return { criteria, reasoning, totalScore, maxPossibleScore: MAX_POSSIBLE_SCORE }
}
