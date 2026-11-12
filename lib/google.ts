import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { OAuth2Client } from 'google-auth-library'
import { decryptSecret } from './secrets'

/**
 * One-click Google connection (OAuth) for GA4, Search Console and Google Ads.
 *
 * Setup (once, in Google Cloud Console → APIs & Services):
 *  1. Enable: Google Analytics Data API, Google Analytics Admin API,
 *     Search Console API, Google Ads API.
 *  2. OAuth consent screen (External; add the scopes below).
 *  3. Credentials → OAuth client ID (Web) with redirect URI
 *     {FISCHER_PUBLIC_URL}/api/google/callback
 *  4. Set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.
 *  5. Google Ads only: GOOGLE_ADS_DEVELOPER_TOKEN (Ads API Center).
 *
 * The client (or whoever has access to their Google accounts) clicks
 * "Connect Google" and approves read-only access. The refresh token is stored
 * encrypted on the client row. Clients without a connection keep using the
 * service account (GOOGLE_SERVICE_ACCOUNT_KEY).
 */
export const GOOGLE_SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/adwords'
]

export function googleOAuthConfigured(): boolean {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET)
}

export function oauthClient(redirectUri?: string): OAuth2Client {
  return new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri)
}

// ---------------------------------------------------------------- signed state (CSRF protection)
function stateKey() {
  const k = process.env.FISCHER_ENCRYPTION_KEY || process.env.CRON_SECRET
  if (!k) throw new Error('Set FISCHER_ENCRYPTION_KEY to use Google sign-in.')
  return k
}
export function signState(payload: { clientId: string; userId: string }): string {
  const body = Buffer.from(JSON.stringify({ ...payload, n: randomBytes(8).toString('hex'), exp: Date.now() + 15 * 60_000 })).toString('base64url')
  const sig = createHmac('sha256', stateKey()).update(body).digest('base64url')
  return `${body}.${sig}`
}
export function verifyState(state: string): { clientId: string; userId: string } | null {
  const [body, sig] = String(state || '').split('.')
  if (!body || !sig) return null
  const expected = createHmac('sha256', stateKey()).update(body).digest('base64url')
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (typeof p.exp !== 'number' || p.exp < Date.now()) return null
    return { clientId: p.clientId, userId: p.userId }
  } catch { return null }
}

// ---------------------------------------------------------------- per-client auth registry
// GA4 helpers take a property id. When a client has a Google connection we
// register its OAuth client against that property, so every GA4 call for it
// uses the client's own sign-in instead of the service account.
const byProperty = new Map<string, OAuth2Client>()
const byClient = new Map<string, OAuth2Client>()

export interface GoogleClientFields {
  id: string
  ga4_property_id?: string | null
  google_refresh_token?: string | null
}

export function registerGoogleAuth(client: GoogleClientFields | null | undefined): OAuth2Client | null {
  if (!client?.google_refresh_token || !googleOAuthConfigured()) return null
  let auth = byClient.get(client.id)
  if (!auth) {
    auth = oauthClient()
    auth.setCredentials({ refresh_token: decryptSecret(client.google_refresh_token) })
    byClient.set(client.id, auth)
  }
  if (client.ga4_property_id) byProperty.set(String(client.ga4_property_id), auth)
  return auth
}

export function authForProperty(propertyId: string | undefined | null): OAuth2Client | null {
  return propertyId ? byProperty.get(String(propertyId)) ?? null : null
}

export async function accessToken(client: GoogleClientFields): Promise<string> {
  const auth = registerGoogleAuth(client)
  if (!auth) throw new Error('This client has no Google connection. Use "Connect Google" in Settings.')
  const { token } = await auth.getAccessToken()
  if (!token) throw new Error('Google did not return an access token — reconnect Google for this client.')
  return token
}

/** Lists GA4 properties, Search Console sites and Google Ads accounts the connection can see. */
export async function listGoogleAssets(client: GoogleClientFields) {
  const token = await accessToken(client)
  const h = { Authorization: `Bearer ${token}` }
  const out: {
    ga4: { property: string; displayName: string; account: string }[]
    searchConsole: { siteUrl: string; permission: string }[]
    ads: { customerId: string }[]
    errors: string[]
  } = { ga4: [], searchConsole: [], ads: [], errors: [] }

  const ga = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', { headers: h })
  if (ga.ok) {
    const j = await ga.json()
    for (const a of j.accountSummaries ?? []) for (const p of a.propertySummaries ?? []) {
      out.ga4.push({ property: String(p.property).replace('properties/', ''), displayName: p.displayName, account: a.displayName })
    }
  } else out.errors.push(`GA4: ${ga.status} ${(await ga.text()).slice(0, 160)}`)

  const sc = await fetch('https://www.googleapis.com/webmasters/v3/sites', { headers: h })
  if (sc.ok) out.searchConsole = ((await sc.json()).siteEntry ?? []).map((s: any) => ({ siteUrl: s.siteUrl, permission: s.permissionLevel }))
  else out.errors.push(`Search Console: ${sc.status} ${(await sc.text()).slice(0, 160)}`)

  if (process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    const ads = await fetch(`https://googleads.googleapis.com/${adsVersion()}/customers:listAccessibleCustomers`, {
      headers: { ...h, 'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN }
    })
    if (ads.ok) out.ads = ((await ads.json()).resourceNames ?? []).map((r: string) => ({ customerId: r.replace('customers/', '') }))
    else out.errors.push(`Google Ads: ${ads.status} ${(await ads.text()).slice(0, 160)}`)
  } else out.errors.push('Google Ads: set GOOGLE_ADS_DEVELOPER_TOKEN to list ad accounts.')
  return out
}

export function adsVersion() {
  return process.env.GOOGLE_ADS_API_VERSION || 'v21'
}
