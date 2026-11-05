import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'
import { twoProportionTest } from '@/lib/stats'

/**
 * A/B test lifecycle: draft → approved → running → completed / abandoned.
 *
 * PATCH accepts any of: status, testStartDate, testEndDate, resultSummary,
 * controlVisitors/controlConversions/variantVisitors/variantConversions (stats
 * recomputed automatically), ga4Dimension/ga4ControlValue/ga4VariantValue.
 *
 * Completing a test with a winning variant writes an entry to the change log
 * ("variant shipped"), so reports pick it up as a change made this month.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const { data, error } = await auth.supabase.from('test_briefs').select('*').eq('id', params.id).single()
  if (error || !data) return bad('Test not found.', 404)
  return NextResponse.json({ test: data })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const { supabase, user } = auth
  const body = await req.json()

  const { data: test } = await supabase.from('test_briefs').select('*').eq('id', params.id).single()
  if (!test) return bad('Test not found.', 404)

  const updates: Record<string, unknown> = {}
  const map: Record<string, string> = {
    status: 'status', testStartDate: 'test_start_date', testEndDate: 'test_end_date', resultSummary: 'result_summary',
    controlVisitors: 'control_visitors', controlConversions: 'control_conversions',
    variantVisitors: 'variant_visitors', variantConversions: 'variant_conversions',
    ga4Dimension: 'ga4_dimension', ga4ControlValue: 'ga4_control_value', ga4VariantValue: 'ga4_variant_value'
  }
  for (const [k, col] of Object.entries(map)) if (body[k] !== undefined) updates[col] = body[k]

  if (updates.status && !['draft', 'approved', 'running', 'completed', 'abandoned'].includes(String(updates.status))) {
    return bad('Invalid status.')
  }
  if (updates.status === 'running' && !test.test_start_date && !updates.test_start_date) {
    updates.test_start_date = new Date().toISOString().slice(0, 10)
  }
  if (updates.status === 'completed' && !test.test_end_date && !updates.test_end_date) {
    updates.test_end_date = new Date().toISOString().slice(0, 10)
  }

  const merged = { ...test, ...updates }
  const hasResults = ['control_visitors', 'control_conversions', 'variant_visitors', 'variant_conversions']
    .some(k => k in updates)
  if (hasResults) {
    const nums = [merged.control_visitors, merged.control_conversions, merged.variant_visitors, merged.variant_conversions].map(Number)
    if (nums.some(n => !Number.isFinite(n) || n < 0)) return bad('Visitors and conversions must be non-negative numbers.')
    try {
      const stats = twoProportionTest(
        { visitors: nums[0], conversions: nums[1] },
        { visitors: nums[2], conversions: nums[3] },
        { plannedSamplePerArm: merged.hypothesis?.plan?.samplePerArm }
      )
      updates.stats = stats
      updates.winner = stats.winner
      updates.results_source = body.resultsSource ?? 'manual'
      updates.results_updated_at = new Date().toISOString()
      if (!body.resultSummary) updates.result_summary = stats.verdict
      updates.cvr_delta = stats.absoluteDiff
    } catch (err) {
      return bad(err instanceof Error ? err.message : 'Invalid results.')
    }
  }

  const { data: saved, error } = await supabase.from('test_briefs').update(updates).eq('id', params.id).select().single()
  if (error) return bad(error.message, 500)

  if (updates.status === 'completed' && test.status !== 'completed') {
    const winner = saved.winner
    await supabase.from('change_log').insert({
      client_id: saved.client_id,
      page_url: saved.page_url,
      change_date: saved.test_end_date ?? new Date().toISOString().slice(0, 10),
      title: winner === 'variant' ? `A/B test won — variant shipped: ${saved.hypothesis_name}` : `A/B test concluded: ${saved.hypothesis_name}`,
      description: saved.result_summary,
      source: 'test',
      test_brief_id: saved.id,
      created_by: user.id,
      details: { stats: saved.stats }
    })
  }

  return NextResponse.json({ test: saved })
}
