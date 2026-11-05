import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuditResult, FrictionPoint } from './claude'
import type { ClientRow, StoredScreenshots } from './audit-pipeline'
import type { ClarityPageData } from './clarity'
import type { GA4Totals } from './ga4-audit'
import { monthRange } from './ga4-audit'
import { measureChangeImpact, periodToDate, shiftPeriod, type ChangeImpact } from './snapshots'
import { pctChange, type TestResultStats } from './stats'

export interface KpiValue { current: number | null; previous: number | null; changePct: number | null }

export interface PageReport {
  pageUrl: string
  auditId: string
  auditDate: string
  fischerScore: number
  previousScore: number | null
  scoreBreakdown: AuditResult['scoreBreakdown'] | null
  summary: string
  strengths: AuditResult['strengths']
  topFindings: FrictionPoint[]
  followUp: AuditResult['previousIssueFollowUp']
  resolvedCount: number
  pageChanges: string | null
  screenshotDesktop: string | null
  screenshotMobile: string | null
  revenueImpact: AuditResult['revenueImpact'] | null
  highestPriorityFix: string
  highestPriorityFixReason: string
  ga4: { sessions: number; conversionRate: number; prevConversionRate: number | null } | null
}

export interface MonthlyReport {
  client: { id: string; name: string; logoUrl: string | null; currency: string; contactName: string | null; contactEmail: string | null }
  period: string
  periodLabel: string
  previousPeriodLabel: string
  generatedAt: string
  integrations: { ga4: boolean; clarity: boolean }
  kpis: {
    sessions: KpiValue
    conversions: KpiValue
    conversionRate: KpiValue
    revenue: KpiValue
    engagementRate: KpiValue
    rageClickRate: KpiValue
    deadClickRate: KpiValue
    scrollDepth: KpiValue
    avgFischerScore: KpiValue
  }
  trend: { period: string; label: string; sessions: number | null; conversions: number | null; conversionRate: number | null; revenue: number | null; avgFischerScore: number | null }[]
  pages: PageReport[]
  changes: { date: string; title: string; description: string | null; source: string; pageUrl: string | null; impact: ChangeImpact | null }[]
  tests: { id: string; name: string; status: string; pageUrl: string | null; hypothesis: string; startDate: string | null; endDate: string | null; stats: TestResultStats | null; winner: string | null; resultSummary: string | null }[]
  nextMonth: string[]
  dataNotes: string[]
}

const monthLabel = (period: string) =>
  new Date(`${period.slice(0, 7)}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

const kpi = (current: number | null | undefined, previous: number | null | undefined): KpiValue => ({
  current: current ?? null, previous: previous ?? null, changePct: pctChange(previous, current)
})

/**
 * Assembles everything for one client's monthly report. Uses the service-role
 * client (the public report page has no logged-in user) — callers must
 * authorise the request (share token or team session) before calling this.
 */
export async function buildMonthlyReport(supabase: SupabaseClient, clientId: string, period: string): Promise<MonthlyReport> {
  period = period.slice(0, 7)
  const { data: client } = await supabase.from('clients').select('*').eq('id', clientId).single()
  if (!client) throw new Error('Client not found.')
  const c = client as ClientRow & Record<string, any>

  const range = monthRange(period)
  const prevPeriod = shiftPeriod(period, -1)
  const trendStart = shiftPeriod(period, -5)

  const [{ data: snapshots }, { data: audits }, { data: changes }, { data: tests }, { data: tracked }] = await Promise.all([
    supabase.from('monthly_snapshots').select('*').eq('client_id', clientId)
      .gte('period', periodToDate(trendStart)).lte('period', periodToDate(period)).order('period'),
    supabase.from('audits').select('id, page_url, completed_at, fischer_score, output, screenshots, page_diff, ga4_data')
      .eq('client_id', clientId).eq('status', 'complete')
      .lte('completed_at', `${range.endDate}T23:59:59Z`).order('completed_at', { ascending: false }).limit(200),
    supabase.from('change_log').select('*').eq('client_id', clientId)
      .gte('change_date', range.startDate).lte('change_date', range.endDate).order('change_date'),
    supabase.from('test_briefs').select('*').eq('client_id', clientId).order('created_at', { ascending: false }).limit(50),
    supabase.from('tracked_pages').select('page_url').eq('client_id', clientId).eq('active', true)
  ])

  const snap = (p: string) => (snapshots ?? []).find(s => String(s.period).slice(0, 7) === p)
  const cur = snap(period), prev = snap(prevPeriod)
  const t = (s: any): GA4Totals | undefined => s?.ga4?.success ? s.ga4.totals : undefined
  const cl = (s: any): ClarityPageData | undefined => s?.clarity ?? undefined

  // Fischer Score per month = average of the latest audit of each page in that month
  const auditsByMonth = new Map<string, Map<string, any>>()
  for (const a of audits ?? []) {
    const m = String(a.completed_at).slice(0, 7)
    if (!auditsByMonth.has(m)) auditsByMonth.set(m, new Map())
    const pm = auditsByMonth.get(m)!
    if (!pm.has(a.page_url)) pm.set(a.page_url, a) // list is newest-first
  }
  const avgScore = (m: string) => {
    const pm = auditsByMonth.get(m)
    if (!pm || pm.size === 0) return null
    const scores = Array.from(pm.values()).map(a => a.fischer_score).filter((x: unknown) => typeof x === 'number')
    return scores.length ? Math.round(scores.reduce((s: number, x: number) => s + x, 0) / scores.length) : null
  }

  // Pages: latest audit up to the end of the period, per page (tracked pages first)
  const latestByPage = new Map<string, any>()
  for (const a of audits ?? []) if (!latestByPage.has(a.page_url)) latestByPage.set(a.page_url, a)
  const pageOrder = [
    ...(tracked ?? []).map(tp => tp.page_url).filter(u => latestByPage.has(u)),
    ...Array.from(latestByPage.keys()).filter(u => !(tracked ?? []).some(tp => tp.page_url === u))
  ]

  const pages: PageReport[] = pageOrder.slice(0, 8).map(url => {
    const a = latestByPage.get(url)
    const o = a.output as AuditResult
    const prevAudit = (audits ?? []).find(x => x.page_url === url && x.id !== a.id && x.completed_at < a.completed_at)
    const shots = a.screenshots as StoredScreenshots | null
    const pageSnap = cur?.pages?.find((p: any) => p.pageUrl === url)
    const prevPageSnap = prev?.pages?.find((p: any) => p.pageUrl === url)
    const followUp = o.previousIssueFollowUp ?? []
    return {
      pageUrl: url,
      auditId: a.id,
      auditDate: a.completed_at,
      fischerScore: a.fischer_score,
      previousScore: prevAudit?.fischer_score ?? null,
      scoreBreakdown: o.scoreBreakdown ?? null,
      summary: o.summary,
      strengths: (o.strengths ?? []).slice(0, 3),
      topFindings: (o.frictionPoints ?? []).filter(f => f.verified !== false).slice(0, 5),
      followUp,
      resolvedCount: followUp.filter(f => f.status === 'resolved' || f.status === 'improved').length,
      pageChanges: a.page_diff?.changed ? a.page_diff.summary : null,
      screenshotDesktop: shots?.desktop?.[0]?.url ?? null,
      screenshotMobile: shots?.mobile?.[0]?.url ?? null,
      revenueImpact: o.revenueImpact?.basis !== 'none' ? o.revenueImpact : null,
      highestPriorityFix: o.highestPriorityFix,
      highestPriorityFixReason: o.highestPriorityFixReason,
      ga4: pageSnap?.ga4 ? { sessions: pageSnap.ga4.sessions, conversionRate: pageSnap.ga4.conversionRate, prevConversionRate: prevPageSnap?.ga4?.conversionRate ?? null } : null
    }
  })

  // Changes in the period with before/after impact (measured once the window has elapsed, then cached)
  const changeRows = []
  for (const ch of changes ?? []) {
    let impact: ChangeImpact | null = ch.details?.impact ?? null
    if (c.ga4_property_id && (!impact || !impact.afterComplete)) {
      try {
        impact = await measureChangeImpact(c, ch)
        if (impact) await supabase.from('change_log').update({ details: { ...(ch.details ?? {}), impact } }).eq('id', ch.id)
      } catch { /* keep the cached value */ }
    }
    changeRows.push({ date: ch.change_date, title: ch.title, description: ch.description, source: ch.source, pageUrl: ch.page_url, impact })
  }

  // Tests active during the period
  const testRows = (tests ?? []).filter(tb => {
    const start = tb.test_start_date, end = tb.test_end_date
    if (tb.status === 'running') return true
    if (tb.status === 'completed' && end) return end >= range.startDate && (start ?? end) <= range.endDate
    return false
  }).map(tb => ({
    id: tb.id, name: tb.hypothesis_name, status: tb.status, pageUrl: tb.page_url,
    hypothesis: tb.brief?.hypothesis ?? tb.hypothesis?.hypothesis ?? '',
    startDate: tb.test_start_date, endDate: tb.test_end_date,
    stats: tb.stats ?? null, winner: tb.winner ?? null, resultSummary: tb.result_summary ?? null
  }))

  const latestOverall = (audits ?? [])[0]?.output as AuditResult | undefined
  const nextMonth = [
    ...(tests ?? []).filter(tb => tb.status === 'approved' || tb.status === 'draft').slice(0, 3).map(tb => `A/B test: ${tb.hypothesis_name}`),
    ...(latestOverall?.actionPlan?.thisMonth ?? []).slice(0, 5)
  ]

  const dataNotes: string[] = []
  if (!c.ga4_property_id) dataNotes.push('GA4 is not connected for this client — traffic and conversion figures are unavailable.')
  else if (!cur) dataNotes.push(`No GA4 snapshot stored for ${monthLabel(period)} yet — it is created automatically on the 1st of the following month.`)
  if (!c.clarity_api_token) dataNotes.push('Microsoft Clarity is not connected — no behaviour (rage/dead click) data.')
  else if ((cur?.clarity_days ?? 0) < 20) dataNotes.push(`Clarity data covers ${cur?.clarity_days ?? 0} day(s) of this month (collection is daily from the date Clarity was connected).`)
  if (changeRows.some(ch => ch.impact)) dataNotes.push('Before/after figures compare the 28 days before each change with the 28 days after. They show what happened, not proof the change caused it (seasonality and campaigns also move numbers). A/B test results are the controlled evidence.')

  const trend = Array.from({ length: 6 }, (_, i) => shiftPeriod(trendStart, i)).map(p => {
    const s = snap(p)
    const tt = t(s)
    return { period: p, label: monthLabel(p).split(' ')[0].slice(0, 3), sessions: tt?.sessions ?? null, conversions: tt?.conversions ?? null, conversionRate: tt?.conversionRate ?? null, revenue: tt?.revenue || null, avgFischerScore: avgScore(p) }
  })

  return {
    client: {
      id: c.id, name: c.name, logoUrl: c.report_logo_url ?? null, currency: c.currency || 'ZAR',
      contactName: c.report_contact_name ?? null, contactEmail: c.report_contact_email ?? null
    },
    period,
    periodLabel: monthLabel(period),
    previousPeriodLabel: monthLabel(prevPeriod),
    generatedAt: new Date().toISOString(),
    integrations: { ga4: !!c.ga4_property_id, clarity: !!c.clarity_api_token },
    kpis: {
      sessions: kpi(t(cur)?.sessions, t(prev)?.sessions),
      conversions: kpi(t(cur)?.conversions, t(prev)?.conversions),
      conversionRate: kpi(t(cur)?.conversionRate, t(prev)?.conversionRate),
      revenue: kpi(t(cur)?.revenue || null, t(prev)?.revenue || null),
      engagementRate: kpi(t(cur)?.engagementRate, t(prev)?.engagementRate),
      rageClickRate: kpi(cl(cur)?.rageClickRate, cl(prev)?.rageClickRate),
      deadClickRate: kpi(cl(cur)?.deadClickRate, cl(prev)?.deadClickRate),
      scrollDepth: kpi(cl(cur)?.avgScrollDepth, cl(prev)?.avgScrollDepth),
      avgFischerScore: kpi(avgScore(period), avgScore(prevPeriod))
    },
    trend,
    pages,
    changes: changeRows,
    tests: testRows,
    nextMonth,
    dataNotes
  }
}
