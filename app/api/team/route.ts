import { NextRequest, NextResponse } from 'next/server'
import { requireRole, bad } from '@/lib/api'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { findOrCreateUser, emailsById } from '@/lib/users'
import { logActivity } from '@/lib/activity'

const ROLES = ['admin', 'analyst', 'viewer']

/** Team management (admins only). */
export async function GET() {
  const auth = await requireRole('admin'); if (auth.error) return auth.error
  const { data, error } = await auth.supabase.from('team_members').select('*').order('created_at')
  if (error) return bad(error.message, 500)
  const emails = await emailsById(createSupabaseServiceClient(), (data ?? []).map(m => m.user_id))
  const { data: activity } = await auth.supabase.from('activity_log').select('*').order('created_at', { ascending: false }).limit(100)
  return NextResponse.json({ members: (data ?? []).map(m => ({ ...m, email: emails[m.user_id] ?? '(unknown)' })), activity: activity ?? [], me: auth.user.id })
}

/** POST { email, role } → adds a team member (creates the login if needed; returns a temporary password once). */
export async function POST(req: NextRequest) {
  const auth = await requireRole('admin'); if (auth.error) return auth.error
  const { email, role } = await req.json()
  if (!ROLES.includes(role)) return bad('role must be admin, analyst or viewer.')
  try {
    const service = createSupabaseServiceClient()
    const u = await findOrCreateUser(service, String(email ?? ''))
    const { data: portal } = await service.from('client_users').select('client_id').eq('user_id', u.id).limit(1)
    if (portal?.length) return bad('That email is a client portal user. Use a different email for team access.')
    const { error } = await auth.supabase.from('team_members').upsert({ user_id: u.id, role })
    if (error) return bad(error.message, 500)
    await logActivity(auth.supabase, auth.user, 'team.add', { entityType: 'user', entityId: u.id, details: { email: u.email, role } })
    return NextResponse.json({ member: { user_id: u.id, email: u.email, role }, tempPassword: u.tempPassword ?? null })
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed.')
  }
}

/** PATCH { userId, role } */
export async function PATCH(req: NextRequest) {
  const auth = await requireRole('admin'); if (auth.error) return auth.error
  const { userId, role } = await req.json()
  if (!ROLES.includes(role)) return bad('role must be admin, analyst or viewer.')
  if (userId === auth.user.id && role !== 'admin') return bad("You can't remove your own admin role.")
  const { error } = await auth.supabase.from('team_members').update({ role }).eq('user_id', userId)
  if (error) return bad(error.message, 500)
  await logActivity(auth.supabase, auth.user, 'team.role', { entityType: 'user', entityId: userId, details: { role } })
  return NextResponse.json({ ok: true })
}

/** DELETE ?userId= → removes team access (the login itself remains). */
export async function DELETE(req: NextRequest) {
  const auth = await requireRole('admin'); if (auth.error) return auth.error
  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) return bad('userId is required.')
  if (userId === auth.user.id) return bad("You can't remove yourself.")
  const { error } = await auth.supabase.from('team_members').delete().eq('user_id', userId)
  if (error) return bad(error.message, 500)
  await logActivity(auth.supabase, auth.user, 'team.remove', { entityType: 'user', entityId: userId })
  return NextResponse.json({ ok: true })
}
