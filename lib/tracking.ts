import type { PageCapture } from './capture'
import { getGA4Client, lastNDays } from './ga4-audit'

/**
 * Tracking health check.
 *
 * Before trusting any number, check the measurement itself. Fischer already
 * loads every page in a real browser, so it records which analytics/ad tags
 * actually fire (network requests, after the cookie banner is accepted), the
 * consent signals they carry, and — from the GA4 API — which events the
 * property actually receives. Broken or missing tracking becomes a finding
 * instead of a silently empty report.
 */

export interface TrackingDetected {
  ga4MeasurementIds: string[]
  ga4Hits: number                     // /g/collect requests sent during load
  ga4ServerSide: boolean              // collect requests to a non-Google host (server-side GTM)
  gtmContainers: string[]
  googleAdsIds: string[]
  clarityProjectIds: string[]
  clarityHits: number
  metaPixel: boolean
  linkedIn: boolean
  tiktok: boolean
  hotjar: boolean
  consentDefault: Record<string, unknown> | null    // from dataLayer ['consent','default',{…}]
  analyticsConsent: 'granted' | 'denied' | 'unknown' // from GA4 gcs parameter
  dataLayerEvents: string[]
}

export interface GA4EventRow { name: string; count: number; isKeyEvent: boolean }

export interface TrackingIssue {
  severity: 'high' | 'medium' | 'low'
  code: string
  message: string
  fix: string
}

export interface TrackingReport {
  checkedAt: string
  pageUrl: string
  detected: TrackingDetected
  events: GA4EventRow[] | null
  eventsError?: string
  issues: TrackingIssue[]
  healthy: boolean
}

const GOOGLE_HOSTS = /(google-analytics\.com|googletagmanager\.com|doubleclick\.net|google\.com)/i

/** Pure: reads the captured requests/dataLayer. Unit tested. */
export function analyseTrackingRequests(requests: string[], dataLayer: unknown[]): TrackingDetected {
  const ids = (re: RegExp) => Array.from(new Set(requests.flatMap(u => Array.from(u.matchAll(re)).map(m => m[1]))))
  const collect = requests.filter(u => /\/g\/collect\?/.test(u))
  const gcs = collect.map(u => /[?&]gcs=G1(\d)(\d)/.exec(u)).filter(Boolean) as RegExpExecArray[]
  let analyticsConsent: TrackingDetected['analyticsConsent'] = 'unknown'
  if (gcs.length) analyticsConsent = gcs.some(m => m[2] === '1') ? 'granted' : 'denied'

  let consentDefault: Record<string, unknown> | null = null
  const dataLayerEvents: string[] = []
  for (const e of dataLayer as any[]) {
    if (Array.isArray(e) && e[0] === 'consent' && e[1] === 'default' && e[2] && typeof e[2] === 'object') consentDefault = e[2]
    else if (e && typeof e === 'object' && !Array.isArray(e) && typeof e.event === 'string' && !e.event.startsWith('gtm.')) dataLayerEvents.push(e.event)
  }

  return {
    ga4MeasurementIds: ids(/[?&](?:tid|id)=(G-[A-Z0-9]+)/gi),
    ga4Hits: collect.length,
    ga4ServerSide: collect.some(u => { try { return !GOOGLE_HOSTS.test(new URL(u).hostname) } catch { return false } }),
    gtmContainers: ids(/gtm\.js\?id=(GTM-[A-Z0-9]+)/gi),
    googleAdsIds: ids(/\b(AW-\d{6,})/gi),
    clarityProjectIds: ids(/clarity\.ms\/tag\/([a-z0-9]+)/gi),
    clarityHits: requests.filter(u => /clarity\.ms\/collect/i.test(u)).length,
    metaPixel: requests.some(u => /connect\.facebook\.net\/.*fbevents|facebook\.com\/tr/i.test(u)),
    linkedIn: requests.some(u => /snap\.licdn\.com|px\.ads\.linkedin\.com/i.test(u)),
    tiktok: requests.some(u => /analytics\.tiktok\.com/i.test(u)),
    hotjar: requests.some(u => /hotjar\.com/i.test(u)),
    consentDefault,
    analyticsConsent,
    dataLayerEvents: Array.from(new Set(dataLayerEvents)).slice(0, 30)
  }
}

/** Every event GA4 received in the last N days, with key-event flag. */
export async function fetchGA4EventInventory(propertyId: string, days = 30): Promise<GA4EventRow[]> {
  const [res] = await getGA4Client().runReport({
    property: `properties/${propertyId}`,
    dateRanges: [lastNDays(days)],
    dimensions: [{ name: 'eventName' }, { name: 'isKeyEvent' }],
    metrics: [{ name: 'eventCount' }],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 200
  })
  return (res.rows ?? []).map(r => ({
    name: r.dimensionValues?.[0]?.value ?? '',
    isKeyEvent: r.dimensionValues?.[1]?.value === 'true',
    count: Number(r.metricValues?.[0]?.value ?? 0)
  }))
}

const LEAD_EVENTS = ['generate_lead', 'form_submit', 'form_start', 'click_to_call', 'whatsapp_click', 'email_click', 'sign_up']
const ECOM_EVENTS = ['view_item', 'add_to_cart', 'begin_checkout', 'add_payment_info', 'purchase']

/** Pure: turns detection + inventory into prioritised issues. Unit tested. */
export function buildTrackingIssues(params: {
  detected: TrackingDetected
  events: GA4EventRow[] | null
  businessGoal?: string
  client?: { ga4_property_id?: string | null; ga4_conversion_event?: string | null; clarity_project_id?: string | null } | null
}): TrackingIssue[] {
  const { detected: d, events, client } = params
  const issues: TrackingIssue[] = []
  const add = (severity: TrackingIssue['severity'], code: string, message: string, fix: string) => issues.push({ severity, code, message, fix })
  const isEcom = /e-?commerce|sales|shop/i.test(params.businessGoal ?? '')

  // --- GA4 on the page
  if (d.ga4MeasurementIds.length === 0 && d.ga4Hits === 0) {
    add('high', 'ga4_missing', 'No GA4 tag fired on this page.', 'Install GA4 (directly or through Google Tag Manager) on every page, including this one.')
  } else if (d.ga4Hits === 0) {
    add('high', 'ga4_not_sending', `GA4 (${d.ga4MeasurementIds.join(', ')}) loads but sent no data, even after the cookie banner was accepted.`, 'Check the consent setup and GTM triggers — the tag is present but blocked or misfiring.')
  }
  if (d.ga4MeasurementIds.length > 1) {
    add('medium', 'ga4_duplicate', `${d.ga4MeasurementIds.length} GA4 measurement IDs fire on this page (${d.ga4MeasurementIds.join(', ')}).`, 'Confirm each ID is intentional; two tags sending to the same property double-count sessions and conversions.')
  }
  if (d.analyticsConsent === 'denied') {
    add('high', 'consent_denied', 'GA4 hits carry "analytics denied" consent even after accepting cookies, so GA4 only receives modelled/cookieless data.', 'Make the consent banner update Google Consent Mode (analytics_storage: granted) when a visitor accepts.')
  }
  if (!d.consentDefault && (d.ga4Hits > 0 || d.metaPixel)) {
    add('low', 'no_consent_mode', 'No Google Consent Mode default was found in the dataLayer.', 'Set a consent default before tags load (required for EU visitors and best practice under POPIA).')
  }

  // --- Clarity
  if (client?.clarity_project_id && !d.clarityProjectIds.includes(client.clarity_project_id)) {
    add('high', 'clarity_missing', d.clarityProjectIds.length
      ? `Clarity project ${d.clarityProjectIds.join(', ')} is installed, but this client is configured as ${client.clarity_project_id}.`
      : `Clarity (project ${client.clarity_project_id}) is not installed on this page.`, 'Install the configured Clarity project on every page so behaviour data covers it.')
  } else if (!client?.clarity_project_id && d.clarityProjectIds.length === 0) {
    add('medium', 'clarity_not_installed', 'Microsoft Clarity is not installed.', 'Install Clarity (free) to get rage-click, dead-click and scroll data for audits.')
  }

  // --- GA4 events (server side)
  if (events) {
    const names = new Set(events.map(e => e.name))
    const keyEvents = events.filter(e => e.isKeyEvent)
    if (keyEvents.length === 0) {
      add('high', 'no_key_events', 'GA4 has no key events (conversions) in the last 30 days.', 'Mark the lead/purchase event as a key event in GA4 Admin → Events, or set up the standard events (Fischer tracking kit).')
    }
    if (client?.ga4_conversion_event) {
      const ev = events.find(e => e.name === client.ga4_conversion_event)
      if (!ev) add('high', 'conversion_event_missing', `The configured conversion event "${client.ga4_conversion_event}" was not received in the last 30 days.`, 'Check the event name matches exactly and that the tag fires on form submission/purchase.')
      else if (!ev.isKeyEvent) add('medium', 'conversion_event_not_key', `"${client.ga4_conversion_event}" is received but not marked as a key event.`, 'Mark it as a key event in GA4 Admin → Events so conversion rates are calculated.')
    }
    const wanted = isEcom ? ECOM_EVENTS : LEAD_EVENTS
    const missing = wanted.filter(w => !names.has(w))
    if (missing.length && missing.length >= wanted.length - 1) {
      add(isEcom ? 'high' : 'medium', 'standard_events_missing',
        `Funnel events are missing in GA4: ${missing.join(', ')}.`,
        isEcom ? 'Implement GA4 e-commerce events (view_item → purchase) so checkout drop-off can be measured.' : 'Install the Fischer tracking kit (form_start, form_submit, click_to_call, whatsapp_click, email_click) so lead drop-off can be measured.')
    }
  }
  return issues.sort((a, b) => ['high', 'medium', 'low'].indexOf(a.severity) - ['high', 'medium', 'low'].indexOf(b.severity))
}

export async function buildTrackingReport(params: {
  capture: PageCapture
  pageUrl: string
  businessGoal?: string
  client?: { ga4_property_id?: string | null; ga4_conversion_event?: string | null; clarity_project_id?: string | null } | null
  events?: GA4EventRow[] | null
}): Promise<TrackingReport | null> {
  const net = params.capture.desktop.network ?? params.capture.mobile.network
  if (!net) return null // no browser capture (fully manual audit)
  const detected = analyseTrackingRequests(
    [...(params.capture.desktop.network?.trackingRequests ?? []), ...(params.capture.mobile.network?.trackingRequests ?? [])],
    net.dataLayer
  )
  let events = params.events ?? null
  let eventsError: string | undefined
  if (events === null && params.client?.ga4_property_id) {
    try { events = await fetchGA4EventInventory(params.client.ga4_property_id) } catch (err) { eventsError = err instanceof Error ? err.message : String(err) }
  }
  const issues = buildTrackingIssues({ detected, events, businessGoal: params.businessGoal, client: params.client })
  return { checkedAt: new Date().toISOString(), pageUrl: params.pageUrl, detected, events, eventsError, issues, healthy: !issues.some(i => i.severity === 'high') }
}

export function formatTrackingForPrompt(t: TrackingReport): string {
  const d = t.detected
  const lines = [
    `**TRACKING CHECK (tags observed firing in our browser after accepting cookies${t.events ? ', plus GA4 event list for 30 days' : ''}):**`,
    `- GA4: ${d.ga4MeasurementIds.join(', ') || 'none'} · ${d.ga4Hits} hit(s)${d.ga4ServerSide ? ' (server-side)' : ''} · analytics consent: ${d.analyticsConsent}`,
    `- GTM: ${d.gtmContainers.join(', ') || 'none'} · Clarity: ${d.clarityProjectIds.join(', ') || 'none'} · Google Ads: ${d.googleAdsIds.join(', ') || 'none'} · Meta pixel: ${d.metaPixel ? 'yes' : 'no'}`
  ]
  if (t.events) {
    const keys = t.events.filter(e => e.isKeyEvent)
    lines.push(`- GA4 key events: ${keys.map(e => `${e.name} (${e.count})`).join(', ') || 'NONE'}`)
    lines.push(`- Other GA4 events: ${t.events.filter(e => !e.isKeyEvent).slice(0, 15).map(e => e.name).join(', ')}`)
  }
  if (t.issues.length) {
    lines.push(`Measurement problems found (cite as category "measurement", evidence source "tracking"):`)
    for (const i of t.issues) lines.push(`- [${i.severity}] ${i.message}`)
  } else lines.push('No measurement problems found.')
  return lines.join('\n')
}
