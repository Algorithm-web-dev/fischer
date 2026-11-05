/**
 * Error log — every unexpected server error is stored (error_log table) so the
 * team can see what broke, where and for which client, without digging
 * through hosting logs. Optional: set SENTRY_DSN-style forwarding later; for
 * now errors also go to ALERT_WEBHOOK_URL when ERROR_WEBHOOK=true.
 */
export async function logError(context: string, err: unknown, meta: { clientId?: string | null; auditId?: string | null; [k: string]: unknown } = {}) {
  const message = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error ? err.stack?.split('\n').slice(0, 8).join('\n') : undefined
  console.error(`[fischer] ${context}:`, message)
  try {
    const { createSupabaseServiceClient } = await import('./supabase')
    const { clientId, auditId, ...rest } = meta
    await createSupabaseServiceClient().from('error_log').insert({
      context, message: message.slice(0, 2000), stack: stack ?? null,
      client_id: clientId ?? null, audit_id: auditId ?? null, meta: Object.keys(rest).length ? rest : null
    })
  } catch { /* logging must never throw */ }
  if (process.env.ERROR_WEBHOOK === 'true' && process.env.ALERT_WEBHOOK_URL) {
    fetch(process.env.ALERT_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `🛠 Fischer error in ${context}: ${message.slice(0, 300)}` })
    }).catch(() => {})
  }
}
