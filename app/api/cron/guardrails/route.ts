import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { fetchGA4Metric, evaluateGuardrail } from '@/lib/ga4'
import { raiseAlert, resolveAlerts } from '@/lib/alerts'
import { registerGoogleAuth } from '@/lib/google'

export const maxDuration = 60

/**
 * Vercel Cron hits this on a schedule (see vercel.json) — not a user-facing
 * route. Protected by CRON_SECRET so it can't be triggered by anyone who
 * finds the URL. This is Section 07 of the CRO SOP made real: guardrail
 * metrics checked automatically, not by someone remembering to log into GA4.
 *
 * Uses the service-role client deliberately — this runs with no logged-in
 * user (it's Vercel's scheduler calling it), so RLS's `auth.role() =
 * 'authenticated'` policies would otherwise block every read/write here.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  const supabase = createSupabaseServiceClient()

  const { data: guardrails, error } = await supabase
    .from('guardrail_metrics')
    .select('*')
    .eq('active', true)

  if (error) {
    console.error('Failed to load guardrail_metrics:', error)
    return NextResponse.json({ error: 'Database error loading guardrails.' }, { status: 500 })
  }

  const results = []
  const { data: clients } = await supabase.from('clients').select('id, ga4_property_id, google_refresh_token').not('google_refresh_token', 'is', null)
  for (const c of clients ?? []) registerGoogleAuth(c)

  for (const g of guardrails ?? []) {
    const metricResult = await fetchGA4Metric(g.ga4_property_id, g.ga4_metric)

    if (!metricResult.success) {
      await supabase
        .from('guardrail_metrics')
        .update({ status: 'unknown', last_checked_at: new Date().toISOString() })
        .eq('id', g.id)

      await supabase.from('guardrail_checks').insert({
        guardrail_id: g.id, value: null, status: 'unknown'
      })

      results.push({ id: g.id, metric: g.metric_name, status: 'unknown', error: metricResult.error })
      continue
    }

    const status = evaluateGuardrail(metricResult.value!, g.baseline_value, g.threshold_type, g.threshold_value)

    await supabase
      .from('guardrail_metrics')
      .update({
        current_value: metricResult.value,
        // Set the baseline on first successful check if one doesn't exist yet —
        // otherwise every guardrail would start permanently "ok" with nothing to compare against.
        baseline_value: g.baseline_value ?? metricResult.value,
        status,
        last_checked_at: new Date().toISOString()
      })
      .eq('id', g.id)

    await supabase.from('guardrail_checks').insert({
      guardrail_id: g.id, value: metricResult.value, status
    })

    if (status === 'breached') {
      await raiseAlert(supabase, {
        clientId: g.client_id, type: 'guardrail_breach', dedupeKey: `guardrail:${g.id}`,
        title: `Guardrail breached: ${g.metric_name}`,
        message: `Current ${metricResult.value} vs baseline ${g.baseline_value ?? 'n/a'} (${g.threshold_type} ${g.threshold_value}).`,
        link: `/clients/${g.client_id}`
      })
    } else await resolveAlerts(supabase, `guardrail:${g.id}`)

    results.push({ id: g.id, metric: g.metric_name, status, value: metricResult.value })
  }

  const breached = results.filter(r => r.status === 'breached')

  return NextResponse.json({
    checked: results.length,
    breached: breached.length,
    results
  })
}
