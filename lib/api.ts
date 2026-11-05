import { NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { createSupabaseServerClient } from './supabase'

type Authed = { supabase: ReturnType<typeof createSupabaseServerClient>; user: User; error?: undefined }
type Unauthed = { error: NextResponse; supabase?: undefined; user?: undefined }

/** Team-member session check shared by every authenticated API route. */
export async function requireUser(): Promise<Authed | Unauthed> {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }) }
  return { supabase, user }
}

export const bad = (message: string, status = 400) => NextResponse.json({ error: message }, { status })

/** Like requireUser, but also checks the caller's role (middleware already does; this is for sensitive routes). */
export async function requireRole(...allowed: ('admin' | 'analyst' | 'viewer' | 'client')[]): Promise<(Authed & { role: string }) | Unauthed> {
  const auth = await requireUser()
  if (auth.error) return auth
  const { data: role } = await auth.supabase.rpc('fischer_whoami')
  if (!role || !allowed.includes(role)) return { error: NextResponse.json({ error: 'You do not have permission for this.' }, { status: 403 }) }
  return { ...auth, role }
}

/** Accepts "YYYY-MM" or "YYYY-MM-DD"; returns "YYYY-MM" or null. */
export function parsePeriod(value: string | null | undefined): string | null {
  if (!value) return null
  const m = /^(\d{4})-(0[1-9]|1[0-2])/.exec(value)
  return m ? `${m[1]}-${m[2]}` : null
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  return !!secret && req.headers.get('authorization') === `Bearer ${secret}`
}
