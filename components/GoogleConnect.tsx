'use client'
import { useCallback, useEffect, useState } from 'react'
import { Button, Field, Pill, inputStyle, cardStyle, T, api } from '@/components/ui'

/** Client Settings: one-click Google connection and pickers for GA4 / Search Console / Ads. */
export function GoogleConnect({ client, onChange }: { client: any; onChange: () => void }) {
  const [d, setD] = useState<any>(null)
  const [sel, setSel] = useState({ ga4PropertyId: '', gscSiteUrl: '', googleAdsCustomerId: '', googleAdsLoginCustomerId: '' })
  const [msg, setMsg] = useState('')
  const load = useCallback(() => api(`/api/clients/${client.id}/google`).then(r => {
    setD(r)
    setSel({ ga4PropertyId: r.status.ga4PropertyId ?? '', gscSiteUrl: r.status.gscSiteUrl ?? '', googleAdsCustomerId: r.status.googleAdsCustomerId ?? '', googleAdsLoginCustomerId: r.status.googleAdsLoginCustomerId ?? '' })
  }).catch(() => {}), [client.id])
  useEffect(() => {
    load()
    const g = new URLSearchParams(window.location.search).get('google')
    if (g) setMsg(g === 'connected' ? 'Google connected — now pick the property, site and ad account below.' : `Google connection did not complete (${g.replace(/_/g, ' ')}).`)
  }, [load])

  if (!d) return null
  const s = d.status, a = d.assets
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Google (GA4 · Search Console · Ads)</h3>
        {s.connected ? <Pill color={T.good}>connected{s.email ? ` as ${s.email}` : ''}</Pill> : <Pill>not connected</Pill>}
      </div>
      {msg && <div style={{ fontSize: 13, color: msg.startsWith('Google connected') ? T.good : T.warn, marginTop: 8 }}>{msg}</div>}
      {!s.configured ? (
        <p style={{ fontSize: 13, color: T.muted }}>One-click Google sign-in isn&apos;t set up on this Fischer install (GOOGLE_OAUTH_CLIENT_ID / SECRET). GA4 still works through the service account — see the GA4 fields below.</p>
      ) : !s.connected ? (
        <>
          <p style={{ fontSize: 13, color: T.muted }}>Sign in with a Google account that has access to the client&apos;s GA4, Search Console and Google Ads. Fischer gets read-only access; no one needs to add a service account in GA4.</p>
          <a href={`/api/google/connect?clientId=${client.id}`}><Button>Connect Google</Button></a>
        </>
      ) : (
        <>
          {d.error && <div style={{ color: T.bad, fontSize: 13, marginTop: 8 }}>{d.error}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0 14px', marginTop: 12 }}>
            <Field label="GA4 property">
              <select style={inputStyle} value={sel.ga4PropertyId} onChange={e => setSel({ ...sel, ga4PropertyId: e.target.value })}>
                <option value="">— none —</option>
                {(a?.ga4 ?? []).map((p: any) => <option key={p.property} value={p.property}>{p.displayName} ({p.account}) · {p.property}</option>)}
              </select>
            </Field>
            <Field label="Search Console site">
              <select style={inputStyle} value={sel.gscSiteUrl} onChange={e => setSel({ ...sel, gscSiteUrl: e.target.value })}>
                <option value="">— none —</option>
                {(a?.searchConsole ?? []).map((x: any) => <option key={x.siteUrl} value={x.siteUrl}>{x.siteUrl}</option>)}
              </select>
            </Field>
            <Field label="Google Ads account">
              {a?.ads?.length ? (
                <select style={inputStyle} value={sel.googleAdsCustomerId} onChange={e => setSel({ ...sel, googleAdsCustomerId: e.target.value })}>
                  <option value="">— none —</option>
                  {a.ads.map((x: any) => <option key={x.customerId} value={x.customerId}>{x.customerId}</option>)}
                </select>
              ) : <input style={inputStyle} placeholder="123-456-7890" value={sel.googleAdsCustomerId} onChange={e => setSel({ ...sel, googleAdsCustomerId: e.target.value })} />}
            </Field>
            <Field label="Ads manager (MCC) id, if any"><input style={inputStyle} placeholder="optional" value={sel.googleAdsLoginCustomerId} onChange={e => setSel({ ...sel, googleAdsLoginCustomerId: e.target.value })} /></Field>
          </div>
          {a?.errors?.length > 0 && <div style={{ fontSize: 12, color: T.muted, marginBottom: 8 }}>{a.errors.join(' · ')}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={async () => { await api(`/api/clients/${client.id}/google`, { method: 'PATCH', json: sel }); setMsg('Saved.'); onChange() }}>Save selection</Button>
            <Button kind="danger" onClick={async () => { if (confirm('Disconnect Google for this client?')) { await api(`/api/clients/${client.id}/google`, { method: 'DELETE' }); load(); onChange() } }}>Disconnect</Button>
          </div>
        </>
      )}
    </div>
  )
}
