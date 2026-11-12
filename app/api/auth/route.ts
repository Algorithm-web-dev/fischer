import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase'
import { authRateLimit, checkRateLimit } from '@/lib/ratelimit'

/**
 * Real per-user login via Supabase Auth. Replaces the old shared-password
 * model — the old version stored the literal team password as the cookie
 * value and compared it in plaintext on every request, with no per-user
 * identity. Every team member now has their own Supabase Auth account
 * (create these in the Supabase dashboard under Authentication > Users,
 * or via supabase.auth.admin.createUser from a setup script).
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

  const { allowed, resetAt } = await checkRateLimit(authRateLimit, ip)
  if (!allowed) {
    return NextResponse.json(
      { error: `Too many login attempts. Try again after ${new Date(resetAt).toLocaleTimeString()}.` },
      { status: 429 }
    )
  }

  const { email, password } = await req.json()

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 })
  }

  const supabase = createSupabaseServerClient()

  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error || !data.session) {
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 })
  }

  // Supabase's SSR helper already set the session cookies via the cookie
  // adapter in lib/supabase.ts — nothing further to do here.
  return NextResponse.json({ ok: true, user: { id: data.user.id, email: data.user.email } })
}

export async function DELETE(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  await supabase.auth.signOut()
  return NextResponse.json({ ok: true })
}

/** PATCH { currentPassword, newPassword } — change your own password (e.g. replace a temporary one). */
export async function PATCH(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  const { currentPassword, newPassword } = await req.json()
  if (typeof newPassword !== 'string' || newPassword.length < 10) {
    return NextResponse.json({ error: 'Use at least 10 characters.' }, { status: 400 })
  }
  // Re-check the current password so a hijacked session can't silently change it.
  const { error: wrong } = await supabase.auth.signInWithPassword({ email: user.email, password: String(currentPassword ?? '') })
  if (wrong) return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 400 })
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ ok: true })
}
