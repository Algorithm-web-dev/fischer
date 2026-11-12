import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const { data, error } = await auth.supabase.from('audits').select('*').eq('id', params.id).single()
  if (error || !data) return bad('Audit not found.', 404)
  return NextResponse.json({ audit: data })
}
