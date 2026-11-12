/**
 * One-off: encrypts any Clarity API tokens still stored as plain text.
 * Needs FISCHER_ENCRYPTION_KEY and SUPABASE_SERVICE_ROLE_KEY.
 *
 *   npx tsx --env-file=.env.local scripts/encrypt-secrets.ts
 *
 * Safe to run more than once (already-encrypted values are skipped).
 */
import { createSupabaseServiceClient } from '../lib/supabase'
import { encryptSecret, isEncrypted, decryptSecret } from '../lib/secrets'

async function main() {
  if (!process.env.FISCHER_ENCRYPTION_KEY) throw new Error('Set FISCHER_ENCRYPTION_KEY first (openssl rand -base64 32).')
  const sb = createSupabaseServiceClient()
  const { data, error } = await sb.from('clients').select('id, name, clarity_api_token').not('clarity_api_token', 'is', null)
  if (error) throw new Error(error.message)
  let done = 0
  for (const c of data ?? []) {
    if (isEncrypted(c.clarity_api_token)) continue
    const enc = encryptSecret(c.clarity_api_token)
    if (decryptSecret(enc) !== c.clarity_api_token) throw new Error(`Round-trip check failed for ${c.name}`)
    const { error: e } = await sb.from('clients').update({ clarity_api_token: enc }).eq('id', c.id)
    if (e) throw new Error(`${c.name}: ${e.message}`)
    done++
    console.log(`encrypted: ${c.name}`)
  }
  console.log(`${done} token(s) encrypted, ${(data ?? []).length - done} already encrypted.`)
}
main().catch(err => { console.error(err.message); process.exit(1) })
