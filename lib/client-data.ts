import type { SupabaseClient } from '@supabase/supabase-js'
import { SCREENSHOT_BUCKET } from './audit-pipeline'

// Every table holding client data, with the column linking it to the client.
const CLIENT_TABLES: [string, string][] = [
  ['tracked_pages', 'client_id'], ['audits', 'client_id'], ['backlog_items', 'client_id'], ['change_log', 'client_id'],
  ['test_briefs', 'client_id'], ['monthly_snapshots', 'client_id'], ['clarity_daily', 'client_id'], ['leak_analyses', 'client_id'],
  ['journey_checks', 'client_id'], ['leads', 'client_id'], ['alerts', 'client_id'], ['guardrail_metrics', 'client_id'],
  ['competitor_audits', 'client_id'], ['market_share_analyses', 'client_id'], ['report_shares', 'client_id'], ['activity_log', 'client_id']
]

/** Everything Fischer holds about a client, as JSON (credentials excluded). Service-role client. */
export async function exportClientData(service: SupabaseClient, clientId: string) {
  const { data: client } = await service.from('clients').select('*').eq('id', clientId).single()
  if (!client) throw new Error('Client not found.')
  const { clarity_api_token, google_refresh_token, lead_ingest_key_hash, ...safeClient } = client as any
  const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), client: safeClient }
  for (const [table, col] of CLIENT_TABLES) {
    if (table === 'report_shares') continue // tokens are credentials
    const { data } = await service.from(table).select('*').eq(col, clientId).limit(50000)
    out[table] = data ?? []
  }
  return out
}

/** Permanently deletes a client, their rows and their stored screenshots. Service-role client. */
export async function deleteClientData(service: SupabaseClient, clientId: string) {
  const { data: audits } = await service.from('audits').select('id').eq('client_id', clientId).limit(50000)
  const { data: journeys } = await service.from('journey_checks').select('id').eq('client_id', clientId).limit(50000)
  const folders = [...(audits ?? []).map(a => a.id), ...(journeys ?? []).map(j => `journeys/${j.id}`)]

  let files = 0
  for (const folder of folders) {
    const { data: objects } = await service.storage.from(SCREENSHOT_BUCKET).list(folder, { limit: 1000 })
    const paths = (objects ?? []).map(o => `${folder}/${o.name}`)
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await service.storage.from(SCREENSHOT_BUCKET).remove(paths.slice(i, i + 100))
      if (!error) files += Math.min(100, paths.length - i)
    }
  }

  // audits/usage/errors only SET NULL on client delete, so remove/unlink them explicitly
  const counts: Record<string, number> = {}
  for (const [table, col] of CLIENT_TABLES) {
    const { count } = await service.from(table).delete({ count: 'exact' }).eq(col, clientId)
    counts[table] = count ?? 0
  }
  await service.from('llm_usage').update({ client_id: null }).eq('client_id', clientId)
  await service.from('error_log').update({ client_id: null }).eq('client_id', clientId)
  await service.from('client_users').delete().eq('client_id', clientId)
  const { error } = await service.from('clients').delete().eq('id', clientId)
  if (error) throw new Error(`Deleting the client row failed: ${error.message}`)
  return { screenshotsDeleted: files, rowsDeleted: Object.values(counts).reduce((s, n) => s + n, 0) }
}
