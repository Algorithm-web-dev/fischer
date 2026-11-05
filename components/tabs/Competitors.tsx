'use client'
import { useCallback, useEffect, useState } from 'react'
import { Button, Field, inputStyle, cardStyle, labelStyle, T, api, scoreColor } from '@/components/ui'

/** Competitor benchmarking: light audits of up to 5 competitor pages + a market-position synthesis. */
export function Competitors({ client }: { client: any }) {
  const [analyses, setAnalyses] = useState<any[]>([])
  const [comps, setComps] = useState([{ name: '', url: '' }, { name: '', url: '' }, { name: '', url: '' }])
  const [clientUrl, setClientUrl] = useState(client.primary_url || '')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<any>(null)

  const load = useCallback(() => api(`/api/market-share?clientId=${client.id}`).then(d => setAnalyses(d.analyses)).catch(() => {}), [client.id])
  useEffect(() => { load() }, [load])

  async function run() {
    setRunning(true); setError('')
    try {
      const { audits } = await api(`/api/audits?clientId=${client.id}&status=complete&limit=1`)
      const r = await api('/api/market-share', { method: 'POST', json: {
        clientId: client.id, clientUrl, clientAuditId: audits[0]?.id, clientFischerScore: audits[0]?.fischer_score,
        competitors: comps.filter(c => c.name && c.url)
      } })
      setResult(r); load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
    finally { setRunning(false) }
  }

  const latest = result?.synthesis ?? (analyses[0] && { marketPosition: analyses[0].market_position, competitiveGaps: analyses[0].competitive_gaps, revenueOpportunity: analyses[0].revenue_opportunity, recoveryRoadmap: analyses[0].recovery_roadmap })
  return (
    <>
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Run a competitor analysis</h3>
        <p style={{ fontSize: 13, color: T.muted, marginTop: -6 }}>Fischer screenshots each competitor page (desktop), scores it with the same method as the client&apos;s audits, estimates traffic from public data, and compares. Needs a completed audit of the client for its score. Takes ~1 minute per competitor.</p>
        <Field label="Client page to compare"><input style={inputStyle} value={clientUrl} onChange={e => setClientUrl(e.target.value)} /></Field>
        {comps.map((c, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
            <Field label={`Competitor ${i + 1}`}><input style={inputStyle} value={c.name} placeholder="Name" onChange={e => setComps(comps.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></Field>
            <Field label="Page URL"><input style={inputStyle} value={c.url} placeholder="https://…" onChange={e => setComps(comps.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} /></Field>
          </div>))}
        {comps.length < 5 && <Button kind="ghost" onClick={() => setComps([...comps, { name: '', url: '' }])}>+ Competitor</Button>}{' '}
        <Button onClick={run} disabled={running || !clientUrl || !comps.some(c => c.name && c.url)}>{running ? 'Analysing competitors…' : 'Run analysis'}</Button>
        {error && <div style={{ color: T.bad, marginTop: 8 }}>{error}</div>}
      </div>
      {result?.competitorAudits && (
        <div style={cardStyle}>
          <div style={labelStyle}>Competitor scores</div>
          {result.competitorAudits.map((c: any) => (
            <div key={c.url} style={{ padding: '8px 0', borderTop: `1px solid ${T.line}`, fontSize: 14 }}>
              <strong style={{ color: scoreColor(c.fischerScore) }}>{c.fischerScore}</strong> {c.name} <span style={{ color: T.muted }}>· {c.traffic?.monthlyVisits}</span>
              <div style={{ fontSize: 12, color: T.muted }}>{c.topFrictionPoints.map((f: any) => f.title).join(' · ')}</div>
            </div>))}
        </div>
      )}
      {latest && (
        <div style={cardStyle}>
          <div style={labelStyle}>Market position {analyses[0] && !result ? `(${analyses[0].created_at.slice(0, 10)})` : ''}</div>
          <p style={{ lineHeight: 1.6 }}>{latest.marketPosition}</p>
          {latest.competitiveGaps?.map((g: any, i: number) => <div key={i} style={{ fontSize: 14, marginBottom: 6 }}><strong>{g.competitor}:</strong> {g.gap} <span style={{ color: T.gold }}>{g.revenueOpportunity}</span></div>)}
          {latest.revenueOpportunity && <p style={{ fontSize: 14 }}><strong>Opportunity:</strong> {latest.revenueOpportunity}</p>}
          {latest.recoveryRoadmap?.length > 0 && <ol style={{ fontSize: 14 }}>{latest.recoveryRoadmap.map((s: any) => <li key={s.step}>{s.description}</li>)}</ol>}
        </div>
      )}
    </>
  )
}
