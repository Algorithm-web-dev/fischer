import { NextRequest, NextResponse } from 'next/server'
import { requireRole, bad } from '@/lib/api'
import { discoverSite } from '@/lib/discovery'

export const maxDuration = 120

/** GET → latest site scan · POST → scan the client's site now (sitemap → key pages → broken pages) */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireRole('admin', 'analyst', 'viewer'); if (auth.error) return auth.error
  const { data } = await auth.supabase.from('site_scans').select('result, created_at').eq('client_id', params.id).order('created_at', { ascending: false }).limit(1)
  return NextResponse.json({ scan: data?.[0] ?? null })
}

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireRole('admin', 'analyst'); if (auth.error) return auth.error
  const { data: client } = await auth.supabase.from('clients').select('primary_url').eq('id', params.id).single()
  if (!client?.primary_url) return bad('Set the client website in Settings first.')
  try {
    const result = await discoverSite(client.primary_url)
    const { data } = await auth.supabase.from('site_scans').insert({ client_id: params.id, result, created_by: auth.user.id }).select('result, created_at').single()
    return NextResponse.json({ scan: data })
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Scan failed.', 502)
  }
}
