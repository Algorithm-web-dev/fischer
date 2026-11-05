import type { SupabaseClient } from '@supabase/supabase-js'
import { runJourney, type JourneyKind, type JourneyResult } from './journey'
import { raiseAlert, resolveAlerts } from './alerts'
import { SCREENSHOT_BUCKET } from './audit-pipeline'

/** Runs, stores (screenshots → storage) and alerts on one journey check. */
export async function runAndStoreJourney(supabase: SupabaseClient, params: {
  clientId: string; clientName?: string; trackedPageId?: string | null; pageUrl: string; kind: JourneyKind
}) {
  const result = await runJourney(params.pageUrl, params.kind)
  const id = crypto.randomUUID()
  const steps = []
  for (let i = 0; i < result.steps.length; i++) {
    const s = result.steps[i]
    let screenshotUrl: string | undefined
    if (s.screenshot) {
      const path = `journeys/${id}/${i}.jpg`
      const { error } = await supabase.storage.from(SCREENSHOT_BUCKET).upload(path, Buffer.from(s.screenshot, 'base64'), { contentType: 'image/jpeg', upsert: true })
      if (!error) screenshotUrl = supabase.storage.from(SCREENSHOT_BUCKET).getPublicUrl(path).data.publicUrl
    }
    const { screenshot, ...rest } = s
    steps.push({ ...rest, screenshotUrl })
  }
  const stored = { ...result, steps } as Omit<JourneyResult, 'steps'> & { steps: (Omit<JourneyResult['steps'][number], 'screenshot'> & { screenshotUrl?: string })[] }

  const { data: row, error } = await supabase.from('journey_checks').insert({
    id, client_id: params.clientId, tracked_page_id: params.trackedPageId ?? null, page_url: params.pageUrl,
    kind: params.kind, passed: result.passed, result: stored
  }).select().single()
  if (error) throw new Error(`Saving journey failed: ${error.message}`)
  if (params.trackedPageId) await supabase.from('tracked_pages').update({ last_journey_at: new Date().toISOString() }).eq('id', params.trackedPageId)

  const key = `journey:${params.trackedPageId ?? params.pageUrl}`
  if (!result.passed) {
    const high = result.issues.filter(i => i.severity === 'high')
    await raiseAlert(supabase, {
      clientId: params.clientId, clientName: params.clientName, type: 'journey_failed', dedupeKey: key,
      title: `${params.kind === 'lead' ? 'Lead form journey' : 'Checkout journey'} is broken`,
      message: `${params.pageUrl}\n${high.map(i => `• ${i.message}`).join('\n')}`,
      link: `/clients/${params.clientId}?tab=pages`, details: { journeyCheckId: id }
    })
  } else {
    await resolveAlerts(supabase, key)
  }
  return row
}
