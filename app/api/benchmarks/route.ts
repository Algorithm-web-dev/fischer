import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/api'
import { loadBenchmarks, clientBenchmark } from '@/lib/benchmarks'

/** GET ?clientId=… → that client vs its industry; without clientId → all industry benchmarks (anonymised). */
export async function GET(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const clientId = req.nextUrl.searchParams.get('clientId')
  if (clientId) {
    const { data: client } = await auth.supabase.from('clients').select('id, industry').eq('id', clientId).single()
    return NextResponse.json({ benchmark: client ? await clientBenchmark(auth.supabase, client) : null })
  }
  const { benchmarks } = await loadBenchmarks(auth.supabase)
  return NextResponse.json({ benchmarks })
}
