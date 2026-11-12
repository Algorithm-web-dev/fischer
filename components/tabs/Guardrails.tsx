'use client'
import { useCallback, useEffect, useState } from 'react'
import { Button, Field, Pill, inputStyle, cardStyle, T, api } from '@/components/ui'

const PRESETS = [
  { metricName: 'Sessions', ga4Metric: 'sessions', thresholdType: 'max_drop_pct', thresholdValue: 20 },
  { metricName: 'Conversions', ga4Metric: 'keyEvents', thresholdType: 'max_drop_pct', thresholdValue: 15 },
  { metricName: 'Conversion rate', ga4Metric: 'sessionKeyEventRate', thresholdType: 'max_drop_pct', thresholdValue: 15 },
  { metricName: 'Revenue', ga4Metric: 'totalRevenue', thresholdType: 'max_drop_pct', thresholdValue: 15 },
  { metricName: 'Engagement rate', ga4Metric: 'engagementRate', thresholdType: 'max_drop_pct', thresholdValue: 10 }
]

/**
 * Guardrails — 2–4 metrics per client checked daily against GA4 (last 7 days
 * vs the baseline). A breach raises an alert. Typical use: make sure a test
 * or a site release doesn't quietly damage revenue or traffic.
 */
export function Guardrails({ client }: { client: any }) {
  const [rows, setRows] = useState<any[]>([])
  const [form, setForm] = useState<any>(PRESETS[1])
  const [error, setError] = useState('')
  const load = useCallback(() => api(`/api/guardrails?clientId=${client.id}`).then(d => setRows(d.guardrails)).catch(e => setError(e.message)), [client.id])
  useEffect(() => { load() }, [load])

  if (!client.integrations.ga4) return <div style={cardStyle}><p style={{ margin: 0, color: T.muted }}>Connect GA4 in Settings to use guardrails.</p></div>
  return (
    <>
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Guardrails</h3>
        <p style={{ fontSize: 13, color: T.muted, marginTop: -6 }}>Checked every morning on the last 7 days. The first reading becomes the baseline; a breach raises an alert.</p>
        {rows.length === 0 ? <p style={{ color: T.muted }}>No guardrails yet.</p> : rows.map(g => {
          const checks = (g.guardrail_checks ?? []).slice().sort((a: any, b: any) => a.checked_at.localeCompare(b.checked_at)).slice(-14)
          const max = Math.max(1, ...checks.map((c: any) => Number(c.value) || 0))
          return (
            <div key={g.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${T.line}`, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 220px' }}><strong>{g.metric_name}</strong> <span style={{ fontSize: 12, color: T.muted }}>({g.ga4_metric})</span>
                <div style={{ fontSize: 12, color: T.muted }}>{g.threshold_type === 'max_drop_pct' ? `alert if it drops more than ${g.threshold_value}% below baseline` : g.threshold_type === 'min_value' ? `alert below ${g.threshold_value}` : `alert above ${g.threshold_value}`}</div></div>
              <div style={{ fontSize: 13 }}>baseline {g.baseline_value ?? '—'} · now {g.current_value ?? '—'}</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 28 }}>{checks.map((c: any) => <div key={c.id} title={`${c.checked_at.slice(0, 10)}: ${c.value}`} style={{ width: 6, height: `${Math.max(8, ((Number(c.value) || 0) / max) * 100)}%`, background: c.status === 'breached' ? T.bad : T.gold, borderRadius: 1 }} />)}</div>
              <Pill color={g.status === 'breached' ? T.bad : g.status === 'ok' ? T.good : T.muted}>{g.status}</Pill>
            </div>)
        })}
      </div>
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Add a guardrail</h3>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>{PRESETS.map(p => <Button key={p.metricName} kind="ghost" onClick={() => setForm(p)}>{p.metricName}</Button>)}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0 12px' }}>
          <Field label="Name"><input style={inputStyle} value={form.metricName} onChange={e => setForm({ ...form, metricName: e.target.value })} /></Field>
          <Field label="GA4 metric"><input style={inputStyle} value={form.ga4Metric} onChange={e => setForm({ ...form, ga4Metric: e.target.value })} /></Field>
          <Field label="Rule"><select style={inputStyle} value={form.thresholdType} onChange={e => setForm({ ...form, thresholdType: e.target.value })}><option value="max_drop_pct">Max drop %</option><option value="min_value">Minimum value</option><option value="max_value">Maximum value</option></select></Field>
          <Field label="Threshold"><input style={inputStyle} inputMode="decimal" value={form.thresholdValue} onChange={e => setForm({ ...form, thresholdValue: e.target.value })} /></Field>
        </div>
        {error && <div style={{ color: T.bad, marginBottom: 8 }}>{error}</div>}
        <Button onClick={async () => {
          setError('')
          try { await api('/api/guardrails', { method: 'POST', json: { clientId: client.id, ga4PropertyId: client.ga4_property_id, ...form, thresholdValue: Number(form.thresholdValue) } }); load() }
          catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
        }}>Add guardrail</Button>
      </div>
    </>
  )
}
