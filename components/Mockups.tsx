'use client'
import { useState } from 'react'
import { Button, T, api } from '@/components/ui'

export function BeforeAfter({ m }: { m: any }) {
  if (!m) return null
  return (
    <div style={{ marginTop: 10 }}>
      {m.summary && <div style={{ fontSize: 13, marginBottom: 6 }}>{m.summary}</div>}
      {m.before_url && m.after_url ? (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[['Now', m.before_url], ['Proposed', m.after_url]].map(([label, url]) => (
            <figure key={label} style={{ margin: 0, flex: m.viewport === 'mobile' ? '0 0 240px' : '1 1 340px' }}>
              <figcaption style={{ fontSize: 11, color: T.muted, textTransform: 'uppercase', marginBottom: 4 }}>{label} · {m.viewport}</figcaption>
              <img src={url} alt={`${label} — ${m.title}`} style={{ width: '100%', border: `1px solid ${T.line}`, borderRadius: 6 }} />
            </figure>))}
        </div>
      ) : <div style={{ fontSize: 12, color: T.warn }}>No visual mockup — {m.summary || 'the change could not be expressed as page edits.'}</div>}
      {m.applied?.some((a: any) => !a.ok) && <div style={{ fontSize: 12, color: T.warn, marginTop: 4 }}>Some edits didn&apos;t find their element: {m.applied.filter((a: any) => !a.ok).map((a: any) => a.selector).join(', ')}</div>}
    </div>
  )
}

/** "Show mockup" button + result for one audit finding or hypothesis. */
export function MockupButton({ auditId, kind, index, existing }: { auditId: string; kind: 'finding' | 'hypothesis'; index: number; existing?: any }) {
  const [m, setM] = useState<any>(existing ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <div>
      {!m && <Button kind="ghost" disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try { const r = await api('/api/mockups', { method: 'POST', json: { auditId, kind, index } }); setM(r.mockup) }
        catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
        finally { setBusy(false) }
      }}>{busy ? 'Building mockup… (~1 min)' : 'Show mockup'}</Button>}
      {error && <div style={{ fontSize: 12, color: T.bad }}>{error}</div>}
      <BeforeAfter m={m} />
    </div>
  )
}
