'use client'
import { useCallback, useEffect, useState } from 'react'
import { Button, Field, Pill, inputStyle, cardStyle, labelStyle, T, api } from '@/components/ui'

const TIERS = [
  { key: 'watching', label: 'Watching', hint: 'Evidence collected, not yet prioritised' },
  { key: 'next', label: 'Next', hint: 'Prioritised for next month' },
  { key: 'this_month', label: 'This month', hint: 'Being built or tested now' },
  { key: 'shipped', label: 'Shipped', hint: 'Live — logged in the change log' }
] as const
const SEV: Record<string, string> = { high: T.bad, medium: T.warn, low: T.muted }

/**
 * Backlog board — the roadmap for one client. Moving an item to "Shipped"
 * records it in the change log, which is what drives before/after impact
 * and the "what we did" section of the client report.
 */
export function Backlog({ client }: { client: any }) {
  const [items, setItems] = useState<any[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [form, setForm] = useState({ title: '', description: '', severity: 'medium' })
  const [error, setError] = useState('')

  const load = useCallback(() => api(`/api/backlog?clientId=${client.id}`).then(d => setItems(d.items)).catch(e => setError(e.message)), [client.id])
  useEffect(() => { load() }, [load])

  const patch = async (id: string, json: unknown) => {
    try { await api(`/api/backlog/${id}`, { method: 'PATCH', json }); load() } catch (e) { setError(e instanceof Error ? e.message : 'Update failed') }
  }
  const move = (item: any, dir: 1 | -1) => {
    const i = TIERS.findIndex(t => t.key === item.tier)
    const next = TIERS[i + dir]
    if (!next) return
    if (next.key === 'shipped') {
      const date = prompt('Date this went live (YYYY-MM-DD)', new Date().toISOString().slice(0, 10))
      if (!date) return
      patch(item.id, { tier: 'shipped', shippedDate: date })
    } else patch(item.id, { tier: next.key })
  }
  const score = async (item: any) => {
    setBusy(item.id)
    try { await api(`/api/backlog/${item.id}/pxl-score`, { method: 'POST' }); load() } catch (e) { setError(e instanceof Error ? e.message : 'Scoring failed') }
    finally { setBusy(null) }
  }
  const rank = (a: any, b: any) => (b.pxl_score?.totalScore ?? -1) - (a.pxl_score?.totalScore ?? -1) || (Number(b.ice_score) || 0) - (Number(a.ice_score) || 0)

  return (
    <>
      {error && <div style={{ color: T.bad, marginBottom: 10 }}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 14, alignItems: 'start' }}>
        {TIERS.map(tier => {
          const list = items.filter(i => i.tier === tier.key).sort(rank)
          return (
            <div key={tier.key} style={{ ...cardStyle, padding: 14, marginBottom: 0 }}>
              <div style={labelStyle}>{tier.label} ({list.length})</div>
              <div style={{ fontSize: 11, color: T.muted, marginTop: -4, marginBottom: 10 }}>{tier.hint}</div>
              {list.length === 0 && <div style={{ fontSize: 12, color: T.muted }}>Empty</div>}
              {list.map(item => (
                <div key={item.id} style={{ background: T.panel2, borderRadius: 8, padding: 10, marginBottom: 8, borderLeft: `3px solid ${SEV[item.severity] ?? T.line}` }}>
                  <div style={{ fontSize: 13, fontWeight: 700, cursor: 'pointer' }} onClick={() => setOpen(open === item.id ? null : item.id)}>{item.title}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '6px 0' }}>
                    {item.severity && <Pill color={SEV[item.severity]}>{item.severity}</Pill>}
                    {item.ice_score != null && Number(item.ice_score) > 0 && <Pill>ICE {Number(item.ice_score).toFixed(1)}</Pill>}
                    {item.pxl_score && <Pill color={T.gold}>PXL {item.pxl_score.totalScore}/{item.pxl_score.maxPossibleScore}</Pill>}
                    <Pill>{item.evidence_type}</Pill>
                  </div>
                  {open === item.id && <ItemDetail item={item} onSave={json => patch(item.id, json)} />}
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {tier.key !== 'watching' && <Button kind="ghost" style={{ padding: '4px 8px' }} onClick={() => move(item, -1)}>←</Button>}
                    {tier.key !== 'shipped' && <Button kind="ghost" style={{ padding: '4px 8px' }} onClick={() => move(item, 1)}>{tier.key === 'this_month' ? 'Shipped →' : '→'}</Button>}
                    {!item.pxl_score && tier.key !== 'shipped' && <Button kind="ghost" style={{ padding: '4px 8px' }} disabled={busy === item.id} onClick={() => score(item)}>{busy === item.id ? 'Scoring…' : 'Score PXL'}</Button>}
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
      <div style={{ ...cardStyle, marginTop: 18 }}>
        <h3 style={{ marginTop: 0 }}>Add an item</h3>
        <p style={{ fontSize: 13, color: T.muted, marginTop: -6 }}>Audit findings are added from an audit (“Add all to backlog”); add ideas from calls, Clarity recordings or the client here.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <Field label="Title"><input style={inputStyle} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Severity"><select style={inputStyle} value={form.severity} onChange={e => setForm({ ...form, severity: e.target.value })}><option>high</option><option>medium</option><option>low</option></select></Field>
        </div>
        <Field label="Description / evidence"><textarea style={{ ...inputStyle, minHeight: 60 }} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></Field>
        <Button disabled={!form.title} onClick={async () => { await api('/api/backlog', { method: 'POST', json: { clientId: client.id, ...form } }); setForm({ title: '', description: '', severity: 'medium' }); load() }}>Add to Watching</Button>
      </div>
    </>
  )
}

function ItemDetail({ item, onSave }: { item: any; onSave: (json: unknown) => void }) {
  const [v, setV] = useState({ iceImpact: item.ice_impact ?? '', iceConfidence: item.ice_confidence ?? '', iceEase: item.ice_ease ?? '', owner: item.owner ?? '', resultSummary: item.result_summary ?? '' })
  const n = (x: unknown) => x === '' ? null : Math.max(1, Math.min(10, Number(x)))
  return (
    <div style={{ fontSize: 12, margin: '6px 0 8px' }}>
      {item.description && <div style={{ whiteSpace: 'pre-line', color: T.muted, marginBottom: 8 }}>{item.description}</div>}
      {item.pxl_score && <details style={{ marginBottom: 8 }}><summary style={{ cursor: 'pointer' }}>PXL breakdown</summary>
        {Object.entries(item.pxl_score.criteria).map(([k, yes]) => <div key={k}>{yes ? '✓' : '✗'} {k} — <span style={{ color: T.muted }}>{item.pxl_score.reasoning?.[k]}</span></div>)}</details>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
        {(['iceImpact', 'iceConfidence', 'iceEase'] as const).map(k => (
          <label key={k}><span style={{ color: T.muted }}>{k.replace('ice', '')}</span><input style={{ ...inputStyle, padding: 6 }} inputMode="numeric" value={v[k]} onChange={e => setV({ ...v, [k]: e.target.value })} /></label>))}
      </div>
      <label style={{ display: 'block', marginTop: 6 }}><span style={{ color: T.muted }}>Owner</span><input style={{ ...inputStyle, padding: 6 }} value={v.owner} onChange={e => setV({ ...v, owner: e.target.value })} /></label>
      {item.tier === 'shipped' && <label style={{ display: 'block', marginTop: 6 }}><span style={{ color: T.muted }}>Result (shown in reports)</span><input style={{ ...inputStyle, padding: 6 }} value={v.resultSummary} onChange={e => setV({ ...v, resultSummary: e.target.value })} placeholder="e.g. form completions +18%" /></label>}
      <Button kind="ghost" style={{ padding: '4px 8px', marginTop: 6 }} onClick={() => onSave({ iceImpact: n(v.iceImpact), iceConfidence: n(v.iceConfidence), iceEase: n(v.iceEase), owner: v.owner || null, resultSummary: v.resultSummary || null })}>Save</Button>
    </div>
  )
}
