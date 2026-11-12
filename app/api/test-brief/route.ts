import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createSupabaseServerClient } from '@/lib/supabase'
import { structuredCall } from '@/lib/llm'
import type { AuditResult } from '@/lib/claude'

export const maxDuration = 120

/**
 * Expands one A/B test hypothesis from an audit into an implementation-ready
 * test brief (exact copy, targeting, metrics), and creates the test record
 * that results are later entered against (PATCH /api/tests/[id]).
 *
 * Sample size and duration come from lib/stats.ts (computed from the page's
 * real traffic at audit time), not from the model.
 */
const TestBriefSchema = z.object({
  testName: z.string(),
  hypothesis: z.string().describe('"If X, then Y, because Z"'),
  background: z.string().describe('What the audit found that prompted this test.'),
  control: z.object({
    description: z.string(),
    currentCopy: z.string().describe('Exact text/element as it exists now.'),
    screenshot_note: z.string().describe('Where to find it on the page (viewport + section).')
  }),
  variant: z.object({
    description: z.string(),
    newCopy: z.string().describe('Exact replacement text/element.'),
    changes: z.array(z.string()),
    implementation_notes: z.string().describe('CSS selectors / element targeting for the testing tool.')
  }),
  metrics: z.object({
    primary: z.string().describe('The one metric that decides win/loss — name the GA4 event.'),
    secondary: z.array(z.string()),
    guardrails: z.array(z.string()).describe('Metrics that must not degrade.')
  }),
  qaChecklist: z.array(z.string()).describe('What to check before launching (devices, tracking firing, flicker).'),
  effort: z.enum(['low', 'medium', 'high']),
  recommendedTool: z.string()
})
export type TestBrief = z.infer<typeof TestBriefSchema>

export async function POST(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { auditId, hypothesisIndex, clientId } = await req.json()
  if (!auditId) return NextResponse.json({ error: 'auditId is required.' }, { status: 400 })

  const { data: audit } = await supabase.from('audits').select('*').eq('id', auditId).single()
  if (!audit?.output) return NextResponse.json({ error: 'Audit not found or has no completed output.' }, { status: 404 })

  const auditResult = audit.output as AuditResult
  const idx = hypothesisIndex ?? 0
  const hypothesis = auditResult.abTestHypotheses?.[idx]
  if (!hypothesis) return NextResponse.json({ error: `No hypothesis at index ${idx}.` }, { status: 404 })

  const resolvedClientId = clientId || audit.client_id
  if (!resolvedClientId) return NextResponse.json({ error: 'This audit has no client — attach it to a client first.' }, { status: 400 })
  const { data: client } = await supabase.from('clients').select('*').eq('id', resolvedClientId).single()

  const related = auditResult.frictionPoints.find(f => f.title === hypothesis.basedOnIssue)
  const sc = audit.scraped_content as any

  const prompt = `Expand this CRO A/B test hypothesis into a complete, implementation-ready brief a developer can build without follow-up questions.

**PAGE:** ${audit.page_url} (${audit.page_type}) for ${audit.client_name}${client?.industry ? `, industry: ${client.industry}` : ''}
**CURRENT CONVERSION RATE:** ${auditResult.revenueImpact?.currentConversionRate ?? 'unknown'}% · monthly sessions ${auditResult.revenueImpact?.monthlyTraffic?.toLocaleString() ?? 'unknown'}
${client?.ga4_conversion_event ? `**CONVERSION EVENT IN GA4:** ${client.ga4_conversion_event}` : ''}

**HYPOTHESIS:**
- Name: ${hypothesis.name}
- ${hypothesis.hypothesis}
- Control: ${hypothesis.control}
- Variant: ${hypothesis.variant}
- Primary metric: ${hypothesis.primaryMetric} · Secondary: ${hypothesis.secondaryMetric}
- Device: ${hypothesis.device} · Expected lift: ${hypothesis.expectedLiftPct}%
${hypothesis.plan ? `- Test plan (computed): ${hypothesis.plan.note}` : ''}

${related ? `**THE FINDING IT ADDRESSES:** [${related.severity}] ${related.title} — ${related.issue}\nEvidence: ${related.evidence}\nRecommended fix: ${related.fix}` : ''}

**REAL PAGE COPY (for exact references):**
- Headings: ${sc?.headings?.slice(0, 12).map((h: any) => h.text).join(' | ') || '(unknown)'}
- CTA labels: ${sc?.ctaButtons?.join(' | ') || '(unknown)'}
- Forms: ${sc?.forms?.map((f: any) => `${f.fieldCount} fields (${f.fieldLabels.join(', ')}), submit "${f.submitText}"`).join(' / ') || 'none'}

Quote the exact current copy for the control and write the exact new copy for the variant. Do not calculate sample sizes; they are provided separately.`

  try {
    const brief = await structuredCall({
      track: { feature: 'test_brief', clientId: resolvedClientId, auditId },
      schema: TestBriefSchema,
      system: 'You are Fischer\'s Test Brief Generator. You produce implementation-ready A/B test briefs grounded in the real page copy you are given.',
      content: prompt,
      maxTokens: 12000,
      effort: 'medium'
    })

    const { data: row, error } = await supabase.from('test_briefs').insert({
      client_id: resolvedClientId,
      source_audit_id: auditId,
      page_url: audit.page_url,
      hypothesis_name: brief.testName,
      hypothesis,
      brief,
      status: 'draft',
      created_by: user.id
    }).select().single()
    if (error) throw new Error(`Saving test failed: ${error.message}`)

    return NextResponse.json({ briefId: row.id, test: row, brief })
  } catch (err) {
    console.error('Test brief generation error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Test brief generation failed.' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  let query = supabase.from('test_briefs').select('*').order('created_at', { ascending: false })
  if (clientId) query = query.eq('client_id', clientId)
  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ briefs: data })
}
