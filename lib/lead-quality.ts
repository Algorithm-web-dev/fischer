import { createHash, randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Lead quality — connects CRM outcomes to pages and traffic sources, so
 * Fischer optimises for qualified leads and revenue, not raw form fills.
 *
 * Leads arrive via POST /api/leads/ingest (client CRM, Zapier/Make, or the
 * algorithm-crm app), keyed by the CRM's own lead id so later status updates
 * (qualified → won with a value) update the same row. The Fischer tracking
 * kit's hidden fields (fischer_landing_page, fischer_utm_*) give the CRM the
 * source data to send back.
 */

export const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'won', 'lost'] as const
export type LeadStatus = typeof LEAD_STATUSES[number]

export function newIngestKey(): { key: string; hash: string } {
  const key = `fsk_${randomBytes(24).toString('base64url')}`
  return { key, hash: hashKey(key) }
}
export function hashKey(key: string) {
  return createHash('sha256').update(key).digest('hex')
}

export interface LeadInput {
  externalId: string
  createdAt?: string
  status?: string
  value?: number | string | null
  closedAt?: string | null
  landingPage?: string | null
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  gclid?: string | null
  channel?: string | null
  formName?: string | null
}

const STATUS_ALIASES: Record<string, LeadStatus> = {
  open: 'new', new: 'new', contacted: 'contacted', working: 'contacted', 'in progress': 'contacted',
  qualified: 'qualified', sql: 'qualified', mql: 'qualified', opportunity: 'qualified',
  unqualified: 'unqualified', disqualified: 'unqualified', junk: 'unqualified', spam: 'unqualified',
  won: 'won', 'closed won': 'won', closedwon: 'won', sold: 'won', customer: 'won',
  lost: 'lost', 'closed lost': 'lost', closedlost: 'lost'
}

/** Validates/normalises one incoming lead. Pure — unit tested. Returns an error string if invalid. */
export function normaliseLead(clientId: string, l: LeadInput): Record<string, unknown> | string {
  if (!l || typeof l !== 'object') return 'Lead must be an object.'
  const externalId = String(l.externalId ?? '').trim()
  if (!externalId || externalId.length > 200) return 'externalId is required (max 200 chars).'
  const status = STATUS_ALIASES[String(l.status ?? 'new').toLowerCase().trim()]
  if (!status) return `Unknown status "${l.status}". Use one of: ${LEAD_STATUSES.join(', ')}.`
  const date = (v: unknown) => { if (!v) return null; const d = new Date(String(v)); return isNaN(d.getTime()) ? undefined : d.toISOString() }
  const parsedCreated = date(l.createdAt)
  if (parsedCreated === undefined) return 'createdAt is not a valid date.'
  const createdAt = parsedCreated ?? new Date().toISOString()
  const closedAt = date(l.closedAt)
  if (closedAt === undefined) return 'closedAt is not a valid date.'
  const cleanedValue = l.value == null || l.value === '' ? null : String(l.value).replace(/[^0-9.-]/g, '')
  const value = cleanedValue == null ? null : cleanedValue === '' ? NaN : Number(cleanedValue)
  if (value != null && !Number.isFinite(value)) return 'value must be a number.'
  const s = (v: unknown, max = 200) => v == null || v === '' ? null : String(v).slice(0, max)
  return {
    client_id: clientId,
    external_id: externalId,
    created_at: createdAt,
    status,
    value,
    closed_at: closedAt ?? (status === 'won' || status === 'lost' ? new Date().toISOString() : null),
    landing_page: l.landingPage ? normalisePath(String(l.landingPage)) : null,
    utm_source: s(l.utmSource, 100), utm_medium: s(l.utmMedium, 100), utm_campaign: s(l.utmCampaign, 150),
    gclid: s(l.gclid, 200), channel: s(l.channel, 100), form_name: s(l.formName, 100)
  }
}

export function normalisePath(p: string): string {
  let path = p
  try { path = new URL(p).pathname } catch { path = p.split(/[?#]/)[0] }
  if (!path.startsWith('/')) path = '/' + path
  return path.length > 1 ? path.replace(/\/+$/, '').toLowerCase() : '/'
}

export interface QualityRow {
  key: string
  leads: number
  qualified: number          // qualified + won (+ lost, which was qualified enough to be worked as a deal)
  won: number
  unqualified: number
  revenue: number
  qualifiedRate: number      // %
  winRate: number            // % of all leads
  revenuePerLead: number
}

export interface LeadQualityReport {
  range: { from: string; to: string }
  totals: QualityRow
  byPage: QualityRow[]
  bySource: QualityRow[]
  valuePerLead: number | null        // revenue / leads — usable as "value per conversion" when ≥ 20 leads
  insights: string[]
}

const isQualified = (s: string) => s === 'qualified' || s === 'won' || s === 'lost'

function aggregate(key: string, rows: { status: string; value: number | null }[]): QualityRow {
  const leads = rows.length
  const qualified = rows.filter(r => isQualified(r.status)).length
  const won = rows.filter(r => r.status === 'won').length
  const revenue = rows.filter(r => r.status === 'won').reduce((s, r) => s + (Number(r.value) || 0), 0)
  return {
    key, leads, qualified, won, unqualified: rows.filter(r => r.status === 'unqualified').length, revenue: Math.round(revenue),
    qualifiedRate: leads ? Math.round((qualified / leads) * 1000) / 10 : 0,
    winRate: leads ? Math.round((won / leads) * 1000) / 10 : 0,
    revenuePerLead: leads ? Math.round(revenue / leads) : 0
  }
}

/** Pure — unit tested. */
export function computeLeadQuality(rows: { status: string; value: number | null; landing_page: string | null; utm_source: string | null; utm_medium: string | null; channel: string | null; created_at: string }[], range: { from: string; to: string }): LeadQualityReport {
  const group = (fn: (r: typeof rows[number]) => string) => {
    const m = new Map<string, typeof rows>()
    for (const r of rows) { const k = fn(r); (m.get(k) ?? m.set(k, []).get(k)!).push(r) }
    return Array.from(m.entries()).map(([k, v]) => aggregate(k, v)).sort((a, b) => b.leads - a.leads)
  }
  const totals = aggregate('all', rows)
  const byPage = group(r => r.landing_page || '(unknown)')
  const bySource = group(r => r.utm_source ? `${r.utm_source} / ${r.utm_medium || '(none)'}` : (r.channel || '(direct / unknown)'))

  const insights: string[] = []
  const unknownShare = totals.leads ? (byPage.find(p => p.key === '(unknown)')?.leads ?? 0) / totals.leads : 0
  if (unknownShare > 0.3) insights.push(`${Math.round(unknownShare * 100)}% of leads have no landing page — add the tracking kit's hidden fields so the CRM records where leads came from.`)
  for (const list of [byPage, bySource]) {
    for (const r of list) {
      if (r.key.startsWith('(') || r.leads < 10 || totals.qualifiedRate === 0) continue
      if (r.qualifiedRate < totals.qualifiedRate * 0.5) insights.push(`${r.key}: ${r.leads} leads but only ${r.qualifiedRate}% qualify (site average ${totals.qualifiedRate}%) — volume here is not turning into business.`)
      else if (r.qualifiedRate > totals.qualifiedRate * 1.5 && r.leads >= 10) insights.push(`${r.key}: ${r.qualifiedRate}% of leads qualify (site average ${totals.qualifiedRate}%) — worth more traffic.`)
    }
  }
  return { range, totals, byPage: byPage.slice(0, 25), bySource: bySource.slice(0, 25), valuePerLead: totals.leads >= 20 && totals.revenue > 0 ? Math.round(totals.revenue / totals.leads) : null, insights: insights.slice(0, 8) }
}

export async function leadQualityReport(supabase: SupabaseClient, clientId: string, days = 90): Promise<LeadQualityReport | null> {
  const from = new Date(Date.now() - days * 86400000).toISOString()
  const { data } = await supabase.from('leads').select('status, value, landing_page, utm_source, utm_medium, channel, created_at')
    .eq('client_id', clientId).gte('created_at', from).limit(20000)
  if (!data?.length) return null
  return computeLeadQuality(data as any, { from: from.slice(0, 10), to: new Date().toISOString().slice(0, 10) })
}
