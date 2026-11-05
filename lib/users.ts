import { randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Finds a login by email, or creates one with a temporary password (shown to
 * the admin once; the person changes it after first sign-in). Uses the
 * service-role client — call only after checking the caller is an admin.
 */
export async function findOrCreateUser(service: SupabaseClient, email: string): Promise<{ id: string; email: string; tempPassword?: string }> {
  const clean = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error('Enter a valid email address.')
  const existing = await findUserByEmail(service, clean)
  if (existing) return { id: existing.id, email: clean }
  const tempPassword = `F-${randomBytes(9).toString('base64url')}`
  const { data, error } = await service.auth.admin.createUser({ email: clean, password: tempPassword, email_confirm: true })
  if (error || !data.user) throw new Error(`Could not create the login: ${error?.message}`)
  return { id: data.user.id, email: clean, tempPassword }
}

export async function findUserByEmail(service: SupabaseClient, email: string) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(error.message)
    const hit = data.users.find(u => u.email?.toLowerCase() === email)
    if (hit) return hit
    if (data.users.length < 200) return null
  }
  return null
}

export async function emailsById(service: SupabaseClient, ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const want = new Set(ids)
  for (let page = 1; page <= 20 && want.size; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 })
    if (error) break
    for (const u of data.users) if (want.has(u.id)) { out[u.id] = u.email ?? ''; want.delete(u.id) }
    if (data.users.length < 200) break
  }
  return out
}
