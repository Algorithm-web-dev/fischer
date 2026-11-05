import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { requireUser, bad, parsePeriod } from '@/lib/api'
import { buildMonthlyReport } from '@/lib/report'
import { previousPeriod, periodToDate } from '@/lib/snapshots'
import { createSupabaseServiceClient } from '@/lib/supabase'

export const maxDuration = 120

/**
 * GET  ?period=YYYY-MM   → the report data (team preview / Lovable frontend)
 * POST { period, expiresInDays? } → creates a share link the client can open
 *      without an account: /report/<token>
 */
export async function GET(req: NextRequest, { params }: { params: { clientId: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const period = parsePeriod(req.nextUrl.searchParams.get('period')) ?? previousPeriod()
  try {
    // Service client: the builder caches before/after impact on change_log rows.
    const report = await buildMonthlyReport(createSupabaseServiceClient(), params.clientId, period)
    const { data: shares } = await auth.supabase.from('report_shares').select('token, period, created_at, revoked, expires_at')
      .eq('client_id', params.clientId).eq('period', periodToDate(period)).eq('revoked', false)
    return NextResponse.json({ report, shares: shares ?? [] })
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Report failed.', 500)
  }
}

export async function POST(req: NextRequest, { params }: { params: { clientId: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const body = await req.json().catch(() => ({}))
  const period = parsePeriod(body.period) ?? previousPeriod()
  const token = randomBytes(24).toString('base64url')
  const expiresAt = body.expiresInDays ? new Date(Date.now() + Number(body.expiresInDays) * 86400000).toISOString() : null

  const { data, error } = await auth.supabase.from('report_shares').insert({
    client_id: params.clientId, token, period: periodToDate(period), expires_at: expiresAt, created_by: auth.user.id
  }).select().single()
  if (error) return bad(error.message, 500)

  const origin = process.env.FISCHER_PUBLIC_URL || req.nextUrl.origin
  return NextResponse.json({ share: data, url: `${origin}/report/${token}`, pdfUrl: `${origin}/api/reports/${params.clientId}/pdf?period=${period}` })
}

/** DELETE ?token=… revokes a share link. */
export async function DELETE(req: NextRequest, { params }: { params: { clientId: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const token = req.nextUrl.searchParams.get('token')
  if (!token) return bad('token is required.')
  const { error } = await auth.supabase.from('report_shares').update({ revoked: true }).eq('client_id', params.clientId).eq('token', token)
  if (error) return bad(error.message, 500)
  return NextResponse.json({ ok: true })
}
