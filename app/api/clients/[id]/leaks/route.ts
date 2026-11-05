import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'
import { runLeakAnalysis, latestLeakAnalysis, trackTopLeaks } from '@/lib/leak-store'
import { lastNDays, monthRange } from '@/lib/ga4-audit'

export const maxDuration = 120

/**
 * GET  → the latest stored revenue leak map
 * POST { days?: 30|60|90, period?: "YYYY-MM", trackTop?: number } → compute a new one now
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const latest = await latestLeakAnalysis(auth.supabase, params.id)
  return NextResponse.json({ analysis: latest })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const body = await req.json().catch(() => ({}))
  const { data: client } = await auth.supabase.from('clients').select('*').eq('id', params.id).single()
  if (!client) return bad('Client not found.', 404)

  const range = typeof body.period === 'string' && /^\d{4}-\d{2}$/.test(body.period)
    ? monthRange(body.period)
    : lastNDays([30, 60, 90].includes(Number(body.days)) ? Number(body.days) : 30)

  try {
    const stored = await runLeakAnalysis(auth.supabase, client, range, auth.user.id)
    const tracked = body.trackTop ? await trackTopLeaks(auth.supabase, client.id, stored.data, Math.min(Number(body.trackTop), 10)) : []
    return NextResponse.json({ analysis: stored, tracked })
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Leak analysis failed.', 502)
  }
}
