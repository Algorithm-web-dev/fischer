import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'
import { isValidHttpUrl } from '@/lib/validate'

/** Pages that get re-audited automatically every month (see app/api/cron/monthly). */
export async function GET(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const clientId = req.nextUrl.searchParams.get('clientId')
  let q = auth.supabase.from('tracked_pages').select('*').order('created_at')
  if (clientId) q = q.eq('client_id', clientId)
  const { data, error } = await q
  if (error) return bad(error.message, 500)
  return NextResponse.json({ pages: data })
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const body = await req.json()
  if (!body.clientId || !body.pageUrl) return bad('clientId and pageUrl are required.')
  if (!isValidHttpUrl(body.pageUrl)) return bad('pageUrl must be a public http(s) URL.')
  const { data, error } = await auth.supabase.from('tracked_pages').upsert({
    client_id: body.clientId,
    page_url: body.pageUrl,
    page_type: body.pageType ?? 'Landing Page',
    business_goal: body.businessGoal ?? 'Lead Generation',
    active: body.active ?? true,
    journey_kind: ['lead', 'ecommerce'].includes(body.journeyKind) ? body.journeyKind : (/e-?commerce|sales/i.test(body.businessGoal ?? '') ? 'ecommerce' : 'lead')
  }, { onConflict: 'client_id,page_url' }).select().single()
  if (error) return bad(error.message, 500)
  return NextResponse.json({ page: data })
}

export async function PATCH(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const body = await req.json()
  if (!body.id) return bad('id is required.')
  const updates: Record<string, unknown> = {}
  if (body.active !== undefined) updates.active = !!body.active
  if (body.pageType !== undefined) updates.page_type = body.pageType
  if (body.businessGoal !== undefined) updates.business_goal = body.businessGoal
  if (body.journeyKind !== undefined) {
    if (!['none', 'lead', 'ecommerce'].includes(body.journeyKind)) return bad('journeyKind must be none, lead or ecommerce.')
    updates.journey_kind = body.journeyKind
  }
  const { data, error } = await auth.supabase.from('tracked_pages').update(updates).eq('id', body.id).select().single()
  if (error) return bad(error.message, 500)
  return NextResponse.json({ page: data })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return bad('id is required.')
  const { error } = await auth.supabase.from('tracked_pages').delete().eq('id', id)
  if (error) return bad(error.message, 500)
  return NextResponse.json({ ok: true })
}
