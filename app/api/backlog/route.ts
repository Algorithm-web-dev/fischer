import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  const tier = req.nextUrl.searchParams.get('tier')

  let query = supabase.from('backlog_items').select('*').order('created_at', { ascending: false })
  if (clientId) query = query.eq('client_id', clientId)
  if (tier) query = query.eq('tier', tier)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ items: data })
}

export async function POST(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const body = await req.json()

  if (!body.clientId || !body.title) {
    return NextResponse.json({ error: 'clientId and title are required.' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('backlog_items')
    .insert({
      client_id: body.clientId,
      source_audit_id: body.sourceAuditId ?? null,
      title: body.title,
      description: body.description ?? null,
      tier: body.tier ?? 'watching',
      evidence_type: body.evidenceType ?? 'quant',
      evidence_refs: body.evidenceRefs ?? {},
      severity: body.severity ?? null,
      owner: body.owner ?? null
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ item: data })
}
