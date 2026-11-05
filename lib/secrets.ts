import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

/**
 * Encryption at rest for third-party credentials (Clarity API tokens, Google
 * OAuth refresh tokens). AES-256-GCM with a key from FISCHER_ENCRYPTION_KEY
 * (32 bytes, base64 or hex — generate with `openssl rand -base64 32`).
 *
 * Stored format: "enc:v1:<iv>:<tag>:<ciphertext>" (base64url parts).
 * Values without the prefix are treated as legacy plain text and returned as
 * is, so existing rows keep working; run scripts/encrypt-secrets.ts once to
 * encrypt them.
 */
const PREFIX = 'enc:v1:'

function key(): Buffer | null {
  const raw = process.env.FISCHER_ENCRYPTION_KEY
  if (!raw) return null
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (buf.length !== 32) throw new Error('FISCHER_ENCRYPTION_KEY must be 32 bytes (base64 or 64 hex characters).')
  return buf
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

export function encryptSecret(plain: string): string {
  if (!plain || isEncrypted(plain)) return plain
  const k = key()
  if (!k) {
    if (process.env.NODE_ENV === 'production') throw new Error('FISCHER_ENCRYPTION_KEY is not set — refusing to store a credential unencrypted.')
    console.warn('[fischer] FISCHER_ENCRYPTION_KEY not set — storing credential unencrypted (development only).')
    return plain
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${PREFIX}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${data.toString('base64url')}`
}

export function decryptSecret(value: string | null | undefined): string {
  if (!value) return ''
  if (!isEncrypted(value)) return value
  const k = key()
  if (!k) throw new Error('FISCHER_ENCRYPTION_KEY is not set, so stored credentials cannot be decrypted.')
  const [ivB, tagB, dataB] = value.slice(PREFIX.length).split(':')
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(ivB, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64url')), decipher.final()]).toString('utf8')
}
