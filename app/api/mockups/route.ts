import { NextRequest, NextResponse } from 'next/server'
import { requireUser, requireRole, bad } from '@/lib/api'
import { createAndStoreMockup } from '@/lib/mockup-store'
import type { AuditResult } from '@/lib/claude'

export const maxDuration = 120

/** GET ?auditId= | ?testId= → mockups · POST { auditId, kind: 'finding'|'hypothesis', index, viewport? } */
export async function GET(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const sp = req.nextUrl.searchParams
  let q = auth.supabase.from('mockups').select('*').order('created_at', { ascending: false }).limit(50)
  if (sp.get('auditId')) q = q.eq('audit_id', sp.get('auditId')!)
  else if (sp.get('testId')) q = q.eq('test_brief_id', sp.get('testId')!)
  else return bad('auditId or testId is required.')
  const { data, error } = await q
  if (error) return bad(error.message, 500)
  return NextResponse.json({ mockups: data })
}

export async function POST(req: NextRequest) {
  const auth = await requireRole('admin', 'analyst'); if (auth.error) return auth.error
  const { auditId, kind, index, viewport } = await req.json()
  const { data: audit } = await auth.supabase.from('audits').select('id, client_id, page_url, output').eq('id', auditId).single()
  if (!audit?.output) return bad('Audit not found.', 404)
  const o = audit.output as AuditResult
  let title: string, change: string, context: string, vp: 'desktop' | 'mobile'
  if (kind === 'hypothesis') {
    const h = o.abTestHypotheses?.[index]
    if (!h) return bad('Hypothesis not found.', 404)
    title = h.name; change = h.variant; context = `Control (current): ${h.control}\nHypothesis: ${h.hypothesis}`
    vp = viewport ?? (h.device === 'desktop' ? 'desktop' : 'mobile')
  } else {
    const f = o.frictionPoints?.[index]
    if (!f) return bad('Finding not found.', 404)
    title = f.title; change = f.fix; context = `Issue: ${f.issue}\nWhere: ${f.location}\nEvidence: ${f.evidence}`
    vp = viewport ?? (/desktop/i.test(f.location) ? 'desktop' : 'mobile')
  }
  try {
    const r = await createAndStoreMockup(auth.supabase, {
      clientId: audit.client_id, auditId: audit.id, source: kind === 'hypothesis' ? 'hypothesis' : 'finding', sourceIndex: index,
      title, pageUrl: audit.page_url, viewport: vp, change, context, userId: auth.user.id
    })
    return NextResponse.json(r)
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Mockup failed.', 500)
  }
}
