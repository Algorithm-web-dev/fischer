import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase'
import { runCompetitorAudit, estimateTraffic, synthesizeMarketShare } from '@/lib/marketshare'
import { isValidHttpUrl } from '@/lib/validate'

export const maxDuration = 300

interface MarketShareRequestBody {
  clientId: string
  clientUrl: string
  clientAuditId?: string   // reuse an existing audit's Fischer Score if available
  clientFischerScore?: number  // or pass one directly if no audit exists yet
  monthlyTraffic?: string
  avgOrderValue?: string
  competitors: { name: string; url: string }[]
}

/**
 * Runs the CRO SOP's Section 06 (Market & Competitor Intelligence) end to
 * end: a lightweight audit per competitor, a traffic estimate per competitor,
 * then a synthesis. Cadence (monthly light refresh vs quarterly full re-audit
 * vs on-request) is a scheduling decision made by whoever calls this route —
 * this endpoint just does the work when asked.
 */
export async function POST(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const body: MarketShareRequestBody = await req.json()

  if (!body.clientId || !body.clientUrl || !body.competitors?.length) {
    return NextResponse.json({ error: 'clientId, clientUrl, and at least one competitor are required.' }, { status: 400 })
  }

  // Resolve the client's own Fischer Score — from a passed-in audit, a direct
  // score, or fail clearly rather than guessing one.
  let clientScore = body.clientFischerScore
  if (!clientScore && body.clientAuditId) {
    const { data: audit } = await supabase.from('audits').select('fischer_score').eq('id', body.clientAuditId).single()
    clientScore = audit?.fischer_score ?? undefined
  }
  if (!clientScore) {
    return NextResponse.json({ error: 'Provide clientAuditId (with a completed audit) or clientFischerScore.' }, { status: 400 })
  }

  try {
    if (body.competitors.length > 5) {
      return NextResponse.json({ error: 'Up to 5 competitors per analysis.' }, { status: 400 })
    }
    for (const c of body.competitors) {
      if (!isValidHttpUrl(c.url)) return NextResponse.json({ error: `Invalid competitor URL: ${c.url}` }, { status: 400 })
    }
    // --- One competitor at a time: each capture launches a browser, and several
    // at once exhausts a serverless function's memory. Traffic estimates
    // (no browser) run alongside each capture. ---
    const competitorResults = []
    for (const comp of body.competitors) {
      const [audit, traffic] = await Promise.all([
        runCompetitorAudit(comp.url),
        estimateTraffic(comp.url).catch(() => ({ monthlyVisits: 'Unknown', source: 'web_search' as const, confidence: 'low' as const }))
      ])
      competitorResults.push({ ...comp, audit, traffic })
    }

    // --- Persist each competitor audit ---
    const competitorAuditRows = await Promise.all(
      competitorResults.map(async (c) => {
        const { data, error } = await supabase
          .from('competitor_audits')
          .insert({
            client_id: body.clientId,
            competitor_name: c.name,
            competitor_url: c.url,
            fischer_score: c.audit.result.fischerScore,
            top_friction_points: c.audit.result.topFrictionPoints,
            traffic_estimate: c.traffic,
            scraped_content: c.audit.scraped ?? { error: c.audit.scrapeError },
            status: 'complete',
            created_by: user.id
          })
          .select()
          .single()

        if (error) console.error(`Failed to persist competitor audit for ${c.name}:`, error)
        return data
      })
    )

    // --- Synthesize the market share analysis from all competitor results ---
    const synthesis = await synthesizeMarketShare({
      clientUrl: body.clientUrl,
      clientScore,
      monthlyTraffic: body.monthlyTraffic,
      avgOrderValue: body.avgOrderValue,
      competitors: competitorResults.map(c => ({
        name: c.name,
        url: c.url,
        score: c.audit.result.fischerScore,
        topFrictionPoints: c.audit.result.topFrictionPoints,
        traffic: c.traffic
      }))
    })

    const { data: analysisRow, error: analysisError } = await supabase
      .from('market_share_analyses')
      .insert({
        client_id: body.clientId,
        client_audit_id: body.clientAuditId ?? null,
        competitor_audit_ids: competitorAuditRows.filter(Boolean).map(r => r!.id),
        market_position: synthesis.marketPosition,
        competitive_gaps: synthesis.competitiveGaps,
        revenue_opportunity: synthesis.revenueOpportunity,
        recovery_roadmap: synthesis.recoveryRoadmap,
        created_by: user.id
      })
      .select()
      .single()

    if (analysisError) {
      console.error('Failed to persist market share analysis:', analysisError)
    }

    return NextResponse.json({
      marketShareAnalysisId: analysisRow?.id,
      competitorAudits: competitorResults.map((c, i) => ({
        name: c.name,
        url: c.url,
        fischerScore: c.audit.result.fischerScore,
        rating: c.audit.result.rating,
        topFrictionPoints: c.audit.result.topFrictionPoints,
        traffic: c.traffic,
        id: competitorAuditRows[i]?.id
      })),
      synthesis
    })
  } catch (err) {
    console.error('Market share analysis error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Market share analysis failed.' },
      { status: 500 }
    )
  }
}

export async function GET(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) return NextResponse.json({ error: 'clientId query param is required.' }, { status: 400 })

  const { data, error } = await supabase
    .from('market_share_analyses')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(10)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ analyses: data })
}
