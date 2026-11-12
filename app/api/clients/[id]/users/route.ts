import { NextRequest, NextResponse } from 'next/server'
import { requireRole, bad } from '@/lib/api'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { findOrCreateUser, emailsById } from '@/lib/users'
import { logActivity } from '@/lib/activity'

/** Client portal logins for one client. Listing: team; adding/removing: admins. */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireRole('admin', 'analyst', 'viewer'); if (auth.error) return auth.error
  const { data, error } = await auth.supabase.from('client_users').select('*').eq('client_id', params.id)
  if (error) return bad(error.message, 500)
  const emails = await emailsById(createSupabaseServiceClient(), (data ?? []).map(u => u.user_id))
  return NextResponse.json({ users: (data ?? []).map(u => ({ ...u, email: emails[u.user_id] ?? '(unknown)' })) })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireRole('admin'); if (auth.error) return auth.error
  const { email } = await req.json()
  try {
    const service = createSupabaseServiceClient()
    const u = await findOrCreateUser(service, String(email ?? ''))
    const { data: team } = await service.from('team_members').select('user_id').eq('user_id', u.id).maybeSingle()
    if (team) return bad('That email belongs to a team member. Client portal users need their own login.')
    const { error } = await auth.supabase.from('client_users').upsert({ user_id: u.id, client_id: params.id })
    if (error) return bad(error.message, 500)
    await logActivity(auth.supabase, auth.user, 'portal.add', { entityType: 'user', entityId: u.id, clientId: params.id, details: { email: u.email } })
    return NextResponse.json({ user: { user_id: u.id, email: u.email }, tempPassword: u.tempPassword ?? null })
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed.')
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireRole('admin'); if (auth.error) return auth.error
  const userId = req.nextUrl.searchParams.get('userId')
  if (!userId) return bad('userId is required.')
  const { error } = await auth.supabase.from('client_users').delete().eq('client_id', params.id).eq('user_id', userId)
  if (error) return bad(error.message, 500)
  await logActivity(auth.supabase, auth.user, 'portal.remove', { entityType: 'user', entityId: userId, clientId: params.id })
  return NextResponse.json({ ok: true })
}
