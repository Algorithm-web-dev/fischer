/**
 * URL validation for anything Fischer will load in a headless browser or fetch
 * server-side. Blocks private/internal hosts so the audit endpoint can't be
 * used to probe internal infrastructure (SSRF), e.g. cloud metadata services.
 */
export function isValidHttpUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (process.env.FISCHER_ALLOW_PRIVATE_URLS === 'true') return true // local development only
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number)
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false
  }
  if (host.startsWith('[') || host.includes(':')) return false // IPv6 literals
  return true
}
