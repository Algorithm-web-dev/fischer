import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'
import { runAndStoreJourney } from '@/lib/journey-store'

export const maxDuration = 120

/** GET ?clientId=… → latest journey checks · POST { trackedPageId } → run one now */
export async function GET(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) return bad('clientId is required.')
  const { data, error } = await auth.supabase.from('journey_checks').select('*')
    .eq('client_id', clientId).order('created_at', { ascending: false }).limit(50)
  if (error) return bad(error.message, 500)
  return NextResponse.json({ checks: data })
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const { trackedPageId, kind } = await req.json()
  const { data: page } = await auth.supabase.from('tracked_pages').select('*, clients(name)').eq('id', trackedPageId).single()
  if (!page) return bad('Tracked page not found.', 404)
  const journeyKind = kind ?? (page.journey_kind !== 'none' ? page.journey_kind : 'lead')
  try {
    const check = await runAndStoreJourney(auth.supabase, {
      clientId: page.client_id, clientName: (page as any).clients?.name, trackedPageId: page.id, pageUrl: page.page_url, kind: journeyKind
    })
    return NextResponse.json({ check })
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Journey failed.', 500)
  }
}
