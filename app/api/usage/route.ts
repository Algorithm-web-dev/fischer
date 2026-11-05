import { NextRequest, NextResponse } from 'next/server'
import { requireUser, bad } from '@/lib/api'

/**
 * Claude usage and cost. GET ?clientId=…&months=6
 * → { byMonth, byFeature, byModel, byClient (when no clientId), avgAuditCostUsd }
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const clientId = req.nextUrl.searchParams.get('clientId')
  const months = Math.min(Number(req.nextUrl.searchParams.get('months') || 6), 24)
  const since = new Date(); since.setUTCDate(1); since.setUTCMonth(since.getUTCMonth() - (months - 1))
  let q = auth.supabase.from('llm_usage').select('feature, client_id, model, cost_usd, created_at, clients(name)')
    .gte('created_at', since.toISOString().slice(0, 10)).limit(50000)
  if (clientId) q = q.eq('client_id', clientId)
  const { data, error } = await q
  if (error) return bad(error.message, 500)

  type Bucket = { key: string; costUsd: number; calls: number; name?: string }
  const add = (m: Map<string, Bucket>, k: string, row: any, name?: string) => {
    const e = m.get(k) ?? { key: k, costUsd: 0, calls: 0, ...(name ? { name } : {}) }
    e.costUsd += Number(row.cost_usd) || 0; e.calls += 1; m.set(k, e)
  }
  const byMonth = new Map<string, Bucket>(), byFeature = new Map<string, Bucket>(), byClient = new Map<string, Bucket>(), byModel = new Map<string, Bucket>()
  for (const r of data ?? []) {
    add(byMonth, String(r.created_at).slice(0, 7), r)
    add(byFeature, r.feature, r)
    add(byModel, r.model, r)
    if (!clientId) add(byClient, r.client_id ?? '(none)', r, (r as any).clients?.name ?? 'No client')
  }
  const out = (m: Map<string, Bucket>) => Array.from(m.values()).map(v => ({ ...v, costUsd: Math.round(v.costUsd * 100) / 100 }))
  const audits = (data ?? []).filter(r => r.feature.startsWith('audit'))
  return NextResponse.json({
    byMonth: out(byMonth).sort((a, b) => a.key.localeCompare(b.key)),
    byFeature: out(byFeature).sort((a, b) => b.costUsd - a.costUsd),
    byModel: out(byModel).sort((a, b) => b.costUsd - a.costUsd),
    byClient: clientId ? undefined : out(byClient).sort((a, b) => b.costUsd - a.costUsd),
    avgAuditCostUsd: audits.length ? Math.round((audits.reduce((s, r) => s + Number(r.cost_usd), 0) / audits.length) * 1000) / 1000 : null
  })
}
