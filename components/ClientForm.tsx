'use client'
import { useState } from 'react'
import { Button, Field, inputStyle, T } from './ui'

export interface ClientFormValues {
  name: string; primaryUrl: string; tier: string; industry: string; currency: string; avgOrderValue: string
  ga4PropertyId: string; ga4ConversionEvent: string; clarityProjectId: string; clarityApiToken: string
  reportLogoUrl: string; reportContactName: string; reportContactEmail: string
  autoTrackLeaks: boolean
}

export function toFormValues(c: any): ClientFormValues {
  return {
    name: c?.name ?? '', primaryUrl: c?.primary_url ?? '', tier: c?.tier ?? 'B', industry: c?.industry ?? '',
    currency: c?.currency ?? 'ZAR', avgOrderValue: c?.avg_order_value != null ? String(c.avg_order_value) : '',
    ga4PropertyId: c?.ga4_property_id ?? '', ga4ConversionEvent: c?.ga4_conversion_event ?? '',
    clarityProjectId: c?.clarity_project_id ?? '', clarityApiToken: c?.clarity_api_token ?? '',
    reportLogoUrl: c?.report_logo_url ?? '', reportContactName: c?.report_contact_name ?? '', reportContactEmail: c?.report_contact_email ?? '',
    autoTrackLeaks: !!c?.auto_track_leaks
  }
}

export function ClientForm({ initial, onSubmit, submitLabel }: { initial?: ClientFormValues; onSubmit: (v: any) => Promise<void>; submitLabel: string }) {
  const [v, setV] = useState<ClientFormValues>(initial ?? toFormValues(null))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = (k: keyof ClientFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await onSubmit({ ...v, avgOrderValue: v.avgOrderValue ? Number(v.avgOrderValue) : null, ga4PropertyId: v.ga4PropertyId.replace(/^properties\//, '').trim() || null })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.')
    } finally { setSaving(false) }
  }

  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 16px' }
  return (
    <form onSubmit={submit}>
      <div style={grid}>
        <Field label="Client name *"><input required style={inputStyle} value={v.name} onChange={set('name')} /></Field>
        <Field label="Website"><input style={inputStyle} value={v.primaryUrl} onChange={set('primaryUrl')} placeholder="https://…" /></Field>
        <Field label="Industry"><input style={inputStyle} value={v.industry} onChange={set('industry')} placeholder="e.g. Automotive" /></Field>
        <Field label="Tier"><select style={inputStyle} value={v.tier} onChange={set('tier')}><option>A</option><option>B</option><option>C</option></select></Field>
        <Field label="Currency"><input style={inputStyle} value={v.currency} onChange={set('currency')} /></Field>
        <Field label="Value per conversion"><input style={inputStyle} value={v.avgOrderValue} onChange={set('avgOrderValue')} placeholder="Avg order or lead value" inputMode="decimal" /></Field>
      </div>
      <h4 style={{ margin: '8px 0 10px', color: T.muted }}>Google Analytics 4</h4>
      <div style={grid}>
        <Field label="GA4 property ID"><input style={inputStyle} value={v.ga4PropertyId} onChange={set('ga4PropertyId')} placeholder="123456789" /></Field>
        <Field label="Conversion event (optional)"><input style={inputStyle} value={v.ga4ConversionEvent} onChange={set('ga4ConversionEvent')} placeholder="e.g. generate_lead or purchase" /></Field>
      </div>
      <p style={{ fontSize: 12, color: T.muted, marginTop: -6 }}>Ask the client to add the Fischer service account email as a <strong>Viewer</strong> in GA4 → Admin → Property access management. Leave the event blank to count all key events.</p>
      <h4 style={{ margin: '8px 0 10px', color: T.muted }}>Microsoft Clarity</h4>
      <div style={grid}>
        <Field label="Clarity project ID"><input style={inputStyle} value={v.clarityProjectId} onChange={set('clarityProjectId')} /></Field>
        <Field label="Clarity API token"><input style={inputStyle} value={v.clarityApiToken} onChange={set('clarityApiToken')} placeholder="Settings → Data Export → Generate token" /></Field>
      </div>
      <h4 style={{ margin: '8px 0 10px', color: T.muted }}>Client report</h4>
      <div style={grid}>
        <Field label="Logo URL"><input style={inputStyle} value={v.reportLogoUrl} onChange={set('reportLogoUrl')} placeholder="https://…/logo.png" /></Field>
        <Field label="Account manager"><input style={inputStyle} value={v.reportContactName} onChange={set('reportContactName')} /></Field>
        <Field label="Account manager email"><input style={inputStyle} value={v.reportContactEmail} onChange={set('reportContactEmail')} type="email" /></Field>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={v.autoTrackLeaks} onChange={e => setV({ ...v, autoTrackLeaks: e.target.checked })} />
        Automatically track the top 3 leaking pages each month (requires GA4 and a website URL)
      </label>
      {error && <div style={{ color: T.bad, marginBottom: 10 }}>{error}</div>}
      <Button type="submit" disabled={saving}>{saving ? 'Saving…' : submitLabel}</Button>
    </form>
  )
}
