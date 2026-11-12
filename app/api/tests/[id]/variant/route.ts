import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { requireRole, bad } from '@/lib/api'
import { createAndStoreMockup } from '@/lib/mockup-store'
import { logActivity } from '@/lib/activity'

export const maxDuration = 120

/**
 * POST { viewport? } → builds the test's variant as page edits from its brief,
 * renders a before/after mockup, and stores the edits on the test so the
 * tracking kit can run it live (PATCH /api/tests/[id] with kitLive: true).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireRole('admin', 'analyst'); if (auth.error) return auth.error
  const body = await req.json().catch(() => ({}))
  const { data: t } = await auth.supabase.from('test_briefs').select('*').eq('id', params.id).single()
  if (!t) return bad('Test not found.', 404)
  if (!t.page_url) return bad('This test has no page URL.')

  const b = t.brief ?? {}
  const change = [b.variant?.description ?? t.hypothesis?.variant, b.variant?.newCopy && `Exact new copy: ${b.variant.newCopy}`, ...(b.variant?.changes ?? [])].filter(Boolean).join('\n')
  const context = [b.control?.description && `Control: ${b.control.description}`, b.control?.currentCopy && `Current copy: ${b.control.currentCopy}`, b.variant?.implementation_notes && `Targeting notes: ${b.variant.implementation_notes}`].filter(Boolean).join('\n')
  const viewport = body.viewport ?? (t.hypothesis?.device === 'desktop' ? 'desktop' : 'mobile')

  try {
    const r = await createAndStoreMockup(auth.supabase, {
      clientId: t.client_id, auditId: t.source_audit_id, testBriefId: t.id, source: 'test',
      title: t.hypothesis_name, pageUrl: t.page_url, viewport, change, context, userId: auth.user.id
    })
    if (!r.mockup.ops?.length) return NextResponse.json({ ...r, test: t })
    let path = '/'
    try { path = new URL(t.page_url).pathname } catch { /* keep / */ }
    const { data: saved, error } = await auth.supabase.from('test_briefs').update({
      variant_ops: r.mockup.ops,
      kit_key: t.kit_key ?? `fx${randomBytes(3).toString('hex')}`,
      kit_url_match: t.kit_url_match ?? path,
      kit_device: t.hypothesis?.device ?? 'all'
    }).eq('id', t.id).select().single()
    if (error) return bad(error.message, 500)
    await logActivity(auth.supabase, auth.user, 'test.variant', { entityType: 'test', entityId: t.id, clientId: t.client_id, details: { ops: r.mockup.ops.length } })
    return NextResponse.json({ ...r, test: saved })
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Variant generation failed.', 500)
  }
}
