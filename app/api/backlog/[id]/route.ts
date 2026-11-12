import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'
import { logActivity } from '@/lib/activity'

/** Update a backlog item. Moving it to "shipped" records the change in the change log. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const { supabase, user } = auth
  const body = await req.json()

  const { data: item } = await supabase.from('backlog_items').select('*').eq('id', params.id).single()
  if (!item) return bad('Backlog item not found.', 404)

  const updates: Record<string, unknown> = {}
  const map: Record<string, string> = {
    title: 'title', description: 'description', tier: 'tier', owner: 'owner', severity: 'severity',
    resultSummary: 'result_summary', iceImpact: 'ice_impact', iceConfidence: 'ice_confidence', iceEase: 'ice_ease'
  }
  for (const [k, col] of Object.entries(map)) if (body[k] !== undefined) updates[col] = body[k]

  const { data: saved, error } = await supabase.from('backlog_items').update(updates).eq('id', params.id).select().single()
  if (error) return bad(error.message, 500)

  if (updates.tier && updates.tier !== item.tier) {
    await logActivity(supabase, user, updates.tier === 'shipped' ? 'backlog.ship' : 'backlog.move', { entityType: 'backlog_item', entityId: item.id, clientId: item.client_id, details: { from: item.tier, to: updates.tier, title: item.title } })
  }
  if (updates.tier === 'shipped' && item.tier !== 'shipped') {
    let pageUrl: string | null = body.pageUrl ?? null
    if (!pageUrl && item.source_audit_id) {
      const { data: a } = await supabase.from('audits').select('page_url').eq('id', item.source_audit_id).single()
      pageUrl = a?.page_url ?? null
    }
    await supabase.from('change_log').insert({
      client_id: item.client_id,
      page_url: pageUrl,
      change_date: body.shippedDate ?? new Date().toISOString().slice(0, 10),
      title: item.title,
      description: item.description,
      source: 'backlog',
      backlog_item_id: item.id,
      created_by: user.id
    })
  }
  return NextResponse.json({ item: saved })
}
