import type { SupabaseClient } from '@supabase/supabase-js'
import { runAuditPipeline, type ClientRow } from './audit-pipeline'
import type { AuditInput } from './claude'
import { raiseAlert } from './alerts'
import { logError } from './errors'

/**
 * Background audit queue.
 *
 * An audit row with status "queued" is a job. /api/cron/worker (every minute)
 * claims jobs with claim_next_audit() — an atomic UPDATE … FOR UPDATE SKIP
 * LOCKED — so several workers can run in parallel without double-processing.
 * Failures are retried (up to MAX_ATTEMPTS); jobs whose worker died mid-run
 * are reclaimed after 10 minutes.
 */
export const MAX_ATTEMPTS = 3

export async function enqueueAudit(supabase: SupabaseClient, job: {
  input: AuditInput
  client: ClientRow | null
  trigger: 'manual' | 'scheduled'
  trackedPageId?: string | null
  createdBy?: string | null
}): Promise<string> {
  const { data, error } = await supabase.from('audits').insert({
    client_id: job.client?.id ?? null,
    client_name: job.client?.name ?? job.input.clientName,
    page_url: job.input.pageUrl,
    page_type: job.input.pageType,
    business_goal: job.input.businessGoal,
    input_data: job.input,
    status: 'queued',
    queued_at: new Date().toISOString(),
    trigger: job.trigger,
    tracked_page_id: job.trackedPageId ?? null,
    created_by: job.createdBy ?? null
  }).select('id').single()
  if (error || !data) throw new Error(`Could not queue audit: ${error?.message}`)
  return data.id
}

/** Claims and runs one job. Returns null when the queue is empty. Use the service-role client. */
export async function processNextJob(supabase: SupabaseClient): Promise<{ auditId: string; status: string; error?: string } | null> {
  const { data: claimed, error } = await supabase.rpc('claim_next_audit', { max_attempts: MAX_ATTEMPTS })
  if (error) throw new Error(`Queue claim failed: ${error.message}`)
  const job = (claimed as any[] | null)?.[0]
  if (!job) return null

  let client: ClientRow | null = null
  if (job.client_id) {
    const { data } = await supabase.from('clients').select('*').eq('id', job.client_id).single()
    client = data
  }
  const input = job.input_data as AuditInput
  try {
    const outcome = await runAuditPipeline({ supabase, auditId: job.id, input, client, trackedPageId: job.tracked_page_id, trigger: job.trigger })
    if (outcome.status === 'needs_manual_input' && client && job.trigger === 'scheduled') {
      await raiseAlert(supabase, {
        clientId: client.id, clientName: client.name, type: 'audit_needs_input', severity: 'medium',
        dedupeKey: `audit_input:${job.tracked_page_id ?? job.page_url}`,
        title: 'Scheduled audit needs manual input',
        message: `${job.page_url}: ${Object.values(outcome.confidence.reasons).join(' · ')}`,
        link: `/audit?view=${job.id}`
      })
    }
    return { auditId: job.id, status: outcome.status }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await logError('queue:audit', err, { clientId: client?.id, auditId: job.id, attempt: job.attempts })
    const final = job.attempts >= MAX_ATTEMPTS
    await supabase.from('audits').update({
      status: final ? 'failed' : 'queued',
      error_message: final ? msg : `Attempt ${job.attempts} failed, will retry: ${msg}`,
      locked_at: null,
      // back off: retry after the jobs already waiting
      queued_at: new Date().toISOString()
    }).eq('id', job.id)
    if (final && client) {
      await raiseAlert(supabase, {
        clientId: client.id, clientName: client.name, type: 'audit_failed', severity: 'medium',
        dedupeKey: `audit_failed:${job.tracked_page_id ?? job.page_url}`,
        title: 'Audit failed after 3 attempts', message: `${job.page_url}: ${msg}`, link: `/audit?view=${job.id}`
      })
    }
    return { auditId: job.id, status: final ? 'failed' : 'retrying', error: msg }
  }
}
