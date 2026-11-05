import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { isCronAuthorized } from '@/lib/api'
import { runAndStoreJourney } from '@/lib/journey-store'

export const maxDuration = 300

/** Daily: runs journey checks for tracked pages not checked in the last 7 days (bounded per run). */
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  const started = Date.now()
  const supabase = createSupabaseServiceClient()
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString()
  const { data: pages } = await supabase.from('tracked_pages').select('*, clients(name)')
    .eq('active', true).neq('journey_kind', 'none')
    .or(`last_journey_at.is.null,last_journey_at.lt.${cutoff}`)
    .order('last_journey_at', { ascending: true, nullsFirst: true }).limit(20)

  const log = []
  for (const p of pages ?? []) {
    if (Date.now() - started > 220_000) { log.push('Time budget used — continuing tomorrow.'); break }
    try {
      const check = await runAndStoreJourney(supabase, { clientId: p.client_id, clientName: (p as any).clients?.name, trackedPageId: p.id, pageUrl: p.page_url, kind: p.journey_kind })
      log.push({ page: p.page_url, passed: check.passed })
    } catch (err) {
      log.push({ page: p.page_url, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return NextResponse.json({ ms: Date.now() - started, log })
}
