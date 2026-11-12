import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { hashKey, normaliseLead, type LeadInput } from '@/lib/lead-quality'

/**
 * CRM → Fischer lead feed. Authenticated with the client's ingest key:
 *   Authorization: Bearer fsk_…
 * Body: one lead object, an array, or { leads: [...] } (max 500 per call).
 * Send the same externalId again to update a lead's status/value.
 * Personal data fields (name, email, phone…) are ignored and never stored.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') || ''
  const key = auth.replace(/^Bearer\s+/i, '').trim()
  if (!key.startsWith('fsk_')) return NextResponse.json({ error: 'Missing or invalid ingest key.' }, { status: 401 })

  const supabase = createSupabaseServiceClient()
  const { data: client } = await supabase.from('clients').select('id').eq('lead_ingest_key_hash', hashKey(key)).maybeSingle()
  if (!client) return NextResponse.json({ error: 'Missing or invalid ingest key.' }, { status: 401 })

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 }) }
  const list: LeadInput[] = Array.isArray(body) ? body : (body as any)?.leads ?? [body]
  if (!Array.isArray(list) || list.length === 0) return NextResponse.json({ error: 'No leads in body.' }, { status: 400 })
  if (list.length > 500) return NextResponse.json({ error: 'Max 500 leads per request.' }, { status: 413 })

  const rows: Record<string, unknown>[] = []
  const errors: { index: number; error: string }[] = []
  list.forEach((l, index) => {
    const r = normaliseLead(client.id, l)
    if (typeof r === 'string') errors.push({ index, error: r })
    else rows.push(r)
  })
  if (rows.length) {
    const { error } = await supabase.from('leads').upsert(rows, { onConflict: 'client_id,external_id' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ accepted: rows.length, rejected: errors.length, errors: errors.slice(0, 20) }, { status: errors.length && !rows.length ? 400 : 200 })
}
