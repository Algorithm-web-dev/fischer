import type { SupabaseClient } from '@supabase/supabase-js'
import type { ClientRow } from './audit-pipeline'
import { periodToDate, shiftPeriod, previousPeriod } from './snapshots'

/**
 * Cross-client benchmarks (anonymised).
 *
 * Built from every client's stored monthly GA4 snapshots (last 3 complete
 * months). An industry benchmark is only shown when at least MIN_CLIENTS
 * clients share that industry, so no single client's numbers can be read
 * off it. Client names never leave this module.
 */
export const MIN_CLIENTS = 3
export const TARGET_FLOOR = 0.8   // leak-map target floor = 80% of the industry median

export interface BenchmarkInput {
  clientId: string
  industry: string | null
  sessions: number
  conversions: number
  devices: Record<string, { sessions: number; conversions: number }>
}

export interface Distribution { clients: number; median: number; p25: number; p75: number }

export interface IndustryBenchmark {
  industry: string
  overall: Distribution
  devices: Record<string, Distribution>
}

export interface Benchmarks {
  months: string[]
  industries: IndustryBenchmark[]
  allClients: Distribution | null
}

const MIN_SESSIONS = 1000   // per client over the window, so tiny sites don't skew medians

export function normaliseIndustry(s: string | null | undefined): string | null {
  const t = (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return t || null
}

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}
function dist(rates: number[]): Distribution {
  const s = rates.slice().sort((a, b) => a - b)
  const r = (n: number) => Math.round(n * 100) / 100
  return { clients: s.length, median: r(quantile(s, 0.5)), p25: r(quantile(s, 0.25)), p75: r(quantile(s, 0.75)) }
}

/** Pure — unit tested. */
export function computeBenchmarks(inputs: BenchmarkInput[], months: string[]): Benchmarks {
  const eligible = inputs.filter(i => i.sessions >= MIN_SESSIONS && i.conversions > 0)
  const byIndustry = new Map<string, BenchmarkInput[]>()
  for (const i of eligible) {
    const k = normaliseIndustry(i.industry)
    if (k) (byIndustry.get(k) ?? byIndustry.set(k, []).get(k)!).push(i)
  }
  const industries: IndustryBenchmark[] = []
  for (const [industry, list] of Array.from(byIndustry.entries())) {
    if (list.length < MIN_CLIENTS) continue
    const devices: Record<string, Distribution> = {}
    for (const d of ['desktop', 'mobile', 'tablet']) {
      const rates = list.filter(c => (c.devices[d]?.sessions ?? 0) >= 200).map(c => (c.devices[d].conversions / c.devices[d].sessions) * 100)
      if (rates.length >= MIN_CLIENTS) devices[d] = dist(rates)
    }
    industries.push({ industry, overall: dist(list.map(c => (c.conversions / c.sessions) * 100)), devices })
  }
  industries.sort((a, b) => b.overall.clients - a.overall.clients)
  return { months, industries, allClients: eligible.length >= MIN_CLIENTS ? dist(eligible.map(c => (c.conversions / c.sessions) * 100)) : null }
}

/** Where a rate sits within a distribution, as a rough percentile band. */
export function band(rate: number, d: Distribution): 'bottom quarter' | 'below median' | 'above median' | 'top quarter' {
  if (rate < d.p25) return 'bottom quarter'
  if (rate < d.median) return 'below median'
  if (rate < d.p75) return 'above median'
  return 'top quarter'
}

export async function loadBenchmarks(supabase: SupabaseClient): Promise<{ benchmarks: Benchmarks; inputs: BenchmarkInput[] }> {
  const last = previousPeriod()
  const months = [shiftPeriod(last, -2), shiftPeriod(last, -1), last]
  const [{ data: snaps }, { data: clients }] = await Promise.all([
    supabase.from('monthly_snapshots').select('client_id, period, ga4').in('period', months.map(periodToDate)),
    supabase.from('clients').select('id, industry')
  ])
  const industryOf = new Map((clients ?? []).map(c => [c.id, c.industry as string | null]))
  const per = new Map<string, BenchmarkInput>()
  for (const s of snaps ?? []) {
    const t = s.ga4?.success ? s.ga4.totals : null
    if (!t) continue
    const row: BenchmarkInput = per.get(s.client_id) ?? { clientId: s.client_id, industry: industryOf.get(s.client_id) ?? null, sessions: 0, conversions: 0, devices: {} }
    row.sessions += t.sessions || 0
    row.conversions += t.conversions || 0
    for (const d of s.ga4.deviceConversion ?? []) {
      const dev = (row.devices[d.device] ??= { sessions: 0, conversions: 0 })
      dev.sessions += d.sessions || 0
      dev.conversions += ((d.sessions || 0) * (d.conversionRate || 0)) / 100
    }
    per.set(s.client_id, row)
  }
  const inputs = Array.from(per.values())
  return { benchmarks: computeBenchmarks(inputs, months), inputs }
}

export interface ClientBenchmark {
  industry: string
  clients: number
  clientRate: number | null
  median: number
  p25: number
  p75: number
  position: ReturnType<typeof band> | null
  devices: { device: string; clientRate: number | null; median: number }[]
  months: string[]
}

export async function clientBenchmark(supabase: SupabaseClient, client: { id: string; industry?: string | null }): Promise<ClientBenchmark | null> {
  const industry = normaliseIndustry(client.industry)
  if (!industry) return null
  const { benchmarks, inputs } = await loadBenchmarks(supabase)
  const ind = benchmarks.industries.find(i => i.industry === industry)
  if (!ind) return null
  const me = inputs.find(i => i.clientId === client.id)
  const rate = me && me.sessions ? Math.round((me.conversions / me.sessions) * 10000) / 100 : null
  return {
    industry, clients: ind.overall.clients, clientRate: rate,
    median: ind.overall.median, p25: ind.overall.p25, p75: ind.overall.p75,
    position: rate != null ? band(rate, ind.overall) : null,
    devices: Object.entries(ind.devices).map(([device, d]) => ({
      device, median: d.median,
      clientRate: me?.devices[device]?.sessions ? Math.round((me.devices[device].conversions / me.devices[device].sessions) * 10000) / 100 : null
    })),
    months: benchmarks.months
  }
}

/**
 * Leak-map target floors from the industry benchmark: a page is compared
 * with max(site's own device rate, 80% of the industry device median). This
 * reveals leaks on sites that are uniformly weak, where comparing pages
 * only with each other would show nothing.
 */
export async function benchmarkTargets(
  supabase: SupabaseClient,
  client: ClientRow
): Promise<{ overrides?: Partial<Record<string, number>>; floors?: Partial<Record<string, number>>; note?: string } | undefined> {
  const b = await clientBenchmark(supabase, client)
  if (!b || b.devices.length === 0) return undefined
  const floors: Partial<Record<string, number>> = {}
  for (const d of b.devices) floors[d.device] = Math.round(d.median * TARGET_FLOOR * 100) / 100
  return { floors, note: `Targets use a floor of ${Math.round(TARGET_FLOOR * 100)}% of the ${b.industry} industry median (${b.clients} clients, anonymised).` }
}
