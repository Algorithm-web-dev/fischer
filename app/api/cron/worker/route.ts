import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { isCronAuthorized } from '@/lib/api'
import { processNextJob, MAX_ATTEMPTS } from '@/lib/queue'

export const maxDuration = 300

/**
 * Runs every minute. Each invocation keeps taking jobs while it has time for
 * another (an audit takes ~1–4 min). Overlapping invocations give natural
 * parallelism: a busy queue gets several workers at once.
 */
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  const started = Date.now()
  const supabase = createSupabaseServiceClient()
  await supabase.rpc('fail_stuck_audits', { max_attempts: MAX_ATTEMPTS })
  const done = []
  while (Date.now() - started < 45_000) {
    const r = await processNextJob(supabase)
    if (!r) break
    done.push(r)
  }
  return NextResponse.json({ ms: Date.now() - started, processed: done })
}
