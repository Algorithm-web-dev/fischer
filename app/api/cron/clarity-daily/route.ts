import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { isCronAuthorized } from '@/lib/api'
import { storeClarityDay } from '@/lib/snapshots'

export const maxDuration = 300

/**
 * Daily: stores the last 24h of Clarity data for every client with a token.
 * Clarity's API only exposes the last 3 days, so without this job there is no
 * Clarity history to compare month over month. Uses 1 of the 10 daily
 * requests per project.
 */
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  const supabase = createSupabaseServiceClient()
  const { data: clients, error } = await supabase.from('clients').select('*').not('clarity_api_token', 'is', null)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results = []
  for (const c of clients ?? []) {
    results.push({ client: c.name, ...(await storeClarityDay(supabase, c)) })
  }
  return NextResponse.json({ checked: results.length, results })
}
