import { NextRequest, NextResponse } from 'next/server'
import { requireRole, bad } from '@/lib/api'
import { getBranding, brandingUpdate } from '@/lib/branding'
import { logActivity } from '@/lib/activity'

/** Agency branding & email sender settings. GET: team · PATCH: admins */
export async function GET() {
  const auth = await requireRole('admin', 'analyst', 'viewer'); if (auth.error) return auth.error
  return NextResponse.json({ branding: await getBranding(auth.supabase), emailConfigured: !!process.env.RESEND_API_KEY })
}

export async function PATCH(req: NextRequest) {
  const auth = await requireRole('admin'); if (auth.error) return auth.error
  const u = brandingUpdate(await req.json())
  if (typeof u === 'string') return bad(u)
  const { error } = await auth.supabase.from('agency_settings').upsert({ id: 1, ...u })
  if (error) return bad(error.message, 500)
  await logActivity(auth.supabase, auth.user, 'settings.branding', { details: { fields: Object.keys(u) } })
  return NextResponse.json({ branding: await getBranding(auth.supabase) })
}
