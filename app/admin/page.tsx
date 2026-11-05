'use client'
import { useEffect, useState } from 'react'
import { Page, cardStyle, labelStyle, T, api } from '@/components/ui'

const usd = (n: number) => `$${n.toFixed(2)}`

export default function AdminPage() {
  const [usage, setUsage] = useState<any>(null)
  const [errors, setErrors] = useState<any[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    api('/api/usage?months=6').then(setUsage).catch(e => setError(e.message))
    api('/api/errors?limit=50').then(d => setErrors(d.errors)).catch(() => {})
  }, [])
  const th = { ...labelStyle, textAlign: 'left' as const, padding: 8, borderBottom: `1px solid ${T.line}` }
  const thisMonth = usage?.byMonth?.[usage.byMonth.length - 1]
  return (
    <Page title="Admin">
      {error && <div style={{ color: T.bad }}>{error}</div>}
      {usage && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 18 }}>
            <div style={{ ...cardStyle, marginBottom: 0 }}><div style={labelStyle}>Latest month</div><div style={{ fontSize: 28, fontWeight: 700 }}>{usd(thisMonth?.costUsd ?? 0)}</div><div style={{ fontSize: 12, color: T.muted }}>{thisMonth?.calls ?? 0} Claude calls</div></div>
            <div style={{ ...cardStyle, marginBottom: 0 }}><div style={labelStyle}>Average audit</div><div style={{ fontSize: 28, fontWeight: 700 }}>{usage.avgAuditCostUsd != null ? `$${usage.avgAuditCostUsd}` : '—'}</div><div style={{ fontSize: 12, color: T.muted }}>last 6 months</div></div>
            <div style={{ ...cardStyle, marginBottom: 0 }}><div style={labelStyle}>By month</div>{usage.byMonth.map((m: any) => <div key={m.key} style={{ fontSize: 13 }}>{m.key}: <strong>{usd(m.costUsd)}</strong></div>)}</div>
          </div>
          <div style={cardStyle}>
            <h3 style={{ marginTop: 0 }}>Claude cost by client (6 months)</h3>
            <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr><th style={th}>Client</th><th style={th}>Calls</th><th style={th}>Cost</th></tr></thead>
              <tbody>{(usage.byClient ?? []).map((c: any) => <tr key={c.key} style={{ borderBottom: `1px solid ${T.line}` }}><td style={{ padding: 8 }}>{c.name}</td><td style={{ padding: 8 }}>{c.calls}</td><td style={{ padding: 8 }}>{usd(c.costUsd)}</td></tr>)}</tbody>
            </table></div>
            <p style={{ fontSize: 12, color: T.muted }}>By feature: {usage.byFeature.map((f: any) => `${f.key} ${usd(f.costUsd)}`).join(' · ')} — by model: {usage.byModel.map((m: any) => `${m.key} ${usd(m.costUsd)}`).join(' · ')}</p>
          </div>
        </>
      )}
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Recent errors</h3>
        {errors.length === 0 ? <p style={{ color: T.muted, margin: 0 }}>No errors logged.</p> : errors.map(e => (
          <div key={e.id} style={{ borderTop: `1px solid ${T.line}`, padding: '8px 0', fontSize: 13 }}>
            <div><strong>{e.context}</strong> <span style={{ color: T.muted }}>{e.created_at.slice(0, 16).replace('T', ' ')}{e.clients?.name ? ` · ${e.clients.name}` : ''}</span></div>
            <div style={{ color: T.bad }}>{e.message}</div>
          </div>))}
      </div>
    </Page>
  )
}
