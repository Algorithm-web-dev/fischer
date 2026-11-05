import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Alerts — things the team should act on between monthly reports.
 * Raised by: weekly journey checks, audits (tracking broke), monthly
 * snapshots (conversion drop), guardrails, scheduled audits that failed.
 *
 * Each open alert has a dedupe key, so a problem that persists is raised
 * once (not every day) until someone resolves it. If ALERT_WEBHOOK_URL is
 * set (Slack/Teams/Google Chat incoming webhook, or any URL accepting
 * {"text": "..."}), new alerts are posted there too.
 */
export interface NewAlert {
  clientId: string | null
  clientName?: string
  type: 'journey_failed' | 'tracking_broken' | 'conversion_drop' | 'guardrail_breach' | 'audit_needs_input' | 'audit_failed'
  dedupeKey: string
  severity?: 'high' | 'medium' | 'low'
  title: string
  message?: string
  link?: string
  details?: unknown
}

export async function raiseAlert(supabase: SupabaseClient, a: NewAlert): Promise<{ created: boolean }> {
  const { data: open } = await supabase.from('alerts').select('id').eq('dedupe_key', a.dedupeKey).is('resolved_at', null).limit(1)
  if (open?.length) return { created: false }
  const { data, error } = await supabase.from('alerts').insert({
    client_id: a.clientId, type: a.type, dedupe_key: a.dedupeKey, severity: a.severity ?? 'high',
    title: a.title, message: a.message ?? null, link: a.link ?? null, details: a.details ?? null
  }).select('id').single()
  if (error || !data) return { created: false } // unique index race → already open
  if (await notify(a)) await supabase.from('alerts').update({ notified_at: new Date().toISOString() }).eq('id', data.id)
  return { created: true }
}

export async function resolveAlerts(supabase: SupabaseClient, dedupeKey: string) {
  await supabase.from('alerts').update({ resolved_at: new Date().toISOString() }).eq('dedupe_key', dedupeKey).is('resolved_at', null)
}

async function notify(a: NewAlert): Promise<boolean> {
  const url = process.env.ALERT_WEBHOOK_URL
  if (!url) return false
  const base = process.env.FISCHER_PUBLIC_URL || ''
  const icon = a.severity === 'low' ? 'ℹ️' : a.severity === 'medium' ? '⚠️' : '🚨'
  const text = `${icon} *${a.clientName ? `${a.clientName}: ` : ''}${a.title}*${a.message ? `\n${a.message}` : ''}${a.link ? `\n${base}${a.link}` : ''}`
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
    return res.ok
  } catch { return false }
}
