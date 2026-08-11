import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  let query = supabase.from('guardrail_metrics').select('*, guardrail_checks(*)').order('created_at', { ascending: false })
  if (clientId) query = query.eq('client_id', clientId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ guardrails: data })
}

export async function POST(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const body = await req.json()
  const required = ['clientId', 'metricName', 'ga4PropertyId', 'ga4Metric', 'thresholdValue']
  for (const field of required) {
    if (!body[field]) return NextResponse.json({ error: `${field} is required.` }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('guardrail_metrics')
    .insert({
      client_id: body.clientId,
      metric_name: body.metricName,
      ga4_property_id: body.ga4PropertyId,
      ga4_metric: body.ga4Metric,
      threshold_type: body.thresholdType ?? 'max_drop_pct',
      threshold_value: body.thresholdValue
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ guardrail: data })
}
