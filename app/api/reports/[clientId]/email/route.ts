import { NextRequest, NextResponse } from 'next/server'
import { requireRole, bad, parsePeriod } from '@/lib/api'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { sendReportEmail } from '@/lib/report-email'
import { previousPeriod } from '@/lib/snapshots'
import { logActivity } from '@/lib/activity'

export const maxDuration = 120

/** GET → email history · POST { period?, recipients? } → send the report email now */
export async function GET(_req: NextRequest, { params }: { params: { clientId: string } }) {
  const auth = await requireRole('admin', 'analyst', 'viewer'); if (auth.error) return auth.error
  const { data } = await auth.supabase.from('report_emails').select('period, recipients, status, error, created_at')
    .eq('client_id', params.clientId).order('created_at', { ascending: false }).limit(24)
  return NextResponse.json({ emails: data ?? [] })
}

export async function POST(req: NextRequest, { params }: { params: { clientId: string } }) {
  const auth = await requireRole('admin', 'analyst'); if (auth.error) return auth.error
  const body = await req.json().catch(() => ({}))
  const period = parsePeriod(body.period) ?? previousPeriod()
  try {
    const r = await sendReportEmail(createSupabaseServiceClient(), {
      clientId: params.clientId, period, recipients: body.recipients, userId: auth.user.id,
      origin: process.env.FISCHER_PUBLIC_URL || req.nextUrl.origin
    })
    await logActivity(auth.supabase, auth.user, 'report.email', { entityType: 'client', entityId: params.clientId, clientId: params.clientId, details: { period, to: r.sentTo.length } })
    return NextResponse.json(r)
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Sending failed.', 502)
  }
}
