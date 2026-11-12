/**
 * Which required settings are missing — names only, never values.
 * Used by /api/health and to turn configuration crashes into clear messages.
 */
const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY', 'CRON_SECRET', 'FISCHER_ENCRYPTION_KEY', 'FISCHER_PUBLIC_URL'
]
const OPTIONAL = [
  'GOOGLE_PAGESPEED_API_KEY', 'GOOGLE_SERVICE_ACCOUNT_KEY', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_ADS_DEVELOPER_TOKEN', 'RESEND_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'ALERT_WEBHOOK_URL'
]

export function envStatus() {
  const present = (k: string) => typeof process.env[k] === 'string' && process.env[k]!.trim().length > 0
  const problems: string[] = []
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  if (url && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url.trim())) problems.push('NEXT_PUBLIC_SUPABASE_URL should look like https://<project-id>.supabase.co')
  if (url !== url.trim()) problems.push('NEXT_PUBLIC_SUPABASE_URL has spaces or a line break around it')
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
  if (anon && /^sb_secret_/.test(anon.trim())) problems.push('NEXT_PUBLIC_SUPABASE_ANON_KEY holds the SECRET key — it must be the publishable key')
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  if (svc && /^sb_publishable_/.test(svc.trim())) problems.push('SUPABASE_SERVICE_ROLE_KEY holds the publishable key — it must be the secret key')
  if ((process.env.UPSTASH_REDIS_REST_URL ? 1 : 0) + (process.env.UPSTASH_REDIS_REST_TOKEN ? 1 : 0) === 1) problems.push('Set both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or neither')
  return {
    missing: REQUIRED.filter(k => !present(k)),
    optionalMissing: OPTIONAL.filter(k => !present(k)),
    problems
  }
}
