import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/api'
import { loadLibrary, summariseLibrary } from '@/lib/test-library'

/** GET ?industry=&tag= → concluded tests across all clients (anonymised) + win rates by change type */
export async function GET(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const sp = req.nextUrl.searchParams
  const entries = await loadLibrary(auth.supabase, { industry: sp.get('industry'), tag: sp.get('tag') })
  return NextResponse.json({ entries, summary: summariseLibrary(entries) })
}
