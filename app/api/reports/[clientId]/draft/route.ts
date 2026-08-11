import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase'

/**
 * Assembles the exact JSON shape the branded report generator expects
 * (see the CRO report kit's data_example.json / generate_report.py from
 * the SOP work) directly from live data — audits, backlog, market share.
 * This is Build 4 from the rollout plan: a first draft the team edits,
 * not a blank page they write from scratch every month.
 *
 * This endpoint does NOT render the PDF itself (that pipeline is a
 * separate Python/Playwright tool) — it produces the data that feeds it.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { clientId: string } }
) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('*')
    .eq('id', params.clientId)
    .single()

  if (clientError || !client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 })
  }

  const now = new Date()
  const reportPeriod = now.toLocaleString('en-US', { month: 'long', year: 'numeric' })
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const nextPeriod = nextMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' })

  // --- Most recent completed audit — source of the current CVR/Fischer Score ---
  const { data: latestAudit } = await supabase
    .from('audits')
    .select('*')
    .eq('client_id', params.clientId)
    .eq('status', 'complete')
    .order('completed_at', { ascending: false })
    .limit(1)
    .single()

  // --- Backlog, split by tier — this is what actually drives report content,
  // not a person remembering what happened this month ---
  const { data: backlogItems } = await supabase
    .from('backlog_items')
    .select('*')
    .eq('client_id', params.clientId)
    .order('updated_at', { ascending: false })

  const shipped = (backlogItems ?? []).filter(i => i.tier === 'shipped').slice(0, 3)
  const thisMonth = (backlogItems ?? []).filter(i => i.tier === 'this_month')
  const next = (backlogItems ?? []).filter(i => i.tier === 'next').slice(0, 3)
  const watching = (backlogItems ?? []).filter(i => i.tier === 'watching')

  // --- Most recent market share analysis — feeds the Fischer Intelligence slot ---
  const { data: latestMarketShare } = await supabase
    .from('market_share_analyses')
    .select('*')
    .eq('client_id', params.clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  const fischerNote = latestMarketShare
    ? `${latestMarketShare.market_position} ${
        latestMarketShare.competitive_gaps?.[0]
          ? `Highest-leverage gap: ${latestMarketShare.competitive_gaps[0].gap}`
          : ''
      }`
    : 'No market share analysis on file yet for this client — run one via /api/market-share to populate this section.'

  // --- Shape matches the existing report generator's expected input exactly ---
  const draft = {
    client_name: client.name,
    client_tagline: '', // left for a human to fill in — varies too much to auto-generate well
    report_period: reportPeriod,
    next_period: nextPeriod,
    prepared_date: now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    conversion_rate: latestAudit?.output?.revenueImpact?.currentConversionRate
      ? `${latestAudit.output.revenueImpact.currentConversionRate}%`
      : 'N/A — no completed audit yet',
    tests_live: thisMonth.length,
    fischer_score: latestAudit?.fischer_score ?? 'N/A',
    issues_shipped: shipped.length,
    queue_remaining: (backlogItems ?? []).length - shipped.length,

    shipped_and_live: [
      ...shipped.map(item => ({
        status: 'shipped',
        title: item.title,
        description: item.description ?? '',
        metric: item.result_summary ?? '(result not yet recorded)'
      })),
      ...thisMonth.map(item => ({
        status: 'live',
        title: item.title,
        description: item.description ?? '',
        metric: 'In progress this month'
      }))
    ],

    backlog: [
      ...thisMonth.map(item => ({ tier: 'now', name: item.title, impact: iceLabel(item.ice_impact), effort: iceLabel(10 - (item.ice_ease ?? 5)), scheduled: reportPeriod })),
      ...next.map(item => ({ tier: 'next', name: item.title, impact: iceLabel(item.ice_impact), effort: iceLabel(10 - (item.ice_ease ?? 5)), scheduled: nextPeriod })),
      ...watching.slice(0, 5).map(item => ({ tier: 'watch', name: item.title, impact: iceLabel(item.ice_impact), effort: iceLabel(10 - (item.ice_ease ?? 5)), scheduled: 'TBC' }))
    ],

    next_month: next.map(item => item.title),
    fischer_note: fischerNote,

    // Metadata, not part of the PDF template — useful for the human reviewing the draft
    _meta: {
      generatedAt: now.toISOString(),
      totalBacklogItems: (backlogItems ?? []).length,
      hasCompletedAudit: !!latestAudit,
      hasMarketShareAnalysis: !!latestMarketShare
    }
  }

  return NextResponse.json({ draft })
}

function iceLabel(value: number | null | undefined): 'High' | 'Medium' | 'Low' {
  if (value == null) return 'Medium'
  if (value >= 7) return 'High'
  if (value >= 4) return 'Medium'
  return 'Low'
}
