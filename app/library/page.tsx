'use client'
import { useEffect, useState } from 'react'
import { Page, Field, Pill, inputStyle, cardStyle, labelStyle, T, api } from '@/components/ui'
import { TEST_TAGS } from '@/lib/test-tags'

export default function LibraryPage() {
  const [industry, setIndustry] = useState('')
  const [tag, setTag] = useState('')
  const [data, setData] = useState<any>(null)
  const [bench, setBench] = useState<any>(null)
  useEffect(() => { api('/api/benchmarks').then(d => setBench(d.benchmarks)).catch(() => {}) }, [])
  useEffect(() => {
    const q = new URLSearchParams(); if (industry) q.set('industry', industry); if (tag) q.set('tag', tag)
    api(`/api/test-library?${q}`).then(setData).catch(() => setData({ entries: [], summary: [] }))
  }, [industry, tag])

  return (
    <Page title="Test library & benchmarks">
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Industry benchmarks</h3>
        <p style={{ fontSize: 13, color: T.muted, marginTop: -6 }}>Conversion rates across clients (last 3 complete months, anonymised). An industry appears once at least 3 clients with 1,000+ sessions share it — set each client&apos;s industry consistently.</p>
        {!bench || bench.industries.length === 0 ? <p style={{ color: T.muted, margin: 0 }}>Not enough clients per industry yet.</p> : (
          <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>{['Industry', 'Clients', 'Median CVR', 'Middle 50%', 'Mobile median', 'Desktop median'].map(h => <th key={h} style={{ ...labelStyle, textAlign: 'left', padding: 8, borderBottom: `1px solid ${T.line}` }}>{h}</th>)}</tr></thead>
            <tbody>{bench.industries.map((i: any) => (
              <tr key={i.industry} style={{ borderBottom: `1px solid ${T.line}` }}>
                <td style={{ padding: 8 }}>{i.industry}</td><td style={{ padding: 8 }}>{i.overall.clients}</td><td style={{ padding: 8 }}>{i.overall.median}%</td>
                <td style={{ padding: 8 }}>{i.overall.p25}% – {i.overall.p75}%</td><td style={{ padding: 8 }}>{i.devices.mobile ? `${i.devices.mobile.median}%` : '—'}</td><td style={{ padding: 8 }}>{i.devices.desktop ? `${i.devices.desktop.median}%` : '—'}</td>
              </tr>))}</tbody></table></div>
        )}
      </div>
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>What has worked</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ width: 220 }}><Field label="Industry"><input style={inputStyle} value={industry} onChange={e => setIndustry(e.target.value)} placeholder="All" /></Field></div>
          <div style={{ width: 220 }}><Field label="Change type"><select style={inputStyle} value={tag} onChange={e => setTag(e.target.value)}><option value="">All</option>{TEST_TAGS.map(t => <option key={t.tag} value={t.tag}>{t.label}</option>)}</select></Field></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 16 }}>
          {(data?.summary ?? []).map((s: any) => (
            <div key={s.tag} style={{ background: T.panel2, borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{s.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: s.winRate >= 40 ? T.good : T.text }}>{s.winRate}%</div>
              <div style={{ fontSize: 12, color: T.muted }}>{s.wins} of {s.tests} won{s.avgWinningLift != null ? ` · winners +${s.avgWinningLift}%` : ''}</div>
            </div>))}
        </div>
        {(data?.entries ?? []).length === 0 ? <p style={{ color: T.muted }}>No concluded tests yet. Completed tests with results appear here automatically.</p> : data.entries.map((e: any) => (
          <div key={e.id} style={{ borderTop: `1px solid ${T.line}`, padding: '10px 0' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <strong style={{ flex: '1 1 260px' }}>{e.name}</strong>
              <Pill color={e.winner === 'variant' ? T.good : e.winner === 'control' ? T.bad : T.muted}>{e.winner === 'variant' ? `won ${e.relativeLift > 0 ? '+' : ''}${e.relativeLift}%` : e.winner === 'control' ? 'lost' : 'no difference'}</Pill>
              {e.industry && <Pill>{e.industry}</Pill>}{e.tags.map((t: string) => <Pill key={t}>{t}</Pill>)}
            </div>
            {e.change && <div style={{ fontSize: 13, color: T.muted, marginTop: 4 }}>{e.change}</div>}
          </div>))}
      </div>
    </Page>
  )
}
