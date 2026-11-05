'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Page, Button, Field, Pill, inputStyle, cardStyle, T, api } from '@/components/ui'
import { ClientForm, type ClientFormValues } from '@/components/ClientForm'

interface ClientRow {
  id: string; name: string; primary_url: string | null; tier: string; industry: string | null
  integrations: { ga4: boolean; clarity: boolean }
}

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientRow[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [alertCounts, setAlertCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    api('/api/alerts').then(d => {
      const counts: Record<string, number> = {}
      for (const a of d.alerts) if (a.client_id) counts[a.client_id] = (counts[a.client_id] ?? 0) + 1
      setAlertCounts(counts)
    }).catch(() => {})
  }, [])

  const load = () => api<{ clients: ClientRow[] }>('/api/clients')
    .then(d => setClients(d.clients)).catch(e => setError(e.message)).finally(() => setLoading(false))
  useEffect(() => { load() }, [])

  async function create(values: ClientFormValues) {
    await api('/api/clients', { method: 'POST', json: values })
    setAdding(false)
    load()
  }

  const shown = clients.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()))

  return (
    <Page title="Clients" actions={<Button onClick={() => setAdding(a => !a)}>{adding ? 'Cancel' : '+ Add client'}</Button>}>
      {error && <div style={{ color: T.bad, marginBottom: 12 }}>{error}</div>}
      {adding && <div style={cardStyle}><ClientForm onSubmit={create} submitLabel="Create client" /></div>}
      <div style={{ marginBottom: 14, maxWidth: 320 }}>
        <Field label="Search"><input style={inputStyle} value={filter} onChange={e => setFilter(e.target.value)} placeholder="Client name" /></Field>
      </div>
      {loading ? <p style={{ color: T.muted }}>Loading…</p> : shown.length === 0 ? (
        <div style={cardStyle}><p style={{ color: T.muted, margin: 0 }}>No clients yet. Add one to connect GA4/Clarity, track pages monthly and send reports.</p></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
          {shown.map(c => (
            <Link key={c.id} href={`/clients/${c.id}`} style={{ ...cardStyle, marginBottom: 0, textDecoration: 'none', color: T.text, display: 'block' }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{c.name}</div>
              <div style={{ color: T.muted, fontSize: 13, margin: '4px 0 10px', wordBreak: 'break-all' }}>{c.primary_url || 'No URL set'}{c.industry ? ` · ${c.industry}` : ''}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Pill>Tier {c.tier}</Pill>
                <Pill color={c.integrations.ga4 ? T.good : T.muted}>GA4 {c.integrations.ga4 ? 'on' : 'off'}</Pill>
                <Pill color={c.integrations.clarity ? T.good : T.muted}>Clarity {c.integrations.clarity ? 'on' : 'off'}</Pill>
                {alertCounts[c.id] > 0 && <Pill color={T.bad}>{alertCounts[c.id]} alert{alertCounts[c.id] === 1 ? '' : 's'}</Pill>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </Page>
  )
}
