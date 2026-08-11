import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase'
import { scorePxl } from '@/lib/pxl'

/**
 * Scores one backlog item against PXL — per the CRO SOP, this should run on
 * the ICE-sorted shortlist before an item is allowed to move into "next" or
 * "this_month" (Tier A default; Tier B/C on request). Grounded in the
 * source audit's friction point context when available, not scored blind.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { data: item, error } = await supabase
    .from('backlog_items')
    .select('*, audits:source_audit_id (output)')
    .eq('id', params.id)
    .single()

  if (error || !item) {
    return NextResponse.json({ error: 'Backlog item not found.' }, { status: 404 })
  }

  // Pull richer context from the source audit's friction points, if this item
  // was promoted from one — gives PXL something concrete to evaluate against
  // rather than just the title/description already on the backlog row.
  let auditContext: string | undefined
  const sourceOutput = (item as any).audits?.output
  if (sourceOutput?.frictionPoints) {
    const matching = sourceOutput.frictionPoints.find((fp: any) => fp.title === item.title)
    if (matching) {
      auditContext = `Location: ${matching.location}\nIssue: ${matching.issue}\nWhy it kills conversion: ${matching.whyItKillsConversion}`
    }
  }

  try {
    const pxlScore = await scorePxl({
      title: item.title,
      description: item.description || '',
      evidenceType: item.evidence_type,
      auditContext
    })

    const { data: updated, error: updateError } = await supabase
      .from('backlog_items')
      .update({ pxl_score: pxlScore })
      .eq('id', params.id)
      .select()
      .single()

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

    return NextResponse.json({ item: updated })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'PXL scoring failed.' },
      { status: 500 }
    )
  }
}
