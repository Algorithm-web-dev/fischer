import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase'
import type { AuditResult } from '@/lib/claude'

/**
 * Takes a completed audit's friction points and creates one backlog_items
 * row per friction point, all starting in "watching" (per the CRO SOP —
 * evidence enters the backlog, it doesn't jump straight to "this month").
 * Every item is tagged evidence_type: 'quant' since it came from an audit;
 * pair it with a Clarity finding later to upgrade it to 'both'.
 */
export async function POST(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { auditId, clientId } = await req.json()
  if (!auditId || !clientId) {
    return NextResponse.json({ error: 'auditId and clientId are required.' }, { status: 400 })
  }

  const { data: audit, error: auditError } = await supabase
    .from('audits')
    .select('output')
    .eq('id', auditId)
    .single()

  if (auditError || !audit?.output) {
    return NextResponse.json({ error: 'Audit not found or has no completed output.' }, { status: 404 })
  }

  const result = audit.output as AuditResult

  const rows = result.frictionPoints.map(fp => ({
    client_id: clientId,
    source_audit_id: auditId,
    title: fp.title,
    description: `${fp.issue}\n\nEvidence: ${fp.evidence}\n\nWhy it matters: ${fp.whyItKillsConversion}\n\nFix: ${fp.fix}`,
    tier: 'watching' as const,
    evidence_type: evidenceType(fp.evidenceSources ?? []),
    evidence_refs: { source: 'fischer_audit', audit_id: auditId, location: fp.location, sources: fp.evidenceSources, confidence: fp.confidence },
    severity: fp.severity,
    ice_impact: fp.severity === 'high' ? 8 : fp.severity === 'medium' ? 5 : 3
  }))

  const { data, error } = await supabase.from('backlog_items').insert(rows).select()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ created: data.length, items: data })
}

/** Clarity = qualitative (behaviour), GA4/PageSpeed = quantitative. */
function evidenceType(sources: string[]): 'quant' | 'qual' | 'both' {
  const qual = sources.includes('clarity')
  const quant = sources.some(s => s === 'ga4' || s === 'pagespeed' || s === 'layout_measurements')
  return qual && quant ? 'both' : qual ? 'qual' : 'quant'
}
