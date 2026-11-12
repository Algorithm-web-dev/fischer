import { NextRequest, NextResponse } from 'next/server'
import { requireUser, requireRole, bad } from '@/lib/api'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { deleteClientData } from '@/lib/client-data'
import { logActivity } from '@/lib/activity'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const { data, error } = await auth.supabase.from('clients').select('*').eq('id', params.id).single()
  if (error || !data) return bad('Client not found.', 404)
  return NextResponse.json({
    client: {
      ...data,
      clarity_api_token: data.clarity_api_token ? '••••configured' : null,
      google_refresh_token: undefined,
      lead_ingest_key_hash: undefined,
      lead_ingest_configured: !!data.lead_ingest_key_hash,
      integrations: { ga4: !!data.ga4_property_id, clarity: !!data.clarity_api_token }
    }
  })
}

/**
 * DELETE { confirmName } — permanently deletes a client and everything about
 * them: audits and screenshots, snapshots, Clarity history, leads, tests,
 * backlog, change log, reports, journeys, alerts and portal logins' access.
 * Admins only; the client's exact name must be typed to confirm.
 * (POPIA/GDPR erasure requests. Export first with GET /api/clients/[id]/export.)
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireRole('admin'); if (auth.error) return auth.error
  const { confirmName } = await req.json().catch(() => ({}))
  const { data: client } = await auth.supabase.from('clients').select('id, name').eq('id', params.id).single()
  if (!client) return bad('Client not found.', 404)
  if (String(confirmName ?? '').trim() !== client.name) return bad('Type the client name exactly to confirm deletion.')
  try {
    const summary = await deleteClientData(createSupabaseServiceClient(), client.id)
    await logActivity(auth.supabase, auth.user, 'client.delete', { entityType: 'client', entityId: client.id, details: { name: client.name, ...summary } })
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Deletion failed.', 500)
  }
}
