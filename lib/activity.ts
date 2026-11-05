import type { SupabaseClient, User } from '@supabase/supabase-js'

/**
 * Activity log — who did what, when. Written for changes that matter to
 * clients or security: client settings, credentials, report links, shipped
 * work, test results, team and portal access, data deletion.
 * Never throws: an audit-trail failure must not break the action itself.
 */
export async function logActivity(
  supabase: SupabaseClient,
  user: Pick<User, 'id' | 'email'> | null,
  action: string,
  opts: { entityType?: string; entityId?: string | null; clientId?: string | null; details?: Record<string, unknown> } = {}
) {
  try {
    await supabase.from('activity_log').insert({
      user_id: user?.id ?? null, user_email: user?.email ?? null, action,
      entity_type: opts.entityType ?? null, entity_id: opts.entityId ?? null,
      client_id: opts.clientId ?? null, details: opts.details ?? null
    })
  } catch (err) {
    console.error('[fischer] activity log failed:', err)
  }
}

/** Field names only — never log credential values. */
export function changedFields(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter(k => k !== 'id' && body[k] !== undefined)
}
