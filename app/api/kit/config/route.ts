import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { cleanOps } from '@/lib/dom-ops'

/**
 * Public: live A/B tests for a website, read by public/fischer-tracking.js.
 * GET ?host=www.acme.co.za → { tests: [{ key, urlMatch, split, device, ops }] }
 * Returns only what visitors receive anyway (the variant's page edits).
 */
export async function GET(req: NextRequest) {
  const host = (req.nextUrl.searchParams.get('host') || '').toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '')
  const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60, s-maxage=60' }
  if (!host) return NextResponse.json({ tests: [] }, { headers })

  const supabase = createSupabaseServiceClient()
  const { data: clients } = await supabase.from('clients').select('id, primary_url').not('primary_url', 'is', null)
  const ids = (clients ?? []).filter(c => {
    try { return new URL(c.primary_url).hostname.toLowerCase().replace(/^www\./, '') === host } catch { return false }
  }).map(c => c.id)
  if (!ids.length) return NextResponse.json({ tests: [] }, { headers })

  const { data: tests } = await supabase.from('test_briefs')
    .select('kit_key, kit_url_match, kit_split, kit_device, variant_ops')
    .in('client_id', ids).eq('kit_live', true).eq('status', 'running').not('variant_ops', 'is', null)
  return NextResponse.json({
    tests: (tests ?? []).map(t => ({
      key: t.kit_key, urlMatch: t.kit_url_match || '/', split: Number(t.kit_split) || 0.5, device: t.kit_device,
      ops: cleanOps(t.variant_ops ?? []).ops
    }))
  }, { headers })
}
