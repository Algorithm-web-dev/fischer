import type { SupabaseClient } from '@supabase/supabase-js'
import { generateMockup } from './mockup'
import { SCREENSHOT_BUCKET } from './audit-pipeline'
import type { DomOp } from './dom-ops'
import type { ViewportName } from './capture'

/** Generates a mockup, uploads before/after images and stores the row. */
export async function createAndStoreMockup(supabase: SupabaseClient, p: {
  clientId: string | null
  auditId?: string | null
  testBriefId?: string | null
  source: 'finding' | 'hypothesis' | 'test'
  sourceIndex?: number | null
  title: string
  pageUrl: string
  viewport: ViewportName
  change: string
  context?: string
  existingOps?: DomOp[]
  userId?: string | null
}) {
  const r = await generateMockup({ url: p.pageUrl, viewport: p.viewport, change: p.change, context: p.context, existingOps: p.existingOps, track: { feature: 'mockup', clientId: p.clientId, auditId: p.auditId ?? null } })
  const id = crypto.randomUUID()
  const upload = async (name: string, b64: string | null) => {
    if (!b64) return null
    const path = `mockups/${id}/${name}.jpg`
    const { error } = await supabase.storage.from(SCREENSHOT_BUCKET).upload(path, Buffer.from(b64, 'base64'), { contentType: 'image/jpeg', upsert: true })
    return error ? null : supabase.storage.from(SCREENSHOT_BUCKET).getPublicUrl(path).data.publicUrl
  }
  const [beforeUrl, afterUrl] = await Promise.all([upload('before', r.before), upload('after', r.after)])
  const { data, error } = await supabase.from('mockups').insert({
    id, client_id: p.clientId, audit_id: p.auditId ?? null, test_brief_id: p.testBriefId ?? null,
    source: p.source, source_index: p.sourceIndex ?? null, title: p.title, page_url: p.pageUrl, viewport: p.viewport,
    ops: r.ops, summary: r.summary || r.notPossible, applied: r.applied, before_url: beforeUrl, after_url: afterUrl, created_by: p.userId ?? null
  }).select().single()
  if (error) throw new Error(`Saving mockup failed: ${error.message}`)
  return { mockup: data, notPossible: r.notPossible }
}
