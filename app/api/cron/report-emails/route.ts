import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { isCronAuthorized } from '@/lib/api'
import { sendReportEmail } from '@/lib/report-email'
import { previousPeriod, periodToDate } from '@/lib/snapshots'
import { logError } from '@/lib/errors'

export const maxDuration = 300

/** Daily: emails last month's report to clients whose send day is today (once per month per client). */
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  const origin = process.env.FISCHER_PUBLIC_URL
  if (!origin) return NextResponse.json({ error: 'FISCHER_PUBLIC_URL must be set for report links.' }, { status: 500 })
  const supabase = createSupabaseServiceClient()
  const today = new Date().getUTCDate()
  const period = previousPeriod()
  const { data: clients } = await supabase.from('clients').select('id, name, report_email_day')
    .eq('report_email_enabled', true).lte('report_email_day', today)
  const log = []
  for (const c of clients ?? []) {
    const { data: sent } = await supabase.from('report_emails').select('id').eq('client_id', c.id).eq('period', periodToDate(period)).eq('status', 'sent').limit(1)
    if (sent?.length) continue
    try {
      const r = await sendReportEmail(supabase, { clientId: c.id, period, origin })
      log.push({ client: c.name, sentTo: r.sentTo.length })
    } catch (err) {
      log.push({ client: c.name, error: err instanceof Error ? err.message : String(err) })
      await logError('cron:report-emails', err, { clientId: c.id, period })
    }
  }
  return NextResponse.json({ period, log })
}
