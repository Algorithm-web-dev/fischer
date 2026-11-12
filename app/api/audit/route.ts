import { NextRequest, NextResponse } from 'next/server'
import type { AuditInput } from '@/lib/claude'
import { runAuditPipeline, stripDataPrefix, type ClientRow } from '@/lib/audit-pipeline'
import { detectImageType } from '@/lib/capture'
import { createSupabaseServerClient } from '@/lib/supabase'
import { auditRateLimit, checkRateLimit } from '@/lib/ratelimit'
import { isValidHttpUrl } from '@/lib/validate'
import { enqueueAudit, BACKGROUND_WORKER } from '@/lib/queue'
import { logError } from '@/lib/errors'

// Full-page capture at two viewports + PageSpeed + model call. Needs a Vercel
// plan that allows functions longer than 60s (Pro: up to 300s; 800s with Fluid compute).
export const maxDuration = 300

interface AuditRequestBody extends AuditInput {
  auditId?: string
  /** true → queue the audit and return immediately; poll GET /api/audits/[id] for the result */
  async?: boolean
}

export async function POST(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const input: AuditRequestBody = await req.json()
  if (!input.pageUrl || !isValidHttpUrl(input.pageUrl)) {
    return NextResponse.json({ error: 'A valid page URL (http/https, public host) is required.' }, { status: 400 })
  }

  for (const [label, img] of [['desktop', input.manualScreenshotDesktop], ['mobile', input.manualScreenshotMobile]] as const) {
    if (img && !detectImageType(stripDataPrefix(img))) {
      return NextResponse.json({ error: `The ${label} screenshot must be a JPEG, PNG, WebP or GIF image.` }, { status: 400 })
    }
  }

  let client: ClientRow | null = null
  if (input.clientId) {
    const { data } = await supabase.from('clients').select('*').eq('id', input.clientId).single()
    if (!data) return NextResponse.json({ error: 'Client not found.' }, { status: 404 })
    client = data
    input.clientName = data.name
  }
  if (!input.clientName) return NextResponse.json({ error: 'clientName or clientId is required.' }, { status: 400 })

  let auditId: string
  if (input.auditId) {
    const { data: existing } = await supabase.from('audits')
      .select('id, status').eq('id', input.auditId).single()
    if (!existing) return NextResponse.json({ error: 'Audit not found.' }, { status: 404 })
    if (existing.status !== 'needs_manual_input') {
      return NextResponse.json({ error: 'This audit is not awaiting manual input.' }, { status: 400 })
    }
    auditId = existing.id
    await supabase.from('audits').update({ status: 'running' }).eq('id', auditId)
  } else {
    const { allowed, resetAt } = await checkRateLimit(auditRateLimit, user.id)
    if (!allowed) {
      return NextResponse.json({ error: `Rate limit reached. Try again after ${new Date(resetAt).toLocaleTimeString()}.` }, { status: 429 })
    }
    // Queue mode (recommended): returns at once, a worker runs it within ~1 minute.
    // Manual screenshots/HTML (resubmissions) always run inline.
    // (Without the per-minute worker — Hobby plan — audits run immediately instead.)
    if (input.async && BACKGROUND_WORKER && !input.manualHtml && !input.manualScreenshotDesktop && !input.manualScreenshotMobile) {
      const { async: _a, auditId: _id, ...jobInput } = input
      const id = await enqueueAudit(supabase, { input: jobInput, client, trigger: 'manual', createdBy: user.id })
      return NextResponse.json({ auditId: id, status: 'queued' }, { status: 202 })
    }

    const { data: row, error } = await supabase.from('audits').insert({
      client_id: client?.id ?? null,
      client_name: input.clientName,
      page_url: input.pageUrl,
      page_type: input.pageType,
      business_goal: input.businessGoal,
      input_data: { ...input, manualHtml: undefined, manualScreenshotDesktop: undefined, manualScreenshotMobile: undefined },
      status: 'running',
      trigger: 'manual',
      created_by: user.id
    }).select('id').single()
    if (error || !row) {
      console.error('Failed to create audit row:', error)
      return NextResponse.json({ error: 'Could not start audit — database error.' }, { status: 500 })
    }
    auditId = row.id
  }

  try {
    const outcome = await runAuditPipeline({ supabase, auditId, input, client })
    if (outcome.status === 'needs_manual_input') {
      const c = outcome.confidence
      return NextResponse.json({
        auditId,
        status: 'needs_manual_input',
        needsManualHtml: !c.htmlOk,
        needsManualDesktop: !c.desktopOk,
        needsManualMobile: !c.mobileOk,
        reasons: c.reasons
      })
    }
    return NextResponse.json({
      auditId,
      status: 'complete',
      dataSources: outcome.dataSources,
      screenshots: outcome.screenshots,
      pageDiff: outcome.pageDiff,
      result: outcome.result
    })
  } catch (err) {
    await logError('api:audit', err, { clientId: client?.id, auditId })
    await supabase.from('audits').update({
      status: 'failed',
      error_message: err instanceof Error ? err.message : 'Unknown error'
    }).eq('id', auditId)
    return NextResponse.json({ error: 'Fischer hit an error running this audit. Please try again.', detail: err instanceof Error ? err.message : undefined, auditId }, { status: 500 })
  }
}
