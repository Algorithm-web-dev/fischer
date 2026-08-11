import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase'
import { anthropic, FISCHER_MODEL } from '@/lib/claude'
import type { AuditResult, ABTestHypothesis } from '@/lib/claude'
import Anthropic from '@anthropic-ai/sdk'

/**
 * Takes an A/B test hypothesis from a Fischer audit and expands it into
 * a full, implementation-ready test brief. This is what Luke (or a dev)
 * actually needs to build and launch the test — not just the raw hypothesis.
 *
 * The brief includes exact copy changes, element targeting, success metrics,
 * sample size estimates, and a timeline recommendation.
 */

export interface TestBrief {
  testName: string
  hypothesis: string        // "If X, then Y, because Z" format
  background: string        // what the audit found that prompted this test

  control: {
    description: string
    currentCopy: string     // exact text/element as it exists now
    screenshot_note: string // where to find this on the page
  }

  variant: {
    description: string
    newCopy: string         // exact replacement text/element
    changes: string[]       // bullet list of specific DOM/design changes
    implementation_notes: string  // CSS selectors, element IDs, or VWO/Optimizely targeting
  }

  metrics: {
    primary: string         // the one metric that decides win/loss
    secondary: string[]     // supporting metrics to watch
    guardrails: string[]    // metrics that must NOT degrade (e.g. revenue per visitor)
  }

  sizing: {
    estimatedLiftPct: number
    minimumDetectableEffect: string
    recommendedDuration: string
    trafficNeeded: string
  }

  effort: 'low' | 'medium' | 'high'
  priority: number
  recommendedTool: string   // VWO, Optimizely, Google Optimize alternative, or custom
}

const TEST_BRIEF_TOOL = {
  name: 'submit_test_brief',
  description: 'Submit the expanded A/B test brief.',
  input_schema: {
    type: 'object' as const,
    properties: {
      testName: { type: 'string' },
      hypothesis: { type: 'string' },
      background: { type: 'string' },
      control: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          currentCopy: { type: 'string' },
          screenshot_note: { type: 'string' }
        },
        required: ['description', 'currentCopy', 'screenshot_note']
      },
      variant: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          newCopy: { type: 'string' },
          changes: { type: 'array', items: { type: 'string' } },
          implementation_notes: { type: 'string' }
        },
        required: ['description', 'newCopy', 'changes', 'implementation_notes']
      },
      metrics: {
        type: 'object',
        properties: {
          primary: { type: 'string' },
          secondary: { type: 'array', items: { type: 'string' } },
          guardrails: { type: 'array', items: { type: 'string' } }
        },
        required: ['primary', 'secondary', 'guardrails']
      },
      sizing: {
        type: 'object',
        properties: {
          estimatedLiftPct: { type: 'number' },
          minimumDetectableEffect: { type: 'string' },
          recommendedDuration: { type: 'string' },
          trafficNeeded: { type: 'string' }
        },
        required: ['estimatedLiftPct', 'minimumDetectableEffect', 'recommendedDuration', 'trafficNeeded']
      },
      effort: { type: 'string', enum: ['low', 'medium', 'high'] },
      priority: { type: 'integer', minimum: 1, maximum: 5 },
      recommendedTool: { type: 'string' }
    },
    required: ['testName', 'hypothesis', 'background', 'control', 'variant', 'metrics', 'sizing', 'effort', 'priority', 'recommendedTool']
  }
}

export async function POST(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { auditId, hypothesisIndex, clientId } = await req.json()

  if (!auditId) {
    return NextResponse.json({ error: 'auditId is required.' }, { status: 400 })
  }

  // Load the audit and its hypothesis
  const { data: audit, error: auditError } = await supabase
    .from('audits')
    .select('*')
    .eq('id', auditId)
    .single()

  if (auditError || !audit?.output) {
    return NextResponse.json({ error: 'Audit not found or has no completed output.' }, { status: 404 })
  }

  const auditResult = audit.output as AuditResult
  const targetIndex = hypothesisIndex ?? 0
  const hypothesis = auditResult.abTestHypotheses?.[targetIndex]

  if (!hypothesis) {
    return NextResponse.json({ error: `No hypothesis found at index ${targetIndex}.` }, { status: 404 })
  }

  // Load client data for context
  const resolvedClientId = clientId || audit.client_id
  let clientData: any = null
  if (resolvedClientId) {
    const { data } = await supabase.from('clients').select('*').eq('id', resolvedClientId).single()
    clientData = data
  }

  try {
    const prompt = `You are Fischer's Test Brief Generator. You have a CRO audit's A/B test hypothesis and need to expand it into a full, implementation-ready test brief that a developer or CRO specialist can use to build and launch the test immediately.

**SOURCE AUDIT:**
- Client: ${audit.client_name}
- Page: ${audit.page_url}
- Fischer Score: ${auditResult.fischerScore}/100
- Page type: ${audit.page_type}
- Monthly traffic: ${auditResult.revenueImpact?.monthlyTraffic?.toLocaleString() || 'unknown'}
- Current CVR: ${auditResult.revenueImpact?.currentConversionRate || 'unknown'}%
${clientData?.industry ? `- Industry: ${clientData.industry}` : ''}

**HYPOTHESIS TO EXPAND:**
- Name: ${hypothesis.name}
- Hypothesis: ${hypothesis.hypothesis}
- Control: ${hypothesis.control}
- Variant: ${hypothesis.variant}
- Primary metric: ${hypothesis.primaryMetric}
- Estimated lift: ${hypothesis.estimatedLiftPct}
- Effort: ${hypothesis.effort}
- Priority: ${hypothesis.priority}/5

**RELEVANT FRICTION POINTS FROM THE AUDIT:**
${auditResult.frictionPoints.slice(0, 5).map(fp => `- [${fp.severity}] ${fp.title}: ${fp.issue} → Fix: ${fp.fix}`).join('\n')}

**SCRAPED PAGE CONTENT (for exact copy references):**
${audit.scraped_content ? `- Title: ${(audit.scraped_content as any).title || '(unknown)'}
- CTAs found: ${(audit.scraped_content as any).ctaButtons?.join(' | ') || '(none)'}
- Forms: ${(audit.scraped_content as any).forms?.length || 0}
- Headings: ${(audit.scraped_content as any).headings?.slice(0, 10).map((h: any) => h.text).join(' | ') || '(none)'}` : 'Not available'}

Expand this into a complete test brief. Be SPECIFIC:
- Quote the EXACT current copy/element for the control
- Write the EXACT replacement copy for the variant
- Include CSS selectors or element descriptions for targeting
- Calculate sample size based on the traffic and expected effect size
- Name specific GA4 events or goals for the primary metric
- Recommend a specific testing tool (VWO, custom split, etc.)

Submit via submit_test_brief.`

    const response = await anthropic.messages.create({
      model: FISCHER_MODEL,
      max_tokens: 3000,
      system: 'You are Fischer\'s Test Brief Generator. You produce implementation-ready A/B test briefs — specific enough that a developer can build the test from your output alone without needing to ask follow-up questions.',
      messages: [{ role: 'user', content: prompt }],
      tools: [TEST_BRIEF_TOOL],
      tool_choice: { type: 'tool', name: 'submit_test_brief' }
    })

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    )

    if (!toolUse) {
      throw new Error('Test brief generation did not return a structured result.')
    }

    const brief = toolUse.input as TestBrief

    // Persist the brief
    const { data: briefRow, error: insertError } = await supabase
      .from('test_briefs')
      .insert({
        client_id: resolvedClientId,
        source_audit_id: auditId,
        hypothesis_name: brief.testName,
        brief,
        status: 'draft',
        created_by: user.id
      })
      .select()
      .single()

    if (insertError) {
      console.error('Failed to persist test brief:', insertError)
    }

    return NextResponse.json({
      briefId: briefRow?.id,
      brief
    })
  } catch (err) {
    console.error('Test brief generation error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Test brief generation failed.' },
      { status: 500 }
    )
  }
}

export async function GET(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const clientId = req.nextUrl.searchParams.get('clientId')

  let query = supabase
    .from('test_briefs')
    .select('*')
    .order('created_at', { ascending: false })

  if (clientId) query = query.eq('client_id', clientId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ briefs: data })
}
