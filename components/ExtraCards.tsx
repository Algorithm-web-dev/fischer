'use client'
import { useCallback, useEffect, useState } from 'react'
import { Button, Field, Pill, inputStyle, cardStyle, labelStyle, T, api } from '@/components/ui'

// ---------------------------------------------------------------- Admin: branding
export function BrandingSettings() {
  const [b, setB] = useState<any>(null)
  const [emailOk, setEmailOk] = useState(false)
  const [msg, setMsg] = useState('')
  useEffect(() => { api('/api/settings').then(d => { setB(d.branding); setEmailOk(d.emailConfigured) }).catch(() => {}) }, [])
  if (!b) return null
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setB({ ...b, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  return (
    <div style={cardStyle}>
      <h3 style={{ marginTop: 0 }}>Branding &amp; report emails</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 14px' }}>
        <Field label="Agency name"><input style={inputStyle} value={b.agencyName} onChange={set('agencyName')} /></Field>
        <Field label="Logo URL (https)"><input style={inputStyle} value={b.logoUrl ?? ''} onChange={set('logoUrl')} /></Field>
        <Field label="Primary colour"><input style={inputStyle} value={b.primaryColor} onChange={set('primaryColor')} placeholder="#0B1F3A" /></Field>
        <Field label="Accent colour"><input style={inputStyle} value={b.accentColor} onChange={set('accentColor')} placeholder="#C98A00" /></Field>
        <Field label="Report footer text"><input style={inputStyle} value={b.footer ?? ''} onChange={set('footer')} placeholder="e.g. www.algorithm.agency · 021 000 0000" /></Field>
        <Field label="Email From (verified in Resend)"><input style={inputStyle} value={b.emailFrom ?? ''} onChange={set('emailFrom')} placeholder="Reports <reports@yourdomain>" /></Field>
        <Field label="Email reply-to"><input style={inputStyle} value={b.emailReplyTo ?? ''} onChange={set('emailReplyTo')} /></Field>
      </div>
      <label style={{ display: 'flex', gap: 8, fontSize: 13, marginBottom: 12 }}><input type="checkbox" checked={b.showFischerName} onChange={set('showFischerName')} /> Show “with Fischer” on reports</label>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', gap: 6 }}>{[b.primaryColor, b.accentColor].map((c: string) => <span key={c} style={{ width: 22, height: 22, borderRadius: 4, background: c, border: `1px solid ${T.line}` }} />)}</span>
        <Button onClick={async () => { try { const r = await api('/api/settings', { method: 'PATCH', json: b }); setB(r.branding); setMsg('Saved.') } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed') } }}>Save</Button>
        {msg && <span style={{ fontSize: 13, color: msg === 'Saved.' ? T.good : T.bad }}>{msg}</span>}
        {!emailOk && <span style={{ fontSize: 12, color: T.warn }}>Report emails need RESEND_API_KEY on the server.</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Reports tab: emails
export function ReportEmails({ client, period }: { client: any; period: string }) {
  const [v, setV] = useState({ recipients: (client.report_recipients ?? []).join(', '), enabled: !!client.report_email_enabled, day: client.report_email_day ?? 5 })
  const [history, setHistory] = useState<any[]>([])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => api(`/api/reports/${client.id}/email`).then(d => setHistory(d.emails)).catch(() => {}), [client.id])
  useEffect(() => { load() }, [load])
  return (
    <div style={cardStyle}>
      <h3 style={{ marginTop: 0 }}>Email the report</h3>
      <p style={{ fontSize: 13, color: T.muted, marginTop: -6 }}>A short summary with the headline numbers and a link to the full report (link valid 60 days). Sent automatically each month on the chosen day when switched on.</p>
      <Field label="Recipients (comma separated)"><input style={inputStyle} value={v.recipients} onChange={e => setV({ ...v, recipients: e.target.value })} placeholder="marketing@client.co.za, ceo@client.co.za" /></Field>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ display: 'flex', gap: 8, fontSize: 13 }}><input type="checkbox" checked={v.enabled} onChange={e => setV({ ...v, enabled: e.target.checked })} /> Send automatically every month on day</label>
        <input style={{ ...inputStyle, width: 70 }} type="number" min={1} max={28} value={v.day} onChange={e => setV({ ...v, day: Number(e.target.value) })} />
        <Button kind="ghost" onClick={async () => { try { await api('/api/clients', { method: 'PATCH', json: { id: client.id, reportRecipients: v.recipients, reportEmailEnabled: v.enabled, reportEmailDay: v.day } }); setMsg('Saved.') } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed') } }}>Save</Button>
        <Button disabled={busy} onClick={async () => {
          if (!confirm(`Email the ${period} report to ${v.recipients}?`)) return
          setBusy(true); setMsg('')
          try { const r = await api(`/api/reports/${client.id}/email`, { method: 'POST', json: { period, recipients: v.recipients.split(/[,;\s]+/).filter(Boolean) } }); setMsg(`Sent to ${r.sentTo.join(', ')}.`); load() }
          catch (e) { setMsg(e instanceof Error ? e.message : 'Failed') } finally { setBusy(false) }
        }}>{busy ? 'Sending…' : `Send ${period} report now`}</Button>
      </div>
      {msg && <div style={{ fontSize: 13, color: /Saved|Sent/.test(msg) ? T.good : T.bad }}>{msg}</div>}
      {history.length > 0 && <div style={{ fontSize: 12, color: T.muted, marginTop: 8 }}>{history.slice(0, 6).map((h, i) => <div key={i}>{h.created_at.slice(0, 10)} · {String(h.period).slice(0, 7)} · {h.status}{h.error ? ` (${h.error.slice(0, 80)})` : ''} · {h.recipients.join(', ')}</div>)}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- Pages tab: discovery
const KIND_LABEL: Record<string, string> = { lead_form: 'Contact / lead form', quote: 'Quote', booking: 'Booking', checkout: 'Checkout', cart: 'Cart', product: 'Product', category: 'Category', pricing: 'Pricing', signup: 'Sign-up / demo', home: 'Home', landing: 'Landing page', content: 'Content', other: 'Other' }
export function SiteDiscovery({ client, onTrack }: { client: any; onTrack: () => void }) {
  const [scan, setScan] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { api(`/api/clients/${client.id}/discover`).then(d => setScan(d.scan)).catch(() => {}) }, [client.id])
  const r = scan?.result
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Discover pages</h3>
        <Button kind="ghost" disabled={busy || !client.primary_url} onClick={async () => {
          setBusy(true); setError('')
          try { setScan((await api(`/api/clients/${client.id}/discover`, { method: 'POST' })).scan) } catch (e) { setError(e instanceof Error ? e.message : 'Failed') } finally { setBusy(false) }
        }}>{busy ? 'Scanning site…' : r ? 'Rescan' : 'Scan site'}</Button>
      </div>
      <p style={{ fontSize: 13, color: T.muted, margin: '6px 0' }}>Reads the sitemap, finds forms, quote/booking/contact, product, cart and checkout pages, and checks for broken pages.{!client.primary_url && ' Set the client website in Settings first.'}</p>
      {error && <div style={{ color: T.bad, fontSize: 13 }}>{error}</div>}
      {r && (
        <>
          <div style={{ fontSize: 12, color: T.muted, marginBottom: 8 }}>{r.urlsFound} URLs from the {r.source === 'sitemap' ? 'sitemap' : 'homepage links (no sitemap found)'} · scanned {scan.created_at.slice(0, 10)} · {Object.entries(r.byKind).map(([k, n]) => `${KIND_LABEL[k] ?? k} ${n}`).join(' · ')}</div>
          {r.pages.filter((p: any) => p.kind !== 'content').map((p: any) => (
            <div key={p.url} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: `1px solid ${T.line}`, flexWrap: 'wrap', fontSize: 13 }}>
              <Pill>{KIND_LABEL[p.kind] ?? p.kind}</Pill>
              <span style={{ flex: '1 1 260px', wordBreak: 'break-all' }}>{p.url}</span>
              {p.hasForm && <Pill color={T.gold}>form · {p.formFields} fields</Pill>}
              {p.status != null && p.status >= 400 ? <Pill color={T.bad}>{p.status}</Pill> : <Button kind="ghost" onClick={async () => {
                await api('/api/tracked-pages', { method: 'POST', json: { clientId: client.id, pageUrl: p.url, pageType: p.kind === 'product' ? 'Product Page' : p.kind === 'checkout' || p.kind === 'cart' ? 'Checkout' : p.kind === 'pricing' ? 'Pricing Page' : p.hasForm ? 'Contact / Lead Form' : p.kind === 'home' ? 'Home Page' : 'Landing Page', businessGoal: ['checkout', 'cart', 'product', 'category'].includes(p.kind) ? 'E-commerce Sales' : 'Lead Generation' } })
                onTrack()
              }}>Track</Button>}
            </div>))}
          {r.broken.length > 0 && <div style={{ marginTop: 10, fontSize: 13 }}><strong style={{ color: T.bad }}>Broken pages ({r.broken.length}):</strong> {r.broken.slice(0, 10).map((b: any) => `${b.url} (${b.status ?? 'no response'})`).join(' · ')}</div>}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Audit view
export function A11yCard({ a }: { a: any }) {
  if (!a) return null
  const imp: Record<string, string> = { critical: T.bad, serious: T.warn, moderate: '#FFD700', minor: T.muted }
  return (
    <div style={cardStyle}>
      <div style={labelStyle}>Accessibility (WCAG 2.1 AA, desktop) — {a.violations.length === 0 ? 'no violations' : `${a.counts.critical} critical · ${a.counts.serious} serious · ${a.counts.moderate} moderate`}</div>
      {a.violations.slice(0, 10).map((v: any) => (
        <div key={v.id} style={{ fontSize: 13, padding: '4px 0', borderTop: `1px solid ${T.line}` }}>
          <Pill color={imp[v.impact] ?? T.muted}>{v.impact ?? 'n/a'}</Pill> {v.help} <span style={{ color: T.muted }}>({v.nodes} element{v.nodes === 1 ? '' : 's'}{v.examples[0] ? `, e.g. ${v.examples[0]}` : ''})</span> <a href={v.helpUrl} target="_blank" rel="noreferrer" style={{ color: T.gold }}>how to fix</a>
        </div>))}
    </div>
  )
}

/**
 * Links into Clarity for a page. Clarity's API doesn't expose recordings, so
 * these open the project's recordings and heatmaps; filter by the page URL
 * there (copied with the button).
 */
export function ClarityLinks({ projectId, pageUrl }: { projectId: string | null | undefined; pageUrl: string }) {
  if (!projectId) return null
  const base = `https://clarity.microsoft.com/projects/view/${encodeURIComponent(projectId)}`
  const link = { color: T.gold, fontSize: 13 }
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
      <span style={{ color: T.muted }}>Clarity:</span>
      <a style={link} href={`${base}/impressions`} target="_blank" rel="noreferrer">Recordings</a>
      <a style={link} href={`${base}/heatmaps`} target="_blank" rel="noreferrer">Heatmaps</a>
      <a style={link} href={`${base}/dashboard`} target="_blank" rel="noreferrer">Dashboard</a>
      <button onClick={() => navigator.clipboard.writeText(pageUrl)} style={{ background: 'none', border: `1px solid ${T.line}`, color: T.muted, borderRadius: 6, padding: '2px 8px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>Copy page URL to filter</button>
    </div>
  )
}
