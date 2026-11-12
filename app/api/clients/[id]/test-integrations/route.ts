import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'
import { fetchGA4AuditData, lastNDays } from '@/lib/ga4-audit'
import { storeClarityDay } from '@/lib/snapshots'
import { fetchGA4EventInventory } from '@/lib/tracking'
import { registerGoogleAuth } from '@/lib/google'

export const maxDuration = 60

/**
 * Checks GA4 and Clarity credentials for a client, so onboarding problems
 * (missing Viewer access, wrong property ID, bad token) surface immediately
 * instead of as a silently empty report a month later.
 * The Clarity check also stores today's data (uses 1 of the 10 daily requests).
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const { data: client } = await auth.supabase.from('clients').select('*').eq('id', params.id).single()
  if (!client) return bad('Client not found.', 404)

  const out: Record<string, unknown> = {}
  registerGoogleAuth(client)
  if (client.ga4_property_id) {
    const r = await fetchGA4AuditData(client.ga4_property_id, { range: lastNDays(7), conversionEvent: client.ga4_conversion_event })
    const events = r.success ? await fetchGA4EventInventory(client.ga4_property_id).catch(() => null) : null
    out.ga4 = r.success
      ? { ok: true, sessionsLast7Days: r.totals?.sessions, conversionsLast7Days: r.totals?.conversions, events,
          warning: r.totals?.conversions === 0 ? 'Connected, but 0 conversions in 7 days — check the conversion event is marked as a key event.' : undefined }
      : { ok: false, error: r.error }
  } else out.ga4 = { ok: false, error: 'No GA4 property ID set.' }

  if (client.clarity_api_token) {
    const r = await storeClarityDay(auth.supabase, client)
    out.clarity = 'error' in r && r.error ? { ok: false, error: r.error } : { ok: true, ...r }
  } else out.clarity = { ok: false, error: 'No Clarity API token set.' }

  return NextResponse.json(out)
}
