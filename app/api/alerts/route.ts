import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'

/** GET ?clientId=…&all=1 → open alerts (or all) · PATCH { id } → resolve */
export async function GET(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const sp = req.nextUrl.searchParams
  let q = auth.supabase.from('alerts').select('*, clients(name)').order('created_at', { ascending: false }).limit(100)
  if (sp.get('clientId')) q = q.eq('client_id', sp.get('clientId')!)
  if (sp.get('all') !== '1') q = q.is('resolved_at', null)
  const { data, error } = await q
  if (error) return bad(error.message, 500)
  return NextResponse.json({ alerts: data })
}

export async function PATCH(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const { id } = await req.json()
  if (!id) return bad('id is required.')
  const { error } = await auth.supabase.from('alerts').update({ resolved_at: new Date().toISOString(), resolved_by: auth.user.id }).eq('id', id)
  if (error) return bad(error.message, 500)
  return NextResponse.json({ ok: true })
}
