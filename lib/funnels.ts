import { getGA4Client, type DateRange } from './ga4-audit'

/**
 * Conversion funnels from GA4 events.
 *
 * This is an OPEN funnel: users who triggered each step's event in the period,
 * per device. It is not strictly sequential (GA4's sequential funnel API is
 * still alpha), but for standard step events (form_start → form_submit,
 * view_item → … → purchase) it shows clearly where people drop out.
 *
 * Lead-gen sites need the Fischer tracking kit (public/fischer-tracking.js) or
 * equivalent events; e-commerce sites need standard GA4 e-commerce events.
 */

export type FunnelKind = 'lead' | 'ecommerce'

export interface FunnelStepDef { event: string; label: string }

export const LEAD_FUNNEL: FunnelStepDef[] = [
  { event: '__users__', label: 'Visitors' },
  { event: 'form_start', label: 'Started a form' },
  { event: 'form_submit', label: 'Submitted a form' }
]
export const ECOM_FUNNEL: FunnelStepDef[] = [
  { event: 'view_item', label: 'Viewed a product' },
  { event: 'add_to_cart', label: 'Added to cart' },
  { event: 'begin_checkout', label: 'Started checkout' },
  { event: 'add_payment_info', label: 'Added payment info' },
  { event: 'purchase', label: 'Purchased' }
]
export const CONTACT_EVENTS = ['click_to_call', 'whatsapp_click', 'email_click']

export interface FunnelStep {
  event: string
  label: string
  users: number
  byDevice: Record<string, number>
  rateFromPrevious: number | null     // % of previous step's users who reached this step
  dropOff: number | null              // users lost from previous step
}

export interface FunnelAnalysis {
  kind: FunnelKind
  range: DateRange
  steps: FunnelStep[]
  measured: boolean                   // false = step events missing; funnel can't be read
  missingEvents: string[]
  worstStep: { from: string; to: string; rate: number; dropOff: number } | null
  deviceGaps: { step: string; mobileRate: number; desktopRate: number }[]
  sensitivity: { step: string; extraConversions: number; extraValue: number } | null  // value of a 10% relative lift at the worst step
  formAbandonFields: { field: string; abandons: number }[] | null
  contactActions: { event: string; users: number }[]
  notes: string[]
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** Pure: builds the funnel from per-event, per-device user counts. Unit tested. */
export function computeFunnel(params: {
  kind: FunnelKind
  range: DateRange
  counts: { event: string; device: string; users: number }[]
  valuePerConversion: number
  formAbandonFields?: { field: string; abandons: number }[] | null
  conversionEvent?: string | null
}): FunnelAnalysis {
  let defs = params.kind === 'lead' ? LEAD_FUNNEL.slice() : ECOM_FUNNEL.slice()
  const has = (e: string) => params.counts.some(c => c.event === e && c.users > 0)
  // Lead sites: if form_submit is missing but the client's conversion event exists, use that as the last step.
  if (params.kind === 'lead' && !has('form_submit') && params.conversionEvent && has(params.conversionEvent)) {
    defs = [defs[0], defs[1], { event: params.conversionEvent, label: 'Converted' }]
  }
  // E-commerce: add_payment_info is often not implemented; skip it rather than show a fake 0.
  if (params.kind === 'ecommerce' && !has('add_payment_info')) defs = defs.filter(d => d.event !== 'add_payment_info')

  const notes: string[] = []
  const missingEvents = defs.filter(d => d.event !== '__users__' && !has(d.event)).map(d => d.event)

  const steps: FunnelStep[] = defs.map(d => {
    const rows = params.counts.filter(c => c.event === d.event)
    const byDevice: Record<string, number> = {}
    for (const r of rows) byDevice[r.device] = (byDevice[r.device] ?? 0) + r.users
    return { event: d.event, label: d.label, users: rows.reduce((s, r) => s + r.users, 0), byDevice, rateFromPrevious: null, dropOff: null }
  })
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1].users
    steps[i].rateFromPrevious = prev > 0 ? round1(Math.min(100, (steps[i].users / prev) * 100)) : null
    steps[i].dropOff = prev > 0 ? Math.max(0, prev - steps[i].users) : null
  }

  const measured = missingEvents.length === 0
  if (!measured) notes.push(`Funnel events not received in GA4: ${missingEvents.join(', ')}. ${params.kind === 'lead' ? 'Install the Fischer tracking kit' : 'Implement GA4 e-commerce events'} to measure drop-off.`)

  // Worst step (lowest step rate), ignoring the first "visitors" step for lead funnels if it's huge by nature
  let worstStep: FunnelAnalysis['worstStep'] = null
  if (measured) {
    for (let i = 1; i < steps.length; i++) {
      const r = steps[i].rateFromPrevious
      if (r == null) continue
      if (params.kind === 'lead' && i === 1) continue // visitors → form_start is a page-level question; the form itself is steps 2+
      if (!worstStep || r < worstStep.rate) worstStep = { from: steps[i - 1].label, to: steps[i].label, rate: r, dropOff: steps[i].dropOff ?? 0 }
    }
    // Lead funnel with only 3 steps: the form completion step is the one to report
    if (!worstStep && steps.length >= 2 && steps[steps.length - 1].rateFromPrevious != null) {
      const last = steps[steps.length - 1]
      worstStep = { from: steps[steps.length - 2].label, to: last.label, rate: last.rateFromPrevious!, dropOff: last.dropOff ?? 0 }
    }
  }

  const deviceGaps: FunnelAnalysis['deviceGaps'] = []
  for (let i = 1; i < steps.length; i++) {
    const pm = steps[i - 1].byDevice.mobile, pd = steps[i - 1].byDevice.desktop
    if (!pm || !pd || pm < 50 || pd < 50) continue
    const mr = round1(((steps[i].byDevice.mobile ?? 0) / pm) * 100)
    const dr = round1(((steps[i].byDevice.desktop ?? 0) / pd) * 100)
    if (dr > 0 && mr < dr * 0.75) deviceGaps.push({ step: `${steps[i - 1].label} → ${steps[i].label}`, mobileRate: mr, desktopRate: dr })
  }

  // Value of improving the worst step by 10% (relative): extra users flow through the rest of the funnel.
  let sensitivity: FunnelAnalysis['sensitivity'] = null
  if (worstStep) {
    const idx = steps.findIndex(s => s.label === worstStep!.to)
    const entering = steps[idx - 1].users
    const extraAtStep = entering * (worstStep.rate / 100) * 0.1
    const last = steps[steps.length - 1].users
    const downstream = steps[idx].users > 0 ? last / steps[idx].users : 0
    const extraConversions = round1(extraAtStep * downstream)
    sensitivity = { step: `${worstStep.from} → ${worstStep.to}`, extraConversions, extraValue: Math.round(extraConversions * params.valuePerConversion) }
  }

  const contactActions = CONTACT_EVENTS.map(e => ({ event: e, users: params.counts.filter(c => c.event === e).reduce((s, c) => s + c.users, 0) }))
  if (params.kind === 'lead' && contactActions.every(c => c.users === 0)) notes.push('No click-to-call, WhatsApp or email clicks are tracked — these are often a large share of leads.')

  return {
    kind: params.kind, range: params.range, steps, measured, missingEvents, worstStep, deviceGaps, sensitivity,
    formAbandonFields: params.formAbandonFields ?? null, contactActions, notes
  }
}

/** Fetches step counts (and field-level abandonment if available) and computes the funnel. */
export async function fetchFunnel(params: {
  propertyId: string
  range: DateRange
  kind: FunnelKind
  valuePerConversion: number
  conversionEvent?: string | null
}): Promise<FunnelAnalysis> {
  const ga = getGA4Client(params.propertyId)
  const property = `properties/${params.propertyId}`
  const defs = params.kind === 'lead' ? LEAD_FUNNEL : ECOM_FUNNEL
  const events = Array.from(new Set([...defs.map(d => d.event).filter(e => e !== '__users__'), ...CONTACT_EVENTS, ...(params.conversionEvent ? [params.conversionEvent] : [])]))

  const [stepRes, usersRes] = await Promise.all([
    ga.runReport({
      property, dateRanges: [params.range],
      dimensions: [{ name: 'eventName' }, { name: 'deviceCategory' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: events } } },
      metrics: [{ name: 'totalUsers' }]
    }),
    ga.runReport({
      property, dateRanges: [params.range],
      dimensions: [{ name: 'deviceCategory' }],
      metrics: [{ name: 'totalUsers' }]
    })
  ])
  const counts = (stepRes[0]?.rows ?? []).map(r => ({
    event: r.dimensionValues?.[0]?.value ?? '', device: r.dimensionValues?.[1]?.value ?? 'other', users: Number(r.metricValues?.[0]?.value ?? 0)
  }))
  for (const r of usersRes[0]?.rows ?? []) {
    counts.push({ event: '__users__', device: r.dimensionValues?.[0]?.value ?? 'other', users: Number(r.metricValues?.[0]?.value ?? 0) })
  }

  // Field-level form abandonment — only works once "field_name" is registered as a custom dimension.
  let formAbandonFields: FunnelAnalysis['formAbandonFields'] = null
  if (params.kind === 'lead') {
    try {
      const [res] = await ga.runReport({
        property, dateRanges: [params.range],
        dimensions: [{ name: 'customEvent:field_name' }],
        dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'form_abandon', matchType: 'EXACT' as any } } },
        metrics: [{ name: 'eventCount' }],
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
        limit: 10
      })
      formAbandonFields = (res.rows ?? []).map(r => ({ field: r.dimensionValues?.[0]?.value ?? '(not set)', abandons: Number(r.metricValues?.[0]?.value ?? 0) }))
    } catch { formAbandonFields = null }
  }

  return computeFunnel({ kind: params.kind, range: params.range, counts, valuePerConversion: params.valuePerConversion, formAbandonFields, conversionEvent: params.conversionEvent })
}

export function funnelKindForGoal(goal?: string | null): FunnelKind {
  return /e-?commerce|sales|shop|store/i.test(goal ?? '') ? 'ecommerce' : 'lead'
}

export function formatFunnelForPrompt(f: FunnelAnalysis): string {
  if (!f.measured) return `**SITE FUNNEL (GA4):** not measurable — missing events ${f.missingEvents.join(', ')}. Treat this as a measurement gap.`
  const lines = [`**SITE FUNNEL (GA4 open funnel, ${f.range.startDate} → ${f.range.endDate}, users reaching each step):**`]
  for (const s of f.steps) lines.push(`- ${s.label}: ${s.users.toLocaleString()}${s.rateFromPrevious != null ? ` (${s.rateFromPrevious}% of previous step)` : ''}`)
  if (f.worstStep) lines.push(`Biggest drop: ${f.worstStep.from} → ${f.worstStep.to} (${f.worstStep.rate}% continue, ${f.worstStep.dropOff.toLocaleString()} users lost).`)
  for (const g of f.deviceGaps) lines.push(`Mobile lags at "${g.step}": ${g.mobileRate}% vs ${g.desktopRate}% desktop.`)
  if (f.formAbandonFields?.length) lines.push(`Form fields where people abandon most: ${f.formAbandonFields.slice(0, 5).map(x => `${x.field} (${x.abandons})`).join(', ')}.`)
  lines.push('If this page contains the step where the funnel drops most, your top findings should explain that drop using what you can see.')
  return lines.join('\n')
}
