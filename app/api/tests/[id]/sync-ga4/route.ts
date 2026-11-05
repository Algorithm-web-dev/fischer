import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'
import { fetchExperimentResults } from '@/lib/ga4-experiments'
import { iso } from '@/lib/ga4-audit'
import { twoProportionTest } from '@/lib/stats'

/** Pulls the latest visitor/conversion counts for a running test from GA4 and recomputes significance. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const { supabase } = auth

  const { data: test } = await supabase.from('test_briefs').select('*').eq('id', params.id).single()
  if (!test) return bad('Test not found.', 404)
  if (!test.ga4_dimension || !test.ga4_control_value || !test.ga4_variant_value) {
    return bad('Set ga4Dimension, ga4ControlValue and ga4VariantValue on this test first.')
  }
  if (!test.test_start_date) return bad('Set the test start date first.')

  const { data: client } = await supabase.from('clients').select('*').eq('id', test.client_id).single()
  if (!client?.ga4_property_id) return bad('This client has no GA4 property connected.')

  try {
    const yesterday = iso(new Date(Date.now() - 86400000))
    const end = test.test_end_date && test.test_end_date < yesterday ? test.test_end_date : yesterday
    const { control, variant } = await fetchExperimentResults({
      propertyId: client.ga4_property_id,
      dimension: test.ga4_dimension,
      controlValue: test.ga4_control_value,
      variantValue: test.ga4_variant_value,
      range: { startDate: test.test_start_date, endDate: end },
      conversionEvent: client.ga4_conversion_event
    })
    const stats = twoProportionTest(control, variant, { plannedSamplePerArm: test.hypothesis?.plan?.samplePerArm })
    const { data: saved, error } = await supabase.from('test_briefs').update({
      control_visitors: control.visitors, control_conversions: control.conversions,
      variant_visitors: variant.visitors, variant_conversions: variant.conversions,
      stats, winner: stats.winner, result_summary: stats.verdict, cvr_delta: stats.absoluteDiff,
      results_source: 'ga4', results_updated_at: new Date().toISOString()
    }).eq('id', params.id).select().single()
    if (error) return bad(error.message, 500)
    return NextResponse.json({ test: saved })
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'GA4 sync failed.', 502)
  }
}
