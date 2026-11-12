import { NextRequest, NextResponse } from 'next/server'
import { isCronAuthorized } from '@/lib/api'

export const maxDuration = 300

/**
 * One daily cron that starts every scheduled job — for the Vercel Hobby plan,
 * which only allows once-a-day crons (and few of them). Each job is called as
 * its own request, so each gets its own time limit.
 *
 * Order: monthly (snapshots, leak maps, queues due re-audits) first, then the
 * worker so it can run queued audits; the rest in parallel.
 *
 * On Pro, add the per-minute worker cron and set FISCHER_BACKGROUND_WORKER=true
 * (see README → Hosting); this daily cron can stay.
 */
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  const origin = process.env.FISCHER_PUBLIC_URL || req.nextUrl.origin
  const call = async (path: string) => {
    const started = Date.now()
    try {
      const res = await fetch(`${origin}/api/cron/${path}`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } })
      return { job: path, status: res.status, seconds: Math.round((Date.now() - started) / 1000) }
    } catch (err) {
      return { job: path, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const parallel = Promise.all(['clarity-daily', 'guardrails', 'journeys', 'report-emails'].map(call))
  const monthly = await call('monthly')
  const worker = await call('worker')
  return NextResponse.json({ results: [monthly, worker, ...(await parallel)] })
}
