import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchLeakAnalysis, type LeakAnalysis } from './leaks'
import { lastNDays, type DateRange } from './ga4-audit'
import type { ClientRow } from './audit-pipeline'
import { benchmarkTargets } from './benchmarks'
import { fetchFunnel } from './funnels'
import { leadQualityReport } from './lead-quality'
import { registerGoogleAuth } from './google'
import { fetchAdsLandingPages } from './google-ads'

export interface StoredLeakAnalysis { id: string; created_at: string; data: LeakAnalysis }

function originOf(url?: string | null): string | null {
  if (!url) return null
  try { return new URL(url).origin } catch { return null }
}

/** Computes and stores a leak analysis for a client (GA4 required). */
export async function runLeakAnalysis(
  supabase: SupabaseClient,
  client: ClientRow & { primary_url?: string | null },
  range: DateRange = lastNDays(30),
  userId?: string | null
): Promise<StoredLeakAnalysis> {
  if (!client.ga4_property_id) throw new Error('Connect GA4 for this client to build a revenue leak map.')
  registerGoogleAuth(client)
  const targets = await benchmarkTargets(supabase, client).catch(() => undefined)
  // No value per conversion set? Use real revenue per lead from the CRM (90 days, ≥ 20 leads).
  const crm = client.avg_order_value ? null : await leadQualityReport(supabase, client.id, 90).catch(() => null)
  const data = await fetchLeakAnalysis({
    propertyId: client.ga4_property_id,
    range,
    conversionEvent: client.ga4_conversion_event,
    valuePerConversion: client.avg_order_value || crm?.valuePerLead || null,
    siteOrigin: originOf(client.primary_url),
    targetOverrides: targets?.overrides,
    targetFloors: targets?.floors
  })
  if (targets?.note) data.notes.push(targets.note)
  if (!client.avg_order_value && crm?.valuePerLead) data.notes.push(`Value per conversion taken from the CRM: ${crm.valuePerLead} revenue per lead over 90 days.`)
  // Google Ads spend per landing page (when an Ads account is connected)
  if (client.google_ads_customer_id && client.google_refresh_token) {
    try {
      const rows = await fetchAdsLandingPages(client, range)
      const pageByPath = new Map(data.pages.map(p => [p.page, p]))
      const siteRate = data.site.conversionRate
      const enriched = rows.slice(0, 30).map(r => {
        const leak = pageByPath.get(r.path)
        return { ...r, pageConversionRate: leak?.conversionRate ?? null, belowAverage: !!leak && leak.conversionRate < siteRate }
      })
      data.adSpend = {
        total: rows.reduce((s, r) => s + r.cost, 0),
        onBelowAveragePages: enriched.filter(r => r.belowAverage).reduce((s, r) => s + r.cost, 0),
        pages: enriched
      }
    } catch (err) { data.notes.push(`Google Ads spend not available: ${err instanceof Error ? err.message : String(err)}`) }
  }
  // E-commerce if GA4 records revenue; otherwise treat as lead generation.
  const kind = data.valueBasis === 'ga4_revenue' ? 'ecommerce' : 'lead'
  data.funnel = await fetchFunnel({
    propertyId: client.ga4_property_id, range, kind,
    valuePerConversion: data.valuePerConversion, conversionEvent: client.ga4_conversion_event
  }).catch(err => { data.notes.push(`Funnel not available: ${err instanceof Error ? err.message : String(err)}`); return null })
  const { data: row, error } = await supabase.from('leak_analyses').insert({
    client_id: client.id, start_date: range.startDate, end_date: range.endDate,
    data, recoverable_monthly: data.totals.recoverableMonthly, created_by: userId ?? null
  }).select('id, created_at, data').single()
  if (error) throw new Error(`Saving leak analysis failed: ${error.message}`)
  return row as StoredLeakAnalysis
}

export async function latestLeakAnalysis(supabase: SupabaseClient, clientId: string): Promise<StoredLeakAnalysis | null> {
  const { data } = await supabase.from('leak_analyses').select('id, created_at, data')
    .eq('client_id', clientId).order('created_at', { ascending: false }).limit(1)
  return (data?.[0] as StoredLeakAnalysis | undefined) ?? null
}

/** Adds the top N leaking pages (that have a full URL) to tracked pages. Returns the URLs added. */
export async function trackTopLeaks(supabase: SupabaseClient, clientId: string, analysis: LeakAnalysis, n = 3): Promise<string[]> {
  const candidates = analysis.pages.filter(p => p.url).slice(0, n)
  const added: string[] = []
  for (const p of candidates) {
    const { error } = await supabase.from('tracked_pages')
      .upsert({ client_id: clientId, page_url: p.url!, page_type: 'Landing Page' }, { onConflict: 'client_id,page_url', ignoreDuplicates: true })
    if (!error) added.push(p.url!)
  }
  return added
}
