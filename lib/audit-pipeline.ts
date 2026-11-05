import type { SupabaseClient } from '@supabase/supabase-js'
import { capturePage, VIEWPORTS, type PageCapture, type ViewportName, type ViewportCapture } from './capture'
import { parseHtml } from './scraper'
import { assessConfidence, isFullyConfident, type ConfidenceCheck } from './confidence'
import { fetchPageSpeedBoth } from './pagespeed'
import { fetchGA4AuditData, lastNDays, type GA4AuditData } from './ga4-audit'
import { aggregateStoredDays, fetchClarityData, type ClarityDaily, type ClarityResult } from './clarity'
import { runFischerAudit, FISCHER_MODEL, type AuditInput, type AuditResult, type PreviousAuditContext, type ChangeLogEntry } from './claude'
import { fingerprintPage, diffFingerprints, type PageFingerprint, type PageDiff } from './page-diff'

export const SCREENSHOT_BUCKET = 'fischer-screenshots'

export interface ClientRow {
  id: string
  name: string
  industry?: string | null
  currency?: string | null
  avg_order_value?: number | null
  ga4_property_id?: string | null
  ga4_conversion_event?: string | null
  clarity_project_id?: string | null
  clarity_api_token?: string | null
}

export type PipelineOutcome =
  | { status: 'complete'; auditId: string; result: AuditResult; pageDiff: PageDiff; dataSources: Record<string, unknown>; screenshots: StoredScreenshots }
  | { status: 'needs_manual_input'; auditId: string; confidence: ConfidenceCheck }

export interface StoredScreenshots {
  desktop: { index: number; y: number; height: number; url: string }[]
  mobile: { index: number; y: number; height: number; url: string }[]
}

/**
 * Runs one audit end-to-end and persists it. The audit row must already exist.
 *
 * `interactive` (a person clicked "run"): if capture is incomplete, stop
 * BEFORE calling the model and ask for just the missing pieces.
 * `scheduled` (monthly cron): same gate, but there's nobody to ask — the row is
 * left in needs_manual_input for the team to pick up.
 */
export async function runAuditPipeline(params: {
  supabase: SupabaseClient
  auditId: string
  input: AuditInput
  client: ClientRow | null
  trackedPageId?: string | null
}): Promise<PipelineOutcome> {
  const { supabase, auditId, input, client } = params

  const autoViewports: ViewportName[] = []
  if (!input.manualScreenshotDesktop) autoViewports.push('desktop')
  if (!input.manualScreenshotMobile) autoViewports.push('mobile')

  // Everything that doesn't depend on the capture runs at the same time as it.
  const [capture, pagespeed, ga4, clarity] = await Promise.all([
    autoViewports.length > 0 || !input.manualHtml
      ? capturePage(input.pageUrl, autoViewports.length ? autoViewports : ['desktop'])
      : Promise.resolve(emptyCapture()),
    fetchPageSpeedBoth(input.pageUrl),
    client?.ga4_property_id
      ? fetchGA4AuditData(client.ga4_property_id, { pageUrl: input.pageUrl, range: lastNDays(30), conversionEvent: client.ga4_conversion_event })
      : Promise.resolve(null as GA4AuditData | null),
    loadClarity(supabase, client, input.pageUrl)
  ])

  applyManualOverrides(capture, input)

  const confidence = assessConfidence(capture)
  if (input.manualHtml) { confidence.htmlOk = true; delete confidence.reasons.html }
  if (input.manualScreenshotDesktop) { confidence.desktopOk = true; delete confidence.reasons.desktop }
  if (input.manualScreenshotMobile) { confidence.mobileOk = true; delete confidence.reasons.mobile }

  if (!isFullyConfident(confidence)) {
    await supabase.from('audits').update({
      status: 'needs_manual_input',
      scraped_content: capture.content ?? { error: capture.contentError },
      error_message: Object.values(confidence.reasons).filter(Boolean).join(' · '),
      input_data: stripManual(input)
    }).eq('id', auditId)
    return { status: 'needs_manual_input', auditId, confidence }
  }

  // Previous completed audit of the same page → follow-up + change detection
  const previous = await loadPreviousAudit(supabase, input, client?.id ?? null, auditId)
  const changesSincePrevious = previous && client
    ? await loadChangesSince(supabase, client.id, input.pageUrl, previous.completed_at)
    : []

  const result = await runFischerAudit({
    input,
    capture,
    pagespeed,
    ga4,
    clarity,
    industry: client?.industry,
    currency: client?.currency,
    valuePerConversion: client?.avg_order_value,
    previous: previous ? toPreviousContext(previous) : null,
    changesSincePrevious
  })

  const screenshots = await uploadScreenshots(supabase, auditId, capture)

  const fingerprint = fingerprintPage(capture.content, capture.desktop.layout, capture.mobile.layout)
  const pageDiff = diffFingerprints(previous?.page_fingerprint as PageFingerprint | undefined, fingerprint)

  const dataSources = {
    content: capture.contentSource,
    screenshots: { desktop: capture.desktop.segments.length, mobile: capture.mobile.segments.length },
    pagespeed: pagespeed.desktop.success || pagespeed.mobile.success ? 'success' : (pagespeed.mobile.error || 'failed'),
    ga4: ga4 ? (ga4.success ? 'live' : `failed: ${ga4.error}`) : 'not_configured',
    clarity: clarity ? (clarity.success ? `${clarity.source} (${clarity.days}d, ${clarity.isPageLevel ? 'page' : 'site-wide'})` : `failed: ${clarity.error}`) : 'not_configured',
    captureMode: input.manualHtml || input.manualScreenshotDesktop || input.manualScreenshotMobile ? 'mixed' : 'auto',
    unverifiedFindings: result.unverifiedFindings.length
  }

  const { error: updateError } = await supabase.from('audits').update({
    status: 'complete',
    completed_at: new Date().toISOString(),
    output: result,
    fischer_score: result.fischerScore,
    scraped_content: capture.content,
    screenshots,
    screenshot_desktop_url: screenshots.desktop[0]?.url ?? null,
    screenshot_mobile_url: screenshots.mobile[0]?.url ?? null,
    layout: { desktop: capture.desktop.layout ?? null, mobile: capture.mobile.layout ?? null },
    pagespeed_desktop: pagespeed.desktop,
    pagespeed_mobile: pagespeed.mobile,
    ga4_data: ga4,
    clarity_data: clarity,
    capture_metadata: dataSources,
    page_fingerprint: fingerprint,
    page_diff: pageDiff,
    previous_audit_id: previous?.id ?? null,
    model: FISCHER_MODEL,
    error_message: null,
    input_data: stripManual(input)
  }).eq('id', auditId)
  if (updateError) throw new Error(`Saving audit failed: ${updateError.message}`)

  if (client && previous && pageDiff.changed) {
    await supabase.from('change_log').insert({
      client_id: client.id,
      page_url: input.pageUrl,
      change_date: new Date().toISOString().slice(0, 10),
      title: `Page changes detected: ${pageDiff.changes.slice(0, 2).map(c => c.label).join(', ')}${pageDiff.changes.length > 2 ? '…' : ''}`,
      description: pageDiff.summary,
      source: 'detected',
      audit_id: auditId,
      details: pageDiff
    })
  }

  if (params.trackedPageId) {
    await supabase.from('tracked_pages')
      .update({ last_audit_id: auditId, last_audit_at: new Date().toISOString() })
      .eq('id', params.trackedPageId)
  }

  return { status: 'complete', auditId, result, pageDiff, dataSources, screenshots }
}

function emptyCapture(): PageCapture {
  const v = (name: ViewportName): ViewportCapture => ({
    viewport: name, ok: false, error: 'Not captured', width: VIEWPORTS[name].width, segments: [], truncated: false, consoleErrors: [], failedRequests: 0
  })
  return { desktop: v('desktop'), mobile: v('mobile'), content: null, contentSource: 'none' }
}

function applyManualOverrides(capture: PageCapture, input: AuditInput) {
  if (input.manualHtml) {
    capture.content = parseHtml(input.manualHtml, input.pageUrl)
    capture.content.fetchedWithJs = false
    capture.contentSource = 'rendered'
  }
  for (const [name, b64] of [['desktop', input.manualScreenshotDesktop], ['mobile', input.manualScreenshotMobile]] as const) {
    if (!b64) continue
    const v = capture[name]
    v.ok = true
    v.error = undefined
    v.segments = [{ index: 0, y: 0, height: VIEWPORTS[name].height, base64: stripDataPrefix(b64) }]
  }
}

function stripManual(input: AuditInput): AuditInput {
  // Don't store multi-MB base64 blobs in input_data.
  const { manualHtml, manualScreenshotDesktop, manualScreenshotMobile, ...rest } = input
  return { ...rest, ...(manualHtml ? { manualHtml: '(supplied)' } : {}) }
}

export function stripDataPrefix(base64: string): string {
  const i = base64.indexOf(',')
  return base64.startsWith('data:') && i !== -1 ? base64.slice(i + 1) : base64
}

async function loadClarity(supabase: SupabaseClient, client: ClientRow | null, pageUrl: string): Promise<ClarityResult | null> {
  if (!client?.clarity_api_token) return null
  // Prefer the stored daily history (30 days, no API quota used).
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
  const { data } = await supabase.from('clarity_daily')
    .select('data').eq('client_id', client.id).gte('day', since)
  const days = (data ?? []).map(r => r.data as ClarityDaily)
  if (days.length > 0) return aggregateStoredDays(days, pageUrl)
  return fetchClarityData(client.clarity_api_token, pageUrl)
}

interface PreviousRow {
  id: string
  completed_at: string
  fischer_score: number
  output: AuditResult
  page_fingerprint: unknown
}

async function loadPreviousAudit(supabase: SupabaseClient, input: AuditInput, clientId: string | null, excludeId: string) {
  let q = supabase.from('audits')
    .select('id, completed_at, fischer_score, output, page_fingerprint')
    .eq('page_url', input.pageUrl)
    .eq('status', 'complete')
    .neq('id', excludeId)
    .order('completed_at', { ascending: false })
    .limit(1)
  q = clientId ? q.eq('client_id', clientId) : q.eq('client_name', input.clientName)
  const { data } = await q
  return (data?.[0] as PreviousRow | undefined) ?? null
}

function toPreviousContext(p: PreviousRow): PreviousAuditContext {
  return {
    auditId: p.id,
    completedAt: p.completed_at,
    fischerScore: p.fischer_score,
    frictionPoints: (p.output?.frictionPoints ?? []).map(f => ({ title: f.title, severity: f.severity, location: f.location, fix: f.fix }))
  }
}

async function loadChangesSince(supabase: SupabaseClient, clientId: string, pageUrl: string, since: string): Promise<ChangeLogEntry[]> {
  const { data } = await supabase.from('change_log')
    .select('change_date, title, description, source, page_url')
    .eq('client_id', clientId)
    .gte('change_date', since.slice(0, 10))
    .neq('source', 'detected')
    .order('change_date')
  return (data ?? []).filter(c => !c.page_url || c.page_url === pageUrl)
}

async function uploadScreenshots(supabase: SupabaseClient, auditId: string, capture: PageCapture): Promise<StoredScreenshots> {
  const out: StoredScreenshots = { desktop: [], mobile: [] }
  for (const v of [capture.desktop, capture.mobile]) {
    for (const s of v.segments) {
      const path = `${auditId}/${v.viewport}-${s.index}.jpg`
      const { error } = await supabase.storage.from(SCREENSHOT_BUCKET)
        .upload(path, Buffer.from(s.base64, 'base64'), { contentType: 'image/jpeg', upsert: true })
      if (error) { console.error(`Screenshot upload failed (${path}):`, error.message); continue }
      const { data } = supabase.storage.from(SCREENSHOT_BUCKET).getPublicUrl(path)
      out[v.viewport].push({ index: s.index, y: s.y, height: s.height, url: data.publicUrl })
    }
  }
  return out
}
