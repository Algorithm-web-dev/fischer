import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const { data, error } = await auth.supabase.from('clients').select('*').eq('id', params.id).single()
  if (error || !data) return bad('Client not found.', 404)
  return NextResponse.json({
    client: {
      ...data,
      clarity_api_token: data.clarity_api_token ? '••••configured' : null,
      lead_ingest_key_hash: undefined,
      lead_ingest_configured: !!data.lead_ingest_key_hash,
      integrations: { ga4: !!data.ga4_property_id, clarity: !!data.clarity_api_token }
    }
  })
}
