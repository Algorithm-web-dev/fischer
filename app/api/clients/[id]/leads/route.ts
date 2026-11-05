import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/api'
import { leadQualityReport } from '@/lib/lead-quality'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const days = Math.min(Math.max(Number(req.nextUrl.searchParams.get('days') || 90), 7), 365)
  const { data: client } = await auth.supabase.from('clients').select('lead_ingest_key_hash').eq('id', params.id).single()
  const report = await leadQualityReport(auth.supabase, params.id, days)
  return NextResponse.json({ report, keyConfigured: !!client?.lead_ingest_key_hash })
}
