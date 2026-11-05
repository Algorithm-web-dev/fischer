import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'

export async function GET(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const { data, error } = await auth.supabase.from('error_log').select('*, clients(name)')
    .order('created_at', { ascending: false }).limit(Math.min(Number(req.nextUrl.searchParams.get('limit') || 100), 500))
  if (error) return bad(error.message, 500)
  return NextResponse.json({ errors: data })
}
