import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'
import { measureChangeImpact } from '@/lib/snapshots'

/**
 * Change log — what was changed on a client's site and when. Shipped backlog
 * items, concluded A/B tests and changes Fischer detects between audits are
 * logged automatically; use POST for anything done outside Fischer (a dev
 * pushed a new hero, a form was shortened, etc.).
 *
 * GET ?clientId=…&measure=1 also computes the 28-day before/after impact for
 * each change (GA4 required).
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) return bad('clientId is required.')
  const { data, error } = await auth.supabase.from('change_log').select('*')
    .eq('client_id', clientId).order('change_date', { ascending: false }).limit(200)
  if (error) return bad(error.message, 500)

  if (req.nextUrl.searchParams.get('measure') === '1') {
    const { data: client } = await auth.supabase.from('clients').select('*').eq('id', clientId).single()
    if (client?.ga4_property_id) {
      for (const ch of (data ?? []).slice(0, 20)) {
        if (ch.details?.impact?.afterComplete) continue
        try {
          const impact = await measureChangeImpact(client, ch)
          if (impact) {
            ch.details = { ...(ch.details ?? {}), impact }
            await auth.supabase.from('change_log').update({ details: ch.details }).eq('id', ch.id)
          }
        } catch { /* leave unmeasured */ }
      }
    }
  }
  return NextResponse.json({ changes: data })
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const body = await req.json()
  if (!body.clientId || !body.title) return bad('clientId and title are required.')
  const { data, error } = await auth.supabase.from('change_log').insert({
    client_id: body.clientId,
    page_url: body.pageUrl ?? null,
    change_date: body.changeDate ?? new Date().toISOString().slice(0, 10),
    title: body.title,
    description: body.description ?? null,
    source: 'manual',
    created_by: auth.user.id
  }).select().single()
  if (error) return bad(error.message, 500)
  return NextResponse.json({ change: data })
}

export async function DELETE(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return bad('id is required.')
  const { error } = await auth.supabase.from('change_log').delete().eq('id', id)
  if (error) return bad(error.message, 500)
  return NextResponse.json({ ok: true })
}
