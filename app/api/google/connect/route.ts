import { NextRequest, NextResponse } from 'next/server'
import { requireRole, bad } from '@/lib/api'
import { GOOGLE_SCOPES, googleOAuthConfigured, oauthClient, signState } from '@/lib/google'

/** GET ?clientId=… → redirects to Google's consent screen (read-only GA4, Search Console, Ads). */
export async function GET(req: NextRequest) {
  const auth = await requireRole('admin', 'analyst'); if (auth.error) return auth.error
  if (!googleOAuthConfigured()) return bad('Google sign-in is not set up: add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.', 501)
  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) return bad('clientId is required.')
  const origin = process.env.FISCHER_PUBLIC_URL || req.nextUrl.origin
  const url = oauthClient(`${origin}/api/google/callback`).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',          // always return a refresh token
    include_granted_scopes: true,
    scope: GOOGLE_SCOPES,
    state: signState({ clientId, userId: auth.user.id })
  })
  return NextResponse.redirect(url)
}
