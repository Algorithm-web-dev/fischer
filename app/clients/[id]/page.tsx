'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Page, Button, Field, Pill, inputStyle, cardStyle, labelStyle, T, api, scoreColor } from '@/components/ui'
import { ClientForm, toFormValues } from '@/components/ClientForm'

type Tab = 'overview' | 'leaks' | 'pages' | 'changes' | 'tests' | 'reports' | 'settings'

const lastMonth = () => {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1)
  return d.toISOString().slice(0, 7)
}
const fmt = (n: number | null | undefined, dp = 0) => n == null ? '—' : n.toLocaleString('en-ZA', { maximumFractionDigits: dp, minimumFractionDigits: dp })
const pctDelta = (a: number | null, b: number | null) => a == null || b == null || a === 0 ? null : ((b - a) / Math.abs(a)) * 100

function DeltaText({ v, invert }: { v: number | null; invert?: boolean }) {
  if (v == null) return null
  const good = invert ? v < 0 : v > 0
  return <span style={{ color: Math.abs(v) < 0.5 ? T.muted : good ? T.good : T.bad, fontSize: 12, marginLeft: 6 }}>{v > 0 ? '▲' : '▼'}{Math.abs(v).toFixed(1)}%</span>
}

export default function ClientDashboard({ params }: { params: { id: string } }) {
  const [tab, setTab] = useState<Tab>('overview')
  const [client, setClient] = useState<any>(null)
  const [trends, setTrends] = useState<any>(null)
  const [error, setError] = useState('')
  const [alerts, setAlerts] = useState<any[]>([])

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as Tab | null
    if (t) setTab(t)
  }, [])

  const load = useCallback(async () => {
    try {
      const [c, t, al] = await Promise.all([api(`/api/clients/${params.id}`), api(`/api/clients/${params.id}/trends`), api(`/api/alerts?clientId=${params.id}`).catch(() => ({ alerts: [] }))])
      setClient(c.client); setTrends(t); setAlerts(al.alerts)
    } catch (e) { setError(e instanceof Error ? e.message : 'Load failed') }
  }, [params.id])
  useEffect(() => { load() }, [load])

  const tabs: [Tab, string][] = [['overview', 'Overview'], ['leaks', 'Revenue leaks'], ['pages', 'Pages & audits'], ['changes', 'Changes'], ['tests', 'A/B tests'], ['reports', 'Reports'], ['settings', 'Settings']]

  return (
    <Page title={client?.name ?? 'Client'} actions={client && <div style={{ display: 'flex', gap: 6 }}>
      <Pill color={client.integrations.ga4 ? T.good : T.muted}>GA4 {client.integrations.ga4 ? 'on' : 'off'}</Pill>
      <Pill color={client.integrations.clarity ? T.good : T.muted}>Clarity {client.integrations.clarity ? 'on' : 'off'}</Pill>
    </div>}>
      {error && <div style={{ color: T.bad }}>{error}</div>}
      {alerts.length > 0 && (
        <div style={{ ...cardStyle, borderColor: T.bad, padding: 14 }}>
          {alerts.map(a => (
            <div key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0', flexWrap: 'wrap' }}>
              <Pill color={a.severity === 'high' ? T.bad : a.severity === 'medium' ? T.warn : T.muted}>{a.severity}</Pill>
              <div style={{ flex: '1 1 300px', fontSize: 14 }}><strong>{a.title}</strong> <span style={{ color: T.muted, fontSize: 12 }}>{a.created_at.slice(0, 10)}</span>
                {a.message && <div style={{ fontSize: 13, color: T.muted, whiteSpace: 'pre-line' }}>{a.message}</div>}</div>
              {a.link && <a href={a.link} style={{ color: T.gold, fontSize: 13 }}>Open</a>}
              <Button kind="ghost" onClick={async () => { await api('/api/alerts', { method: 'PATCH', json: { id: a.id } }); setAlerts(alerts.filter(x => x.id !== a.id)) }}>Resolve</Button>
            </div>))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${T.line}`, marginBottom: 18, overflowX: 'auto' }}>
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ background: 'none', border: 'none', color: tab === k ? T.gold : T.muted, borderBottom: `2px solid ${tab === k ? T.gold : 'transparent'}`, padding: '10px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 14, fontFamily: 'inherit', whiteSpace: 'nowrap' }}>{label}</button>
        ))}
      </div>
      {!client || !trends ? <p style={{ color: T.muted }}>Loading…</p> : (
        <>
          {tab === 'overview' && <Overview trends={trends} />}
          {tab === 'leaks' && <Leaks client={client} onTracked={() => setTab('pages')} />}
          {tab === 'pages' && <Pages client={client} trends={trends} reload={load} />}
          {tab === 'changes' && <Changes clientId={client.id} />}
          {tab === 'tests' && <Tests clientId={client.id} />}
          {tab === 'reports' && <Reports clientId={client.id} />}
          {tab === 'settings' && <Settings client={client} reload={load} />}
        </>
      )}
    </Page>
  )
}

// ---------------------------------------------------------------- Overview
function Overview({ trends }: { trends: any }) {
  const months: any[] = trends.months
  const pages = Object.entries(trends.scoreHistory as Record<string, any[]>)
  return (
    <>
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Month by month</h3>
        {months.length === 0 ? <p style={{ color: T.muted }}>No monthly snapshots yet. They are built automatically each day once GA4 or Clarity is connected (Settings → Test connections).</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>{['Month', 'Sessions', 'Conversions', 'Conv. rate', 'Revenue', 'Engagement', 'Rage clicks', 'Dead clicks', 'Scroll'].map(h => <th key={h} style={{ ...labelStyle, textAlign: 'left', padding: 8, borderBottom: `1px solid ${T.line}` }}>{h}</th>)}</tr></thead>
              <tbody>{months.map((m, i) => {
                const p = months[i - 1]
                return (
                  <tr key={m.period} style={{ borderBottom: `1px solid ${T.line}` }}>
                    <td style={{ padding: 8 }}>{m.period}</td>
                    <td style={{ padding: 8 }}>{fmt(m.sessions)}<DeltaText v={pctDelta(p?.sessions, m.sessions)} /></td>
                    <td style={{ padding: 8 }}>{fmt(m.conversions)}<DeltaText v={pctDelta(p?.conversions, m.conversions)} /></td>
                    <td style={{ padding: 8 }}>{m.conversionRate == null ? '—' : `${m.conversionRate.toFixed(2)}%`}<DeltaText v={pctDelta(p?.conversionRate, m.conversionRate)} /></td>
                    <td style={{ padding: 8 }}>{m.revenue ? fmt(m.revenue) : '—'}</td>
                    <td style={{ padding: 8 }}>{m.engagementRate == null ? '—' : `${m.engagementRate.toFixed(1)}%`}</td>
                    <td style={{ padding: 8 }}>{m.rageClickRate == null ? '—' : `${m.rageClickRate}%`}<DeltaText v={pctDelta(p?.rageClickRate, m.rageClickRate)} invert /></td>
                    <td style={{ padding: 8 }}>{m.deadClickRate == null ? '—' : `${m.deadClickRate}%`}<DeltaText v={pctDelta(p?.deadClickRate, m.deadClickRate)} invert /></td>
                    <td style={{ padding: 8 }}>{m.scrollDepth == null ? '—' : `${Math.round(m.scrollDepth)}%`}</td>
                  </tr>)
              })}</tbody>
            </table>
          </div>
        )}
      </div>
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Fischer Score history</h3>
        {pages.length === 0 ? <p style={{ color: T.muted }}>No completed audits yet.</p> : pages.map(([url, runs]) => (
          <div key={url} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, color: T.muted, marginBottom: 6, wordBreak: 'break-all' }}>{url}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {runs.map((r: any, i: number) => (
                <Link key={r.auditId} href={`/audit?view=${r.auditId}`} title={r.changed ? 'Page changed since previous audit' : ''} style={{ textDecoration: 'none', background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 8, padding: '6px 10px', color: T.text, fontSize: 13 }}>
                  <span style={{ color: scoreColor(r.score), fontWeight: 700 }}>{r.score}</span> <span style={{ color: T.muted }}>{r.date.slice(0, 10)}</span>{r.changed ? ' ✎' : ''}
                  {i > 0 && <DeltaText v={pctDelta(runs[i - 1].score, r.score)} />}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- Revenue leaks
function Leaks({ client, onTracked }: { client: any; onTracked: () => void }) {
  const [analysis, setAnalysis] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [days, setDays] = useState(30)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => { api(`/api/clients/${client.id}/leaks`).then(d => setAnalysis(d.analysis)).finally(() => setLoading(false)) }, [client.id])

  async function run(trackTop = 0) {
    setRunning(true); setError('')
    try {
      const d = await api(`/api/clients/${client.id}/leaks`, { method: 'POST', json: { days, trackTop } })
      setAnalysis(d.analysis)
      if (trackTop && d.tracked?.length) { alert(`Now tracking: ${d.tracked.join(', ')}`); onTracked() }
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
    finally { setRunning(false) }
  }

  async function trackPage(url: string) {
    await api('/api/tracked-pages', { method: 'POST', json: { clientId: client.id, pageUrl: url } })
    alert(`Tracking ${url} — run its baseline audit from Pages & audits.`)
  }

  if (!client.integrations.ga4) return <div style={cardStyle}><p style={{ margin: 0, color: T.muted }}>Connect GA4 in Settings to build a revenue leak map.</p></div>
  const a = analysis?.data
  const cur = client.currency === 'ZAR' || !client.currency ? 'R' : client.currency + ' '
  const money = (n: number) => `${cur}${Math.round(n).toLocaleString('en-ZA')}`
  const scale = a ? 30 / Math.max(1, a.periodDays) : 1

  return (
    <>
      <div style={cardStyle}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
          <Field label="Look back"><select style={{ ...inputStyle, width: 140 }} value={days} onChange={e => setDays(Number(e.target.value))}><option value={30}>30 days</option><option value={60}>60 days</option><option value={90}>90 days</option></select></Field>
          <div style={{ marginBottom: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={() => run(0)} disabled={running}>{running ? 'Analysing GA4…' : a ? 'Refresh leak map' : 'Build leak map'}</Button>
            {a && <Button kind="ghost" onClick={() => run(3)} disabled={running}>Track top 3 leaking pages</Button>}
          </div>
        </div>
        <p style={{ fontSize: 12, color: T.muted, margin: 0 }}>Every landing page is split by device and compared with the site&apos;s own conversion rate for that device. “Recoverable” assumes we close half of each gap. Pages with fewer than 100 sessions per device are ignored as noise.</p>
        {error && <div style={{ color: T.bad, marginTop: 8 }}>{error}</div>}
      </div>
      {loading ? <p style={{ color: T.muted }}>Loading…</p> : !a ? null : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 18 }}>
            <div style={{ ...cardStyle, marginBottom: 0 }}><div style={labelStyle}>Recoverable per month</div><div style={{ fontSize: 30, fontWeight: 700, color: T.gold }}>{a.valuePerConversion ? money(a.totals.recoverableMonthly) : '—'}</div><div style={{ fontSize: 12, color: T.muted }}>{a.valueBasis === 'ga4_revenue' ? 'value from GA4 revenue' : a.valueBasis === 'client_setting' ? `at ${money(a.valuePerConversion)} per conversion` : 'set a value per conversion'}</div></div>
            <div style={{ ...cardStyle, marginBottom: 0 }}><div style={labelStyle}>Site conversion rate</div><div style={{ fontSize: 30, fontWeight: 700 }}>{a.site.conversionRate}%</div><div style={{ fontSize: 12, color: T.muted }}>{fmt(a.site.conversions)} from {fmt(a.site.sessions)} sessions · {a.range.startDate} → {a.range.endDate}</div></div>
            <div style={{ ...cardStyle, marginBottom: 0 }}><div style={labelStyle}>Gap by device</div>{a.byDevice.map((d: any) => <div key={d.device} style={{ fontSize: 14 }}>{d.device}: <strong>{d.share}%</strong> <span style={{ color: T.muted }}>({fmt(a.site.byDevice[d.device]?.conversionRate, 2)}% CVR)</span></div>)}</div>
          </div>
          {a.notes.length > 0 && <div style={{ ...cardStyle, borderColor: T.warn }}>{a.notes.map((n: string, i: number) => <div key={i} style={{ color: T.warn, fontSize: 13 }}>{n}</div>)}</div>}
          <div style={cardStyle}>
            <h3 style={{ marginTop: 0 }}>Leaking pages</h3>
            {a.pages.length === 0 ? <p style={{ color: T.muted }}>No page converts meaningfully below the site average. 🎉</p> : a.pages.map((p: any) => (
              <div key={p.page} style={{ borderTop: `1px solid ${T.line}`, padding: '10px 0' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 260px', wordBreak: 'break-all' }}><strong>{p.page}</strong><div style={{ fontSize: 12, color: T.muted }}>{fmt(p.sessions)} sessions · {p.conversionRate}% CVR · worst on {p.worstDevice ?? '—'}</div></div>
                  <div style={{ width: 150 }}><div style={{ height: 6, background: T.line, borderRadius: 3 }}><div style={{ width: `${Math.min(100, p.share)}%`, height: 6, background: T.bad, borderRadius: 3 }} /></div><div style={{ fontSize: 12, color: T.muted }}>{p.share}% of the gap</div></div>
                  <div style={{ width: 130, textAlign: 'right', fontWeight: 700, color: T.gold }}>{a.valuePerConversion ? `${money(p.recoverableValue * scale)}/mo` : `${fmt(p.cells.reduce((s: number, c: any) => s + c.lostConversions, 0), 1)} conv.`}</div>
                  <Button kind="ghost" onClick={() => setOpen(open === p.page ? null : p.page)}>{open === p.page ? 'Hide' : 'Devices'}</Button>
                  {p.url && <Button kind="ghost" onClick={() => trackPage(p.url)}>Track</Button>}
                </div>
                {open === p.page && <div style={{ fontSize: 13, marginTop: 8 }}>{p.cells.map((c: any) => <div key={c.device}>{c.device}: {c.conversionRate}% vs {c.targetRate}% target on {fmt(c.sessions)} sessions → {c.lostConversions} conversions lost</div>)}</div>}
              </div>))}
            {!client.primary_url && <p style={{ fontSize: 12, color: T.warn }}>Set the client&apos;s website in Settings so pages can be tracked with one click.</p>}
          </div>
          {a.funnel && <FunnelCard f={a.funnel} money={a.valuePerConversion ? money : null} />}
          {a.mobileGap && <div style={cardStyle}><h3 style={{ marginTop: 0 }}>Mobile gap</h3><p style={{ margin: 0 }}>Mobile converts at <strong>{a.mobileGap.mobileRate}%</strong> vs <strong>{a.mobileGap.desktopRate}%</strong> on desktop. Reaching {a.mobileGap.targetRate}% (70% of desktop) on {fmt(a.mobileGap.mobileSessions)} mobile sessions = {fmt(a.mobileGap.lostConversions, 1)} more conversions{a.valuePerConversion ? `, ≈${money(a.mobileGap.value * scale)}/month at half the gap` : ''}.</p></div>}
          {a.paidTraffic.length > 0 && <div style={cardStyle}><h3 style={{ marginTop: 0 }}>Paid traffic on under-performing pages</h3>
            {a.paidTraffic.map((p: any, i: number) => <div key={i} style={{ fontSize: 14, padding: '4px 0' }}>{p.channel} → <strong>{p.page}</strong>: {p.conversionRate}% vs site {p.siteRate}% on {fmt(p.sessions)} sessions{a.valuePerConversion ? ` · ≈${money(p.value * scale)}/mo` : ''}</div>)}
            <p style={{ fontSize: 12, color: T.muted }}>Ad spend landing on these pages converts below average — fix the page or the ad-to-page message match before buying more traffic.</p></div>}
        </>
      )}
    </>
  )
}

function JourneyDetail({ j }: { j: any }) {
  const r = j.result
  return (
    <div style={{ flexBasis: '100%', background: T.panel2, borderRadius: 10, padding: 14, marginTop: 6 }}>
      <div style={{ fontSize: 12, color: T.muted, marginBottom: 8 }}>{r.kind === 'lead' ? 'Lead' : 'Checkout'} journey on mobile · {j.created_at.slice(0, 16).replace('T', ' ')} · nothing was submitted</div>
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 6 }}>
        {r.steps.map((s: any, i: number) => (
          <div key={i} style={{ minWidth: 170, maxWidth: 170 }}>
            {s.screenshotUrl && <img src={s.screenshotUrl} alt={s.name} style={{ width: '100%', borderRadius: 6, border: `2px solid ${s.ok ? T.line : T.bad}` }} />}
            <div style={{ fontSize: 12, marginTop: 4 }}><strong style={{ color: s.ok ? T.good : T.bad }}>{s.ok ? '✓' : '✗'} {s.name}</strong><div style={{ color: T.muted }}>{s.detail}</div></div>
          </div>))}
      </div>
      {r.issues.map((i: any) => <div key={i.code} style={{ fontSize: 13, padding: '3px 0' }}><Pill color={i.severity === 'high' ? T.bad : i.severity === 'medium' ? T.warn : T.muted}>{i.severity}</Pill> {i.message} <span style={{ color: T.muted }}>— {i.fix}</span></div>)}
      {r.checkout?.paymentMethods?.length > 0 && <div style={{ fontSize: 12, color: T.muted }}>Payment methods seen: {r.checkout.paymentMethods.join(', ')}</div>}
    </div>
  )
}

function FunnelCard({ f, money }: { f: any; money: ((n: number) => string) | null }) {
  const max = Math.max(1, ...f.steps.map((s: any) => s.users))
  return (
    <div style={cardStyle}>
      <h3 style={{ marginTop: 0 }}>{f.kind === 'ecommerce' ? 'Checkout funnel' : 'Lead funnel'} <span style={{ fontSize: 12, color: T.muted, fontWeight: 400 }}>users reaching each step</span></h3>
      {!f.measured && <p style={{ color: T.warn, fontSize: 13 }}>Missing events: {f.missingEvents.join(', ')}. {f.kind === 'lead' ? 'Install the tracking kit (Settings) to measure the form funnel.' : 'Implement GA4 e-commerce events.'}</p>}
      {f.steps.map((s: any) => (
        <div key={s.event} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0', fontSize: 13 }}>
          <div style={{ width: 150 }}>{s.label}</div>
          <div style={{ flex: 1, background: T.panel2, borderRadius: 4 }}><div style={{ width: `${(s.users / max) * 100}%`, minWidth: 2, height: 18, background: T.gold, borderRadius: 4 }} /></div>
          <div style={{ width: 170, textAlign: 'right' }}>{fmt(s.users)}{s.rateFromPrevious != null && <span style={{ color: T.muted }}> · {s.rateFromPrevious}% continue</span>}</div>
        </div>))}
      {f.worstStep && <p style={{ fontSize: 14 }}><strong>Biggest drop:</strong> {f.worstStep.from} → {f.worstStep.to} — only {f.worstStep.rate}% continue ({fmt(f.worstStep.dropOff)} users lost).{f.sensitivity && <> A 10% improvement here ≈ {fmt(f.sensitivity.extraConversions, 1)} more conversions{money ? ` (${money(f.sensitivity.extraValue)})` : ''} per period.</>}</p>}
      {f.deviceGaps.map((g: any) => <div key={g.step} style={{ fontSize: 13, color: T.warn }}>Mobile lags at {g.step}: {g.mobileRate}% vs {g.desktopRate}% on desktop</div>)}
      {f.formAbandonFields?.length > 0 && <p style={{ fontSize: 13 }}><strong>Fields where people give up:</strong> {f.formAbandonFields.slice(0, 6).map((x: any) => `${x.field} (${x.abandons})`).join(', ')}</p>}
      {f.kind === 'lead' && <p style={{ fontSize: 13, color: T.muted }}>Contact clicks: {f.contactActions.map((c: any) => `${c.event.replace('_', ' ')} ${fmt(c.users)}`).join(' · ')}</p>}
      {f.notes.map((n: string, i: number) => <div key={i} style={{ fontSize: 12, color: T.warn }}>{n}</div>)}
    </div>
  )
}

function TrackingKit({ client }: { client: any }) {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const snippet = `<script>
  window.fischerConfig = {
    leadEvent: '${client.ga4_conversion_event || 'generate_lead'}',
    thankYouPath: '/thank-you',        // or successSelector: '.form-success'
    injectHiddenFields: true           // sends landing page + UTMs to your CRM with each lead
  };
</script>
<script src="${origin}/fischer-tracking.js" async></script>`
  return (
    <div style={cardStyle}>
      <h3 style={{ marginTop: 0 }}>Tracking kit</h3>
      <p style={{ fontSize: 13, color: T.muted, marginTop: -6 }}>Add once to every page (Google Tag Manager → Custom HTML tag → All Pages, or the site template). It sends <code>form_start</code>, <code>form_submit</code>, <code>form_abandon</code> (with the field people stopped at), the confirmed lead event, <code>click_to_call</code>, <code>whatsapp_click</code> and <code>email_click</code>. No form values are ever read.</p>
      <pre style={{ background: T.panel2, padding: 12, borderRadius: 8, fontSize: 12, overflowX: 'auto', whiteSpace: 'pre' }}>{snippet}</pre>
      <Button kind="ghost" onClick={() => navigator.clipboard.writeText(snippet)}>Copy snippet</Button>
      <ol style={{ fontSize: 13, color: T.muted, lineHeight: 1.7 }}>
        <li>Set <code>thankYouPath</code> (or <code>successSelector</code>) so only real, successful submissions count as leads.</li>
        <li>With GTM: add a GA4 Event tag with event name <code>{'{{Event}}'}</code> on a Custom Event trigger matching <code>form_start|form_submit|form_abandon|{client.ga4_conversion_event || 'generate_lead'}|click_to_call|whatsapp_click|email_click</code>.</li>
        <li>In GA4 Admin → Events, mark the lead event (and calls/WhatsApp if they count as leads) as <strong>key events</strong>.</li>
        <li>In GA4 Admin → Custom definitions, register <code>field_name</code> (event scope) to see which form fields people abandon on.</li>
      </ol>
    </div>
  )
}

// ---------------------------------------------------------------- Pages
function Pages({ client, trends, reload }: { client: any; trends: any; reload: () => void }) {
  const [pages, setPages] = useState<any[]>([])
  const [audits, setAudits] = useState<any[]>([])
  const [journeys, setJourneys] = useState<any[]>([])
  const [openJourney, setOpenJourney] = useState<string | null>(null)
  const [form, setForm] = useState({ pageUrl: client.primary_url || '', pageType: 'Landing Page', businessGoal: 'Lead Generation' })
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    const [p, a, j] = await Promise.all([api(`/api/tracked-pages?clientId=${client.id}`), api(`/api/audits?clientId=${client.id}&limit=50`), api(`/api/journeys?clientId=${client.id}`).catch(() => ({ checks: [] }))])
    setPages(p.pages); setAudits(a.audits); setJourneys(j.checks)
  }, [client.id])
  useEffect(() => { load() }, [load])
  // Refresh while audits are queued or running
  useEffect(() => {
    if (!audits.some(a => a.status === 'queued' || a.status === 'running')) return
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [audits, load])

  async function add() {
    try { await api('/api/tracked-pages', { method: 'POST', json: { clientId: client.id, ...form } }); setMsg(''); load() }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Failed') }
  }
  async function runNow(p: any) {
    setBusy(p.id)
    try {
      await api('/api/audit', { method: 'POST', json: { clientId: client.id, pageUrl: p.page_url, pageType: p.page_type, businessGoal: p.business_goal, async: true } })
      setMsg('Audit queued — it starts within a minute and takes 1–4 minutes. It will appear under "All audit runs".')
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Audit failed') }
    finally { setBusy(null); load() }
  }

  async function checkJourney(p: any) {
    setBusy(`j:${p.id}`); setMsg('Walking through the page like a mobile visitor (nothing is submitted)…')
    try { const r = await api('/api/journeys', { method: 'POST', json: { trackedPageId: p.id } }); setMsg(r.check.passed ? 'Journey passed.' : 'Journey found problems — see below.'); setOpenJourney(p.id) }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Journey failed') }
    finally { setBusy(null); load() }
  }
  const lastJourney = (p: any) => journeys.find(j => j.tracked_page_id === p.id)

  return (
    <>
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Tracked pages</h3>
        <p style={{ color: T.muted, fontSize: 13, marginTop: -6 }}>Tracked pages are re-audited automatically every 30 days and included in monthly snapshots and reports.</p>
        {pages.map(p => (
          <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 0', borderBottom: `1px solid ${T.line}` }}>
            <div style={{ flex: '1 1 280px', wordBreak: 'break-all' }}>{p.page_url}<div style={{ fontSize: 12, color: T.muted }}>{p.page_type} · {p.business_goal} · last audit {p.last_audit_at ? p.last_audit_at.slice(0, 10) : 'never'}</div></div>
            {!p.active && <Pill color={T.warn}>paused</Pill>}
            <select title="Weekly journey check" style={{ ...inputStyle, width: 150 }} value={p.journey_kind ?? 'none'} onChange={async e => { await api('/api/tracked-pages', { method: 'PATCH', json: { id: p.id, journeyKind: e.target.value } }); load() }}>
              <option value="none">No journey</option><option value="lead">Lead journey</option><option value="ecommerce">Checkout journey</option>
            </select>
            {lastJourney(p) && <button onClick={() => setOpenJourney(openJourney === p.id ? null : p.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}><Pill color={lastJourney(p).passed ? T.good : T.bad}>journey {lastJourney(p).passed ? 'ok' : 'broken'}</Pill></button>}
            <Button kind="ghost" onClick={() => checkJourney(p)} disabled={!!busy}>{busy === `j:${p.id}` ? 'Checking…' : 'Check journey'}</Button>
            <Button kind="ghost" onClick={() => runNow(p)} disabled={!!busy}>{busy === p.id ? 'Running…' : 'Audit now'}</Button>
            <Button kind="ghost" onClick={async () => { await api('/api/tracked-pages', { method: 'PATCH', json: { id: p.id, active: !p.active } }); load() }}>{p.active ? 'Pause' : 'Resume'}</Button>
            {openJourney === p.id && lastJourney(p) && <JourneyDetail j={lastJourney(p)} />}
            <Button kind="danger" onClick={async () => { if (confirm('Stop tracking this page? Past audits are kept.')) { await api(`/api/tracked-pages?id=${p.id}`, { method: 'DELETE' }); load() } }}>Remove</Button>
          </div>
        ))}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 10, alignItems: 'end', marginTop: 14 }}>
          <Field label="Page URL"><input style={inputStyle} value={form.pageUrl} onChange={e => setForm({ ...form, pageUrl: e.target.value })} placeholder="https://…" /></Field>
          <Field label="Page type"><select style={inputStyle} value={form.pageType} onChange={e => setForm({ ...form, pageType: e.target.value })}>{['Landing Page', 'Home Page', 'Product Page', 'Category Page', 'Checkout', 'Pricing Page', 'Contact / Lead Form', 'Blog / Content'].map(o => <option key={o}>{o}</option>)}</select></Field>
          <Field label="Goal"><select style={inputStyle} value={form.businessGoal} onChange={e => setForm({ ...form, businessGoal: e.target.value })}>{['Lead Generation', 'E-commerce Sales', 'Bookings', 'Sign-ups', 'Calls', 'Quote Requests'].map(o => <option key={o}>{o}</option>)}</select></Field>
          <div style={{ marginBottom: 14 }}><Button onClick={add}>Track page</Button></div>
        </div>
        {msg && <div style={{ color: T.warn, fontSize: 13 }}>{msg}</div>}
      </div>
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>All audit runs</h3>
        {audits.length === 0 ? <p style={{ color: T.muted }}>No audits yet.</p> : audits.map(a => (
          <Link key={a.id} href={`/audit?view=${a.id}`} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${T.line}`, color: T.text, textDecoration: 'none', flexWrap: 'wrap' }}>
            <span style={{ width: 42, fontWeight: 700, color: scoreColor(a.fischer_score) }}>{a.fischer_score ?? '—'}</span>
            <span style={{ flex: '1 1 260px', wordBreak: 'break-all', fontSize: 13 }}>{a.page_url}</span>
            <span style={{ fontSize: 12, color: T.muted }}>{(a.completed_at || a.created_at).slice(0, 16).replace('T', ' ')}</span>
            <Pill color={a.status === 'complete' ? T.good : a.status === 'failed' ? T.bad : T.warn}>{a.status.replace(/_/g, ' ')}</Pill>
            {a.trigger === 'scheduled' && <Pill>scheduled</Pill>}
            {a.page_diff?.changed && <Pill color={T.gold}>page changed</Pill>}
          </Link>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- Changes
function Changes({ clientId }: { clientId: string }) {
  const [changes, setChanges] = useState<any[]>([])
  const [form, setForm] = useState({ title: '', description: '', pageUrl: '', changeDate: new Date().toISOString().slice(0, 10) })
  const [measuring, setMeasuring] = useState(false)
  const load = useCallback((measure = false) => {
    setMeasuring(measure)
    return api(`/api/changes?clientId=${clientId}${measure ? '&measure=1' : ''}`).then(d => setChanges(d.changes)).finally(() => setMeasuring(false))
  }, [clientId])
  useEffect(() => { load() }, [load])

  return (
    <>
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Log a change</h3>
        <p style={{ color: T.muted, fontSize: 13, marginTop: -6 }}>Shipped roadmap items, finished A/B tests and changes Fischer detects between audits are logged automatically. Log anything else here (e.g. the client&apos;s developer changed the hero).</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 12px' }}>
          <Field label="What changed *"><input style={inputStyle} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Page URL (blank = whole site)"><input style={inputStyle} value={form.pageUrl} onChange={e => setForm({ ...form, pageUrl: e.target.value })} /></Field>
          <Field label="Date live"><input type="date" style={inputStyle} value={form.changeDate} onChange={e => setForm({ ...form, changeDate: e.target.value })} /></Field>
        </div>
        <Field label="Details"><input style={inputStyle} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></Field>
        <Button disabled={!form.title} onClick={async () => { await api('/api/changes', { method: 'POST', json: { clientId, ...form, pageUrl: form.pageUrl || null } }); setForm({ ...form, title: '', description: '' }); load() }}>Add to change log</Button>
      </div>
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Change log</h3>
          <Button kind="ghost" onClick={() => load(true)} disabled={measuring}>{measuring ? 'Measuring…' : 'Measure impact (GA4)'}</Button>
        </div>
        <p style={{ fontSize: 12, color: T.muted }}>Impact compares the 28 days before each change with the 28 days after. It shows what happened, not proof the change caused it — A/B tests are the controlled evidence.</p>
        {changes.length === 0 ? <p style={{ color: T.muted }}>Nothing logged yet.</p> : changes.map(c => {
          const imp = c.details?.impact
          return (
            <div key={c.id} style={{ padding: '10px 0', borderBottom: `1px solid ${T.line}`, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <span style={{ width: 92, color: T.muted, fontSize: 13 }}>{c.change_date}</span>
              <div style={{ flex: '1 1 300px' }}><strong>{c.title}</strong> <Pill>{c.source}</Pill>
                {c.description && <div style={{ fontSize: 13, color: T.muted }}>{c.description}</div>}
                {c.page_url && <div style={{ fontSize: 12, color: T.muted, wordBreak: 'break-all' }}>{c.page_url}</div>}
              </div>
              <div style={{ fontSize: 13, minWidth: 200 }}>{imp ? <>CVR {imp.beforeMetrics.conversionRate}% → {imp.afterMetrics.conversionRate}%<DeltaText v={imp.conversionRateChangePct} />{!imp.afterComplete && <span style={{ color: T.muted }}> (partial)</span>}</> : <span style={{ color: T.muted }}>not measured</span>}</div>
              <Button kind="danger" onClick={async () => { if (confirm('Delete this change log entry?')) { await api(`/api/changes?id=${c.id}`, { method: 'DELETE' }); load() } }}>Delete</Button>
            </div>)
        })}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- Tests
function Tests({ clientId }: { clientId: string }) {
  const [tests, setTests] = useState<any[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const load = useCallback(() => api(`/api/test-brief?clientId=${clientId}`).then(d => setTests(d.briefs)), [clientId])
  useEffect(() => { load() }, [load])
  const update = async (id: string, json: unknown) => {
    try { await api(`/api/tests/${id}`, { method: 'PATCH', json }); load() } catch (e) { alert(e instanceof Error ? e.message : 'Update failed') }
  }

  return (
    <div style={cardStyle}>
      <h3 style={{ marginTop: 0 }}>A/B tests</h3>
      <p style={{ color: T.muted, fontSize: 13, marginTop: -6 }}>Create tests from an audit&apos;s hypotheses (open an audit → “Create test brief”). Enter results manually, or connect the variant dimension and pull them from GA4.</p>
      {tests.length === 0 ? <p style={{ color: T.muted }}>No tests yet.</p> : tests.map(t => (
        <div key={t.id} style={{ borderTop: `1px solid ${T.line}`, padding: '12px 0' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ flex: '1 1 260px' }}>{t.hypothesis_name}</strong>
            <Pill color={t.status === 'running' ? T.gold : t.status === 'completed' ? T.good : T.muted}>{t.status}</Pill>
            {t.winner && t.winner !== 'none' && <Pill color={t.winner === 'variant' ? T.good : T.bad}>{t.winner} won</Pill>}
            <select style={{ ...inputStyle, width: 150 }} value={t.status} onChange={e => update(t.id, { status: e.target.value })}>
              {['draft', 'approved', 'running', 'completed', 'abandoned'].map(s => <option key={s}>{s}</option>)}
            </select>
            <Button kind="ghost" onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? 'Close' : 'Details & results'}</Button>
          </div>
          {t.stats && <div style={{ fontSize: 13, marginTop: 6 }}>Control {t.stats.controlRate}% vs variant {t.stats.variantRate}% · lift {t.stats.relativeLift}% · confidence {t.stats.confidence}% — {t.stats.verdict}</div>}
          {open === t.id && <TestDetail test={t} onSave={json => update(t.id, json)} onSync={async () => { try { await api(`/api/tests/${t.id}/sync-ga4`, { method: 'POST' }); load() } catch (e) { alert(e instanceof Error ? e.message : 'Sync failed') } }} />}
        </div>
      ))}
    </div>
  )
}

function TestDetail({ test: t, onSave, onSync }: { test: any; onSave: (json: unknown) => void; onSync: () => void }) {
  const [r, setR] = useState({
    controlVisitors: t.control_visitors ?? '', controlConversions: t.control_conversions ?? '',
    variantVisitors: t.variant_visitors ?? '', variantConversions: t.variant_conversions ?? '',
    testStartDate: t.test_start_date ?? '', testEndDate: t.test_end_date ?? '',
    ga4Dimension: t.ga4_dimension ?? 'customUser:exp_variant', ga4ControlValue: t.ga4_control_value ?? '', ga4VariantValue: t.ga4_variant_value ?? ''
  })
  const b = t.brief
  const plan = t.hypothesis?.plan
  const num = (k: keyof typeof r) => (e: React.ChangeEvent<HTMLInputElement>) => setR({ ...r, [k]: e.target.value })
  return (
    <div style={{ background: T.panel2, borderRadius: 10, padding: 16, marginTop: 10 }}>
      {b && <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        <p><strong>Hypothesis:</strong> {b.hypothesis}</p>
        <p><strong>Control:</strong> {b.control?.currentCopy} <span style={{ color: T.muted }}>({b.control?.screenshot_note})</span></p>
        <p><strong>Variant:</strong> {b.variant?.newCopy}</p>
        <ul>{b.variant?.changes?.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>
        <p><strong>Targeting:</strong> {b.variant?.implementation_notes}</p>
        <p><strong>Primary metric:</strong> {b.metrics?.primary} · <strong>Guardrails:</strong> {b.metrics?.guardrails?.join(', ')}</p>
        {b.qaChecklist?.length > 0 && <p><strong>QA:</strong> {b.qaChecklist.join(' · ')}</p>}
      </div>}
      {plan && <p style={{ fontSize: 13, color: plan.feasible ? T.good : T.warn }}>Plan: {plan.note}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0 12px' }}>
        <Field label="Start date"><input type="date" style={inputStyle} value={r.testStartDate} onChange={num('testStartDate')} /></Field>
        <Field label="End date"><input type="date" style={inputStyle} value={r.testEndDate} onChange={num('testEndDate')} /></Field>
        <Field label="Control visitors"><input style={inputStyle} inputMode="numeric" value={r.controlVisitors} onChange={num('controlVisitors')} /></Field>
        <Field label="Control conversions"><input style={inputStyle} inputMode="numeric" value={r.controlConversions} onChange={num('controlConversions')} /></Field>
        <Field label="Variant visitors"><input style={inputStyle} inputMode="numeric" value={r.variantVisitors} onChange={num('variantVisitors')} /></Field>
        <Field label="Variant conversions"><input style={inputStyle} inputMode="numeric" value={r.variantConversions} onChange={num('variantConversions')} /></Field>
      </div>
      <Button onClick={() => onSave({
        testStartDate: r.testStartDate || null, testEndDate: r.testEndDate || null,
        ...(r.controlVisitors !== '' && r.variantVisitors !== '' ? {
          controlVisitors: Number(r.controlVisitors), controlConversions: Number(r.controlConversions || 0),
          variantVisitors: Number(r.variantVisitors), variantConversions: Number(r.variantConversions || 0)
        } : {})
      })}>Save &amp; calculate significance</Button>
      <h4 style={{ margin: '18px 0 8px', color: T.muted }}>Pull results from GA4</h4>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 12px' }}>
        <Field label="GA4 dimension"><input style={inputStyle} value={r.ga4Dimension} onChange={num('ga4Dimension')} /></Field>
        <Field label="Control value"><input style={inputStyle} value={r.ga4ControlValue} onChange={num('ga4ControlValue')} /></Field>
        <Field label="Variant value"><input style={inputStyle} value={r.ga4VariantValue} onChange={num('ga4VariantValue')} /></Field>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button kind="ghost" onClick={() => onSave({ ga4Dimension: r.ga4Dimension, ga4ControlValue: r.ga4ControlValue, ga4VariantValue: r.ga4VariantValue })}>Save GA4 mapping</Button>
        <Button kind="ghost" onClick={onSync}>Sync from GA4</Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Reports
function Reports({ clientId }: { clientId: string }) {
  const [period, setPeriod] = useState(lastMonth())
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [link, setLink] = useState('')
  const [error, setError] = useState('')

  const preview = useCallback(async () => {
    setLoading(true); setError('')
    try { setData(await api(`/api/reports/${clientId}?period=${period}`)) } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
    finally { setLoading(false) }
  }, [clientId, period])
  useEffect(() => { preview() }, [preview])

  async function share() {
    const r = await api(`/api/reports/${clientId}`, { method: 'POST', json: { period } })
    setLink(r.url)
    preview()
  }

  const r = data?.report
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
        <Field label="Report month"><input type="month" style={{ ...inputStyle, width: 180 }} value={period} onChange={e => setPeriod(e.target.value)} /></Field>
        <div style={{ marginBottom: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button onClick={share}>Create client link</Button>
          <a href={`/api/reports/${clientId}/pdf?period=${period}`}><Button kind="ghost">Download PDF</Button></a>
        </div>
      </div>
      {link && <div style={{ background: T.panel2, padding: 12, borderRadius: 8, marginBottom: 12, wordBreak: 'break-all' }}>Share with the client: <a href={link} target="_blank" rel="noreferrer" style={{ color: T.gold }}>{link}</a></div>}
      {data?.shares?.length > 0 && <div style={{ fontSize: 13, color: T.muted, marginBottom: 12 }}>
        Active links for this month: {data.shares.map((s: any) => (
          <span key={s.token} style={{ marginRight: 12 }}>
            <a href={`/report/${s.token}`} target="_blank" rel="noreferrer" style={{ color: T.gold }}>open</a>{' '}
            <button style={{ background: 'none', border: 'none', color: T.bad, cursor: 'pointer', fontFamily: 'inherit' }} onClick={async () => { await api(`/api/reports/${clientId}?token=${s.token}`, { method: 'DELETE' }); preview() }}>revoke</button>
          </span>))}
      </div>}
      {error && <div style={{ color: T.bad }}>{error}</div>}
      {loading ? <p style={{ color: T.muted }}>Building report…</p> : r && (
        <div style={{ fontSize: 14 }}>
          <p><strong>{r.periodLabel}</strong> — {r.pages.length} page(s) audited, {r.changes.length} change(s), {r.tests.length} test(s).</p>
          <p>Conversion rate: {r.kpis.conversionRate.current ?? '—'}% (prev {r.kpis.conversionRate.previous ?? '—'}%) · Conversions: {fmt(r.kpis.conversions.current)} · Avg Fischer Score: {r.kpis.avgFischerScore.current ?? '—'}</p>
          {r.dataNotes.length > 0 && <ul style={{ color: T.warn, fontSize: 13 }}>{r.dataNotes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Settings
function Settings({ client, reload }: { client: any; reload: () => void }) {
  const [test, setTest] = useState<any>(null)
  const [testing, setTesting] = useState(false)
  return (
    <>
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Connections</h3>
          <Button kind="ghost" disabled={testing} onClick={async () => { setTesting(true); try { setTest(await api(`/api/clients/${client.id}/test-integrations`, { method: 'POST' })) } finally { setTesting(false) } }}>{testing ? 'Testing…' : 'Test connections'}</Button>
        </div>
        {test && (['ga4', 'clarity'] as const).map(k => (
          <div key={k} style={{ fontSize: 13, marginTop: 10 }}>
            <strong>{k === 'ga4' ? 'GA4' : 'Clarity'}:</strong>{' '}
            {test[k].ok ? <span style={{ color: T.good }}>connected {k === 'ga4' ? `— ${fmt(test[k].sessionsLast7Days)} sessions, ${fmt(test[k].conversionsLast7Days)} conversions in 7 days` : `— ${fmt(test[k].sessions)} sessions yesterday across ${test[k].pages} pages`}</span> : <span style={{ color: T.bad }}>{test[k].error}</span>}
            {test[k].warning && <div style={{ color: T.warn }}>{test[k].warning}</div>}
            {k === 'ga4' && test.ga4.events && <div style={{ color: T.muted, marginTop: 4 }}>Key events (30d): {test.ga4.events.filter((e: any) => e.isKeyEvent).map((e: any) => `${e.name} (${fmt(e.count)})`).join(', ') || <span style={{ color: T.bad }}>none — conversion rates will be 0</span>}<br />All events: {test.ga4.events.slice(0, 20).map((e: any) => e.name).join(', ')}</div>}
          </div>
        ))}
      </div>
      <TrackingKit client={client} />
      <div style={cardStyle}>
        <ClientForm initial={toFormValues(client)} submitLabel="Save changes" onSubmit={async v => { await api('/api/clients', { method: 'PATCH', json: { id: client.id, ...v } }); reload() }} />
      </div>
    </>
  )
}
