'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Page, Button, Field, Pill, inputStyle, cardStyle, labelStyle, T, api, scoreColor } from '@/components/ui'
import type { AuditResult, FrictionPoint } from '@/lib/claude'

const SEV = { high: T.bad, medium: T.warn, low: '#FFD700' }
const STATUS: Record<string, string> = { resolved: T.good, improved: T.good, still_present: T.warn, worse: T.bad, cannot_verify: T.muted }

const fileToBase64 = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f)
})

export default function AuditPage() {
  const [viewId, setViewId] = useState<string | null>(null)
  useEffect(() => { setViewId(new URLSearchParams(window.location.search).get('view')) }, [])
  return viewId ? <AuditView id={viewId} /> : <RunAudit onDone={id => { window.history.pushState({}, '', `/audit?view=${id}`); setViewId(id) }} />
}

// ------------------------------------------------------------------ Run
function RunAudit({ onDone }: { onDone: (id: string) => void }) {
  const [clients, setClients] = useState<any[]>([])
  const [form, setForm] = useState({
    clientId: '', clientName: '', pageUrl: '', pageType: 'Landing Page', businessGoal: 'Lead Generation',
    monthlyTraffic: '', currentConversionRate: '', avgOrderValue: '', additionalContext: ''
  })
  const [manual, setManual] = useState<{ auditId: string; needsManualHtml: boolean; needsManualDesktop: boolean; needsManualMobile: boolean; reasons: Record<string, string> } | null>(null)
  const [manualHtml, setManualHtml] = useState('')
  const [manualDesktop, setManualDesktop] = useState<string | null>(null)
  const [manualMobile, setManualMobile] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { api('/api/clients').then(d => setClients(d.clients)).catch(() => {}) }, [])
  const client = clients.find(c => c.id === form.clientId)
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value })

  async function run() {
    setRunning(true); setError('')
    try {
      const body: any = { ...form, clientId: form.clientId || undefined }
      if (manual) {
        body.auditId = manual.auditId
        if (manualHtml) body.manualHtml = manualHtml
        if (manualDesktop) body.manualScreenshotDesktop = manualDesktop
        if (manualMobile) body.manualScreenshotMobile = manualMobile
      }
      const r = await api('/api/audit', { method: 'POST', json: body })
      if (r.status === 'needs_manual_input') setManual(r)
      else onDone(r.auditId)
    } catch (e) { setError(e instanceof Error ? e.message : 'Audit failed') }
    finally { setRunning(false) }
  }

  const ready = form.pageUrl && (form.clientId || form.clientName)
  return (
    <Page title="Run an audit">
      <div style={{ ...cardStyle, maxWidth: 760 }}>
        <Field label="Client">
          <select style={inputStyle} value={form.clientId} onChange={set('clientId')}>
            <option value="">— One-off (not saved to a client) —</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.name}{c.integrations.ga4 ? ' · GA4' : ''}{c.integrations.clarity ? ' · Clarity' : ''}</option>)}
          </select>
        </Field>
        {!form.clientId && <Field label="Client name"><input style={inputStyle} value={form.clientName} onChange={set('clientName')} /></Field>}
        <Field label="Page URL"><input style={inputStyle} value={form.pageUrl} onChange={set('pageUrl')} placeholder="https://…" /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Page type"><select style={inputStyle} value={form.pageType} onChange={set('pageType')}>{['Landing Page', 'Home Page', 'Product Page', 'Category Page', 'Checkout', 'Pricing Page', 'Contact / Lead Form', 'Blog / Content'].map(o => <option key={o}>{o}</option>)}</select></Field>
          <Field label="Goal"><select style={inputStyle} value={form.businessGoal} onChange={set('businessGoal')}>{['Lead Generation', 'E-commerce Sales', 'Bookings', 'Sign-ups', 'Calls', 'Quote Requests'].map(o => <option key={o}>{o}</option>)}</select></Field>
        </div>
        {!client?.integrations?.ga4 && (
          <>
            <p style={{ fontSize: 12, color: T.muted }}>No GA4 connected{form.clientId ? ' for this client' : ''} — add figures manually for revenue estimates and test planning (optional).</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <Field label="Monthly sessions"><input style={inputStyle} value={form.monthlyTraffic} onChange={set('monthlyTraffic')} inputMode="numeric" /></Field>
              <Field label="Conversion rate %"><input style={inputStyle} value={form.currentConversionRate} onChange={set('currentConversionRate')} inputMode="decimal" /></Field>
              <Field label="Value per conversion"><input style={inputStyle} value={form.avgOrderValue} onChange={set('avgOrderValue')} inputMode="decimal" /></Field>
            </div>
          </>
        )}
        <Field label="Context for Fischer (optional)"><textarea style={{ ...inputStyle, minHeight: 70 }} value={form.additionalContext} onChange={set('additionalContext')} placeholder="Campaign landing page for Google Ads; main KPI is test-drive bookings…" /></Field>

        {manual && (
          <div style={{ border: `1px solid ${T.warn}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
            <strong style={{ color: T.warn }}>Fischer couldn&apos;t capture everything automatically</strong>
            <p style={{ fontSize: 13, color: T.muted }}>Nothing has been charged yet. Supply only the missing piece(s) and run again.</p>
            {manual.needsManualHtml && <Field label={`Page HTML — ${manual.reasons.html}`}><textarea style={{ ...inputStyle, minHeight: 90 }} value={manualHtml} onChange={e => setManualHtml(e.target.value)} placeholder="DevTools → Elements → right-click <html> → Copy outerHTML" /></Field>}
            {manual.needsManualDesktop && <Field label={`Desktop screenshot — ${manual.reasons.desktop}`}><input type="file" accept="image/jpeg,image/png" onChange={async e => e.target.files?.[0] && setManualDesktop(await fileToBase64(e.target.files[0]))} /></Field>}
            {manual.needsManualMobile && <Field label={`Mobile screenshot — ${manual.reasons.mobile}`}><input type="file" accept="image/jpeg,image/png" onChange={async e => e.target.files?.[0] && setManualMobile(await fileToBase64(e.target.files[0]))} /></Field>}
          </div>
        )}
        {error && <div style={{ color: T.bad, marginBottom: 10 }}>{error}</div>}
        <Button onClick={run} disabled={!ready || running}>{running ? 'Auditing… (1–4 min)' : manual ? 'Resume audit' : 'Run Fischer audit'}</Button>
        {running && <p style={{ fontSize: 12, color: T.muted }}>Loading the page in a real browser, capturing it top to bottom on desktop and mobile, pulling PageSpeed/GA4/Clarity, then analysing.</p>}
      </div>
    </Page>
  )
}

// ------------------------------------------------------------------ View
function AuditView({ id }: { id: string }) {
  const [audit, setAudit] = useState<any>(null)
  const [error, setError] = useState('')
  const [shotView, setShotView] = useState<'desktop' | 'mobile'>('desktop')
  const [showUnverified, setShowUnverified] = useState(false)
  const [briefBusy, setBriefBusy] = useState<number | null>(null)
  const [promoted, setPromoted] = useState(false)

  useEffect(() => { api(`/api/audits/${id}`).then(d => setAudit(d.audit)).catch(e => setError(e.message)) }, [id])

  if (error) return <Page title="Audit"><p style={{ color: T.bad }}>{error}</p></Page>
  if (!audit) return <Page title="Audit"><p style={{ color: T.muted }}>Loading…</p></Page>
  if (audit.status !== 'complete') {
    return <Page title="Audit"><div style={cardStyle}><Pill color={T.warn}>{audit.status}</Pill><p>{audit.error_message || 'This audit has not completed.'}</p><Link href="/audit" style={{ color: T.gold }}>Run a new audit</Link></div></Page>
  }

  const r = audit.output as AuditResult
  const shots = audit.screenshots?.[shotView] ?? []
  const ds = audit.capture_metadata ?? {}
  const money = (n: number) => `${r.revenueImpact.currency === 'ZAR' ? 'R' : r.revenueImpact.currency + ' '}${Math.round(n).toLocaleString('en-ZA')}`

  async function createBrief(i: number) {
    setBriefBusy(i)
    try { await api('/api/test-brief', { method: 'POST', json: { auditId: id, hypothesisIndex: i } }); alert('Test brief created — see the client’s A/B tests tab.') }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed') }
    finally { setBriefBusy(null) }
  }

  return (
    <Page title={audit.client_name} actions={<div style={{ display: 'flex', gap: 8 }}>
      {audit.client_id && <Link href={`/clients/${audit.client_id}`}><Button kind="ghost">Client dashboard</Button></Link>}
      <Link href="/audit"><Button kind="ghost">New audit</Button></Link>
    </div>}>
      <div style={{ color: T.muted, marginTop: -10, marginBottom: 16, wordBreak: 'break-all' }}>{audit.page_url} · {audit.completed_at.slice(0, 16).replace('T', ' ')} {audit.trigger === 'scheduled' && <Pill>scheduled</Pill>}</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 18 }}>
        <div style={cardStyle}>
          <div style={labelStyle}>Fischer Score</div>
          <div style={{ fontSize: 56, fontWeight: 700, color: scoreColor(r.fischerScore), lineHeight: 1 }}>{r.fischerScore}<span style={{ fontSize: 20, color: T.muted }}>/100</span></div>
          {r.scoreBreakdown && <div style={{ marginTop: 14 }}>{Object.entries(r.scoreBreakdown).map(([k, v]) => (
            <div key={k} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: T.muted }}><span>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span><span>{v}</span></div>
              <div style={{ height: 5, background: T.line, borderRadius: 3 }}><div style={{ width: `${v}%`, height: 5, borderRadius: 3, background: scoreColor(v) }} /></div>
            </div>))}</div>}
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>Summary</div>
          <p style={{ lineHeight: 1.6, marginTop: 0 }}>{r.summary}</p>
          <p style={{ fontSize: 13, color: T.muted }}>{r.confidenceNote}</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Pill color={T.good}>Screens: {ds.screenshots?.desktop ?? 0} desktop / {ds.screenshots?.mobile ?? 0} mobile</Pill>
            <Pill color={String(ds.pagespeed).startsWith('success') ? T.good : T.muted}>PageSpeed</Pill>
            <Pill color={String(ds.ga4).startsWith('live') ? T.good : T.muted}>GA4 {String(ds.ga4).startsWith('live') ? 'live' : 'off'}</Pill>
            <Pill color={String(ds.clarity).match(/^(live|stored)/) ? T.good : T.muted}>Clarity {String(ds.clarity).match(/^(live|stored)/) ? 'on' : 'off'}</Pill>
          </div>
          {r.dataGaps?.length > 0 && <p style={{ fontSize: 12, color: T.muted }}>Not assessed: {r.dataGaps.join(' · ')}</p>}
        </div>
      </div>

      {audit.tracking && (
        <div style={{ ...cardStyle, borderColor: audit.tracking.healthy ? T.line : T.bad }}>
          <div style={labelStyle}>Tracking check {audit.tracking.healthy ? '— healthy' : '— problems found'}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <Pill color={audit.tracking.detected.ga4Hits ? T.good : T.bad}>GA4 {audit.tracking.detected.ga4MeasurementIds.join(', ') || 'missing'}</Pill>
            <Pill color={audit.tracking.detected.gtmContainers.length ? T.good : T.muted}>GTM {audit.tracking.detected.gtmContainers.join(', ') || 'none'}</Pill>
            <Pill color={audit.tracking.detected.clarityProjectIds.length ? T.good : T.warn}>Clarity {audit.tracking.detected.clarityProjectIds.join(', ') || 'none'}</Pill>
            <Pill color={audit.tracking.detected.analyticsConsent === 'denied' ? T.bad : T.muted}>consent: {audit.tracking.detected.analyticsConsent}</Pill>
            {audit.tracking.detected.metaPixel && <Pill>Meta pixel</Pill>}
            {audit.tracking.detected.googleAdsIds.length > 0 && <Pill>Google Ads</Pill>}
          </div>
          {audit.tracking.issues.map((i: any) => (
            <div key={i.code} style={{ fontSize: 13, padding: '4px 0' }}>
              <Pill color={i.severity === 'high' ? T.bad : i.severity === 'medium' ? T.warn : T.muted}>{i.severity}</Pill> {i.message} <span style={{ color: T.muted }}>— {i.fix}</span>
            </div>))}
          {audit.tracking.events && <div style={{ fontSize: 12, color: T.muted, marginTop: 6 }}>GA4 key events: {audit.tracking.events.filter((e: any) => e.isKeyEvent).map((e: any) => `${e.name} (${e.count})`).join(', ') || 'none'}</div>}
        </div>
      )}

      {audit.page_diff?.changed && (
        <div style={cardStyle}>
          <div style={labelStyle}>Changes since previous audit</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>{audit.page_diff.changes.map((c: any, i: number) => <li key={i}><strong>{c.label}:</strong> {c.before && <span style={{ color: T.muted, textDecoration: 'line-through' }}>{c.before}</span>} {c.after && <span>{c.after}</span>}</li>)}</ul>
        </div>
      )}

      {r.previousIssueFollowUp?.length > 0 && (
        <div style={cardStyle}>
          <div style={labelStyle}>Follow-up on previous audit</div>
          {r.previousIssueFollowUp.map((f, i) => (
            <div key={i} style={{ padding: '6px 0', borderBottom: `1px solid ${T.line}`, fontSize: 14 }}>
              <Pill color={STATUS[f.status]}>{f.status.replace('_', ' ')}</Pill> <strong>{f.previousTitle}</strong>
              <div style={{ color: T.muted, fontSize: 13 }}>{f.evidence}</div>
            </div>))}
        </div>
      )}

      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={labelStyle}>Findings ({r.frictionPoints.length})</div>
          {audit.client_id && <Button kind="ghost" disabled={promoted} onClick={async () => { await api('/api/backlog/from-audit', { method: 'POST', json: { auditId: id, clientId: audit.client_id } }); setPromoted(true) }}>{promoted ? 'Added to backlog' : 'Add all to backlog'}</Button>}
        </div>
        {r.frictionPoints.length === 0 && <p style={{ color: T.muted }}>No evidence-backed problems found.</p>}
        {r.frictionPoints.map((f, i) => <Finding key={i} f={f} />)}
        {r.unverifiedFindings?.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <button onClick={() => setShowUnverified(s => !s)} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
              {showUnverified ? '▾' : '▸'} {r.unverifiedFindings.length} unverified finding(s) — excluded from client reports
            </button>
            {showUnverified && r.unverifiedFindings.map((f, i) => <Finding key={i} f={f} dim />)}
          </div>
        )}
      </div>

      {r.strengths?.length > 0 && (
        <div style={cardStyle}>
          <div style={labelStyle}>Working well — don&apos;t break these</div>
          {r.strengths.map((s, i) => <div key={i} style={{ fontSize: 14, marginBottom: 6 }}><strong style={{ color: T.good }}>{s.title}</strong> <span style={{ color: T.muted }}>— {s.evidence}</span></div>)}
        </div>
      )}

      <div style={cardStyle}>
        <div style={labelStyle}>Screenshots</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {(['desktop', 'mobile'] as const).map(v => <Button key={v} kind={shotView === v ? 'primary' : 'ghost'} onClick={() => setShotView(v)}>{v} ({audit.screenshots?.[v]?.length ?? 0})</Button>)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0, maxHeight: 900, overflowY: 'auto', background: T.panel2, borderRadius: 8 }}>
          {shots.length === 0 ? <p style={{ color: T.muted }}>No screenshots stored.</p> : shots.map((s: any) => (
            <div key={s.index} style={{ position: 'relative', width: shotView === 'mobile' ? 390 : '100%', maxWidth: '100%' }}>
              <span style={{ position: 'absolute', top: 6, left: 6, background: 'rgba(0,0,0,.7)', fontSize: 11, padding: '2px 6px', borderRadius: 4 }}>{shotView} section {s.index + 1}</span>
              <img src={s.url} alt={`${shotView} section ${s.index + 1}`} style={{ width: '100%', display: 'block' }} />
            </div>))}
        </div>
      </div>

      {r.revenueImpact && r.revenueImpact.basis !== 'none' && r.revenueImpact.currentMonthlyRevenue > 0 && (
        <div style={cardStyle}>
          <div style={labelStyle}>Revenue opportunity ({r.revenueImpact.basis === 'ga4' ? 'from live GA4' : 'from manual figures'})</div>
          <p style={{ fontSize: 13, color: T.muted, marginTop: 0 }}>{r.revenueImpact.monthlyTraffic.toLocaleString()} sessions/month × {r.revenueImpact.currentConversionRate}% × {money(r.revenueImpact.valuePerConversion)} = {money(r.revenueImpact.currentMonthlyRevenue)}/month today</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {(['conservative', 'realistic', 'aggressive'] as const).map(k => (
              <div key={k} style={{ background: T.panel2, borderRadius: 8, padding: 12 }}>
                <div style={{ fontSize: 11, color: T.muted, textTransform: 'uppercase' }}>{k} (+{(r.revenueImpact as any)[`${k}LiftPct`]}%)</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: T.gold }}>+{money((r.revenueImpact as any)[`${k}AdditionalRevenue`])}/mo</div>
              </div>))}
          </div>
          <p style={{ fontSize: 13, color: T.muted }}>{r.liftEstimate?.rationale}</p>
          <p style={{ fontSize: 14 }}><strong>Highest priority:</strong> {r.highestPriorityFix} — {r.highestPriorityFixReason}</p>
        </div>
      )}

      <div style={cardStyle}>
        <div style={labelStyle}>A/B test hypotheses</div>
        {r.abTestHypotheses.map((h, i) => (
          <div key={i} style={{ borderTop: i ? `1px solid ${T.line}` : 'none', padding: '12px 0' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Pill color={T.gold}>P{h.priority}</Pill><strong style={{ flex: '1 1 240px' }}>{h.name}</strong>
              <Pill>{h.device}</Pill><Pill>{h.effort} effort</Pill>
              {audit.client_id && <Button kind="ghost" disabled={briefBusy !== null} onClick={() => createBrief(i)}>{briefBusy === i ? 'Creating…' : 'Create test brief'}</Button>}
            </div>
            <p style={{ fontSize: 14, margin: '8px 0' }}>{h.hypothesis}</p>
            <div style={{ fontSize: 13, color: T.muted }}><strong>Control:</strong> {h.control}</div>
            <div style={{ fontSize: 13, color: T.muted }}><strong>Variant:</strong> {h.variant}</div>
            <div style={{ fontSize: 13, color: T.muted }}><strong>Metric:</strong> {h.primaryMetric} · expected +{h.expectedLiftPct}%</div>
            {h.plan && <div style={{ fontSize: 13, color: h.plan.feasible ? T.good : T.warn, marginTop: 4 }}>{h.plan.note}</div>}
          </div>))}
      </div>

      <div style={cardStyle}>
        <div style={labelStyle}>Action plan</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
          {(['thisWeek', 'thisMonth', 'thisQuarter'] as const).map(k => (
            <div key={k}><strong style={{ fontSize: 13 }}>{k === 'thisWeek' ? 'This week' : k === 'thisMonth' ? 'This month' : 'This quarter'}</strong>
              <ul style={{ paddingLeft: 18, fontSize: 14 }}>{r.actionPlan[k].map((a, i) => <li key={i}>{a}</li>)}</ul></div>))}
        </div>
      </div>
    </Page>
  )
}

function Finding({ f, dim }: { f: FrictionPoint; dim?: boolean }) {
  return (
    <div style={{ borderLeft: `3px solid ${SEV[f.severity]}`, padding: '8px 12px', margin: '10px 0', opacity: dim ? 0.65 : 1, background: T.panel2, borderRadius: '0 8px 8px 0' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong>{f.title}</strong><Pill color={SEV[f.severity]}>{f.severity}</Pill><Pill>{f.confidence} confidence</Pill>
        <span style={{ fontSize: 12, color: T.muted }}>{f.location}</span>
      </div>
      <div style={{ fontSize: 13, marginTop: 6 }}><span style={{ color: T.gold }}>Evidence</span> ({f.evidenceSources.join(', ')}): {f.evidence}</div>
      <div style={{ fontSize: 13, color: T.muted, marginTop: 4 }}>{f.issue} {f.whyItKillsConversion}</div>
      <div style={{ fontSize: 14, marginTop: 6 }}><strong>Fix:</strong> {f.fix}</div>
      {f.validationNote && <div style={{ fontSize: 12, color: T.warn, marginTop: 4 }}>{f.validationNote}</div>}
    </div>
  )
}
