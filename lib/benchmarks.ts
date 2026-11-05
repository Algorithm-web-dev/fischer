import type { SupabaseClient } from '@supabase/supabase-js'
import type { ClientRow } from './audit-pipeline'

/**
 * Cross-client benchmarks. Placeholder until item 7 is built: returns no
 * overrides, so the leak map uses the site's own averages as targets.
 */
export async function benchmarkTargets(
  _supabase: SupabaseClient,
  _client: ClientRow
): Promise<{ overrides?: Partial<Record<string, number>>; note?: string } | undefined> {
  return undefined
}
