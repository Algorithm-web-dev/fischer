import { NextRequest, NextResponse } from 'next/server'
import { requireRole, bad } from '@/lib/api'
import { googleOAuthConfigured, listGoogleAssets, oauthClient } from '@/lib/google'
import { decryptSecret } from '@/lib/secrets'
import { logActivity } from '@/lib/activity'

/**
 * GET    → connection status + the GA4 properties, Search Console sites and
 *          Ads accounts the connection can see (for the pickers)
 * PATCH  { ga4PropertyId?, gscSiteUrl?, googleAdsCustomerId?, googleAdsLoginCustomerId? }
 * DELETE → disconnect (revokes the token at Google too)
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireRole('admin', 'analyst', 'viewer'); if (auth.error) return auth.error
  const { data: c } = await auth.supabase.from('clients').select('id, ga4_property_id, google_refresh_token, google_email, google_connected_at, gsc_site_url, google_ads_customer_id, google_ads_login_customer_id').eq('id', params.id).single()
  if (!c) return bad('Client not found.', 404)
  const status = {
    configured: googleOAuthConfigured(), connected: !!c.google_refresh_token, email: c.google_email, connectedAt: c.google_connected_at,
    ga4PropertyId: c.ga4_property_id, gscSiteUrl: c.gsc_site_url, googleAdsCustomerId: c.google_ads_customer_id, googleAdsLoginCustomerId: c.google_ads_login_customer_id,
    adsDeveloperToken: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN
  }
  if (!c.google_refresh_token) return NextResponse.json({ status, assets: null })
  try {
    return NextResponse.json({ status, assets: await listGoogleAssets(c) })
  } catch (err) {
    return NextResponse.json({ status, assets: null, error: err instanceof Error ? err.message : 'Could not list Google accounts.' })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireRole('admin', 'analyst'); if (auth.error) return auth.error
  const b = await req.json()
  const updates: Record<string, string | null> = {}
  if (b.ga4PropertyId !== undefined) updates.ga4_property_id = String(b.ga4PropertyId || '').replace(/^properties\//, '') || null
  if (b.gscSiteUrl !== undefined) updates.gsc_site_url = b.gscSiteUrl || null
  if (b.googleAdsCustomerId !== undefined) updates.google_ads_customer_id = b.googleAdsCustomerId || null
  if (b.googleAdsLoginCustomerId !== undefined) updates.google_ads_login_customer_id = b.googleAdsLoginCustomerId || null
  const { error } = await auth.supabase.from('clients').update(updates).eq('id', params.id)
  if (error) return bad(error.message, 500)
  await logActivity(auth.supabase, auth.user, 'google.select', { entityType: 'client', entityId: params.id, clientId: params.id, details: updates })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireRole('admin', 'analyst'); if (auth.error) return auth.error
  const { data: c } = await auth.supabase.from('clients').select('google_refresh_token').eq('id', params.id).single()
  if (c?.google_refresh_token) await oauthClient().revokeToken(decryptSecret(c.google_refresh_token)).catch(() => {})
  const { error } = await auth.supabase.from('clients').update({ google_refresh_token: null, google_email: null, google_connected_at: null }).eq('id', params.id)
  if (error) return bad(error.message, 500)
  await logActivity(auth.supabase, auth.user, 'google.disconnect', { entityType: 'client', entityId: params.id, clientId: params.id })
  return NextResponse.json({ ok: true })
}
