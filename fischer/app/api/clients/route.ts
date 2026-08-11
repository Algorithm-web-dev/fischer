import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase'

/**
 * Client management — CRUD for retainer clients with their integration
 * configurations (GA4 property ID, Clarity credentials, industry, AOV).
 * Once a client record is populated with these, Fischer auto-pulls live
 * data from GA4 and Clarity at audit time — no more manual form fields.
 */
export async function GET(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Mask Clarity API tokens in list view — only show whether it's configured
  const clients = (data || []).map(c => ({
    ...c,
    clarity_api_token: c.clarity_api_token ? '••••configured' : null,
    integrations: {
      ga4: !!c.ga4_property_id,
      clarity: !!(c.clarity_project_id && c.clarity_api_token)
    }
  }))

  return NextResponse.json({ clients })
}

export async function POST(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const body = await req.json()

  if (!body.name) {
    return NextResponse.json({ error: 'Client name is required.' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('clients')
    .insert({
      name: body.name,
      primary_url: body.primaryUrl ?? null,
      tier: body.tier ?? 'B',
      cro_hours_monthly: body.croHoursMonthly ?? null,
      ga4_property_id: body.ga4PropertyId ?? null,
      clarity_project_id: body.clarityProjectId ?? null,
      clarity_api_token: body.clarityApiToken ?? null,
      industry: body.industry ?? null,
      avg_order_value: body.avgOrderValue ?? null,
      currency: body.currency ?? 'ZAR'
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ client: data })
}

export async function PATCH(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const body = await req.json()

  if (!body.id) {
    return NextResponse.json({ error: 'Client ID is required.' }, { status: 400 })
  }

  // Build update object — only include fields that were explicitly provided
  const updates: Record<string, any> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.primaryUrl !== undefined) updates.primary_url = body.primaryUrl
  if (body.tier !== undefined) updates.tier = body.tier
  if (body.croHoursMonthly !== undefined) updates.cro_hours_monthly = body.croHoursMonthly
  if (body.ga4PropertyId !== undefined) updates.ga4_property_id = body.ga4PropertyId
  if (body.clarityProjectId !== undefined) updates.clarity_project_id = body.clarityProjectId
  if (body.clarityApiToken !== undefined) updates.clarity_api_token = body.clarityApiToken
  if (body.industry !== undefined) updates.industry = body.industry
  if (body.avgOrderValue !== undefined) updates.avg_order_value = body.avgOrderValue
  if (body.currency !== undefined) updates.currency = body.currency

  const { data, error } = await supabase
    .from('clients')
    .update(updates)
    .eq('id', body.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ client: data })
}
