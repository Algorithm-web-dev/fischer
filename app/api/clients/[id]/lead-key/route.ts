import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'
import { newIngestKey } from '@/lib/lead-quality'
import { logActivity } from '@/lib/activity'

/** Creates (or rotates) the client's CRM ingest key. The key is shown once; only its hash is stored. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const { key, hash } = newIngestKey()
  const { error } = await auth.supabase.from('clients').update({ lead_ingest_key_hash: hash }).eq('id', params.id)
  if (error) return bad(error.message, 500)
  await logActivity(auth.supabase, auth.user, 'lead_key.rotate', { entityType: 'client', entityId: params.id, clientId: params.id })
  return NextResponse.json({ key })
}
