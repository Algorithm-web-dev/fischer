import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'
import { twoProportionTest } from '@/lib/stats'
import { logActivity } from '@/lib/activity'

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

  // ---- Live A/B test via the Fischer tracking kit ----
  if (body.kitSplit !== undefined) {
    const s = Number(body.kitSplit)
    if (!(s > 0 && s < 1)) return bad('kitSplit must be between 0 and 1 (e.g. 0.5).')
    updates.kit_split = s
  }
  if (body.kitUrlMatch !== undefined) {
    const m = String(body.kitUrlMatch || '/').trim()
    if (!m.startsWith('/') || m.length > 300) return bad('kitUrlMatch must be a path like /quote or a prefix like /products/*.')
    updates.kit_url_match = m
  }
  if (body.kitDevice !== undefined) {
    if (!['all', 'mobile', 'desktop'].includes(body.kitDevice)) return bad('kitDevice must be all, mobile or desktop.')
    updates.kit_device = body.kitDevice
  }
  if (body.kitLive === true && !test.kit_live) {
    if (!test.variant_ops?.length) return bad('Generate the variant first (Build variant).')
    const { data: other } = await supabase.from('test_briefs').select('id, hypothesis_name')
      .eq('client_id', test.client_id).eq('kit_live', true).neq('id', test.id).limit(1)
    if (other?.length) return bad(`"${other[0].hypothesis_name}" is already live for this client — one live kit test per site keeps GA4 results unambiguous.`, 409)
    updates.kit_live = true
    if (test.status !== 'running') {
      updates.status = 'running'
      if (!test.test_start_date) updates.test_start_date = new Date().toISOString().slice(0, 10)
    }
    // The kit writes the visitor's arm to the GA4 user property "fischer_exp"
    updates.ga4_dimension = 'customUser:fischer_exp'
    updates.ga4_control_value = `${test.kit_key}-control`
    updates.ga4_variant_value = `${test.kit_key}-variant`
  }
  if (body.kitLive === false || updates.status === 'completed' || updates.status === 'abandoned') updates.kit_live = false

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

  if (Object.keys(updates).length === 0) return NextResponse.json({ test })
  const { data: saved, error } = await supabase.from('test_briefs').update(updates).eq('id', params.id).select().single()
  if (error) return bad(error.message, 500)
  await logActivity(supabase, user, 'test.update', { entityType: 'test', entityId: params.id, clientId: saved.client_id, details: { fields: Object.keys(updates) } })

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
