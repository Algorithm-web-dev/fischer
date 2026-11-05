import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/api'
import { oauthClient, verifyState } from '@/lib/google'
import { encryptSecret } from '@/lib/secrets'
import { logActivity } from '@/lib/activity'

/** Google redirects here after consent. Stores the (encrypted) refresh token on the client. */
export async function GET(req: NextRequest) {
  const origin = process.env.FISCHER_PUBLIC_URL || req.nextUrl.origin
  const back = (clientId: string | null, status: string) =>
    NextResponse.redirect(new URL(clientId ? `/clients/${clientId}?tab=settings&google=${status}` : `/clients?google=${status}`, origin))

  const auth = await requireRole('admin', 'analyst'); if (auth.error) return auth.error
  const state = verifyState(req.nextUrl.searchParams.get('state') ?? '')
  if (!state || state.userId !== auth.user.id) return back(null, 'invalid_state')
  if (req.nextUrl.searchParams.get('error')) return back(state.clientId, 'denied')

  try {
    const oauth = oauthClient(`${origin}/api/google/callback`)
    const { tokens } = await oauth.getToken(req.nextUrl.searchParams.get('code') ?? '')
    if (!tokens.refresh_token) return back(state.clientId, 'no_refresh_token')
    let email: string | null = null
    if (tokens.id_token) {
      const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_OAUTH_CLIENT_ID })
      email = ticket.getPayload()?.email ?? null
    }
    const { error } = await auth.supabase.from('clients').update({
      google_refresh_token: encryptSecret(tokens.refresh_token),
      google_email: email,
      google_connected_at: new Date().toISOString()
    }).eq('id', state.clientId)
    if (error) return back(state.clientId, 'save_failed')
    await logActivity(auth.supabase, auth.user, 'google.connect', { entityType: 'client', entityId: state.clientId, clientId: state.clientId, details: { email } })
    return back(state.clientId, 'connected')
  } catch {
    return back(state.clientId, 'failed')
  }
}
