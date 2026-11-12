import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'

/** Audit history (every run is stored). Filter by clientId and/or pageUrl. */
export async function GET(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const sp = req.nextUrl.searchParams
  let q = auth.supabase.from('audits')
    .select('id, client_id, client_name, page_url, page_type, status, fischer_score, trigger, created_at, completed_at, error_message, screenshot_desktop_url, page_diff, previous_audit_id')
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(sp.get('limit') || 100), 500))
  if (sp.get('clientId')) q = q.eq('client_id', sp.get('clientId')!)
  if (sp.get('pageUrl')) q = q.eq('page_url', sp.get('pageUrl')!)
  if (sp.get('status')) q = q.eq('status', sp.get('status')!)
  const { data, error } = await q
  if (error) return bad(error.message, 500)
  return NextResponse.json({ audits: data })
}
