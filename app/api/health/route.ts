import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { envStatus } from '@/lib/env-check'

export const dynamic = 'force-dynamic'

/**
 * Public setup check: which settings are missing (names only, never values)
 * and whether Supabase answers. Open /api/health after deploying.
 */
export async function GET() {
  const env = envStatus()
  let supabase: string = 'not checked'
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    try {
      const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL.trim(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY.trim(), { auth: { persistSession: false } })
      const { error } = await sb.from('agency_settings').select('id', { head: true, count: 'exact' })
      supabase = error ? `error: ${error.message}` : 'ok'
    } catch (err) {
      supabase = `error: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const ok = env.missing.length === 0 && env.problems.length === 0 && supabase === 'ok'
  return NextResponse.json({ ok, ...env, supabase }, { headers: { 'Cache-Control': 'no-store' } })
}
