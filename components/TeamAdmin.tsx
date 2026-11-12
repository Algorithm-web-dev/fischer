'use client'
import { useCallback, useEffect, useState } from 'react'
import { Button, Field, Pill, inputStyle, cardStyle, T, api } from '@/components/ui'

/** Admin: team members, roles, and the activity log. */
export function TeamAdmin() {
  const [data, setData] = useState<any>(null)
  const [form, setForm] = useState({ email: '', role: 'analyst' })
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => api('/api/team').then(setData).catch(e => setError(e.message)), [])
  useEffect(() => { load() }, [load])

  return (
    <>
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Team</h3>
        <p style={{ fontSize: 13, color: T.muted, marginTop: -6 }}><strong>Admin</strong>: everything incl. team, data export and deletion · <strong>Analyst</strong>: all client work · <strong>Viewer</strong>: read-only. Client logins are managed per client (Settings → Client portal).</p>
        {error && <div style={{ color: T.bad }}>{error}</div>}
        {(data?.members ?? []).map((m: any) => (
          <div key={m.user_id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: `1px solid ${T.line}`, flexWrap: 'wrap' }}>
            <span style={{ flex: '1 1 240px' }}>{m.email}{m.user_id === data.me && <span style={{ color: T.muted }}> (you)</span>}</span>
            <select style={{ ...inputStyle, width: 130 }} value={m.role} disabled={m.user_id === data.me}
              onChange={async e => { try { await api('/api/team', { method: 'PATCH', json: { userId: m.user_id, role: e.target.value } }); load() } catch (err) { setError(err instanceof Error ? err.message : 'Failed') } }}>
              <option value="admin">admin</option><option value="analyst">analyst</option><option value="viewer">viewer</option>
            </select>
            {m.user_id !== data.me && <Button kind="danger" onClick={async () => { if (confirm(`Remove ${m.email} from the team?`)) { await api(`/api/team?userId=${m.user_id}`, { method: 'DELETE' }); load() } }}>Remove</Button>}
          </div>))}
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: 10, alignItems: 'end', marginTop: 12 }}>
          <Field label="Email"><input style={inputStyle} type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Role"><select style={inputStyle} value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}><option>analyst</option><option>viewer</option><option>admin</option></select></Field>
          <div style={{ marginBottom: 14 }}><Button disabled={!form.email} onClick={async () => {
            setError(''); setTemp(null)
            try { const r = await api('/api/team', { method: 'POST', json: form }); if (r.tempPassword) setTemp({ email: r.member.email, password: r.tempPassword }); setForm({ email: '', role: 'analyst' }); load() }
            catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
          }}>Add</Button></div>
        </div>
        {temp && <TempPassword {...temp} />}
      </div>
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Activity log</h3>
        {(data?.activity ?? []).length === 0 ? <p style={{ color: T.muted, margin: 0 }}>No activity yet.</p> : data.activity.map((a: any) => (
          <div key={a.id} style={{ fontSize: 13, padding: '5px 0', borderTop: `1px solid ${T.line}` }}>
            <span style={{ color: T.muted }}>{a.created_at.slice(0, 16).replace('T', ' ')}</span> · {a.user_email ?? 'system'} · <Pill>{a.action}</Pill>
            {a.details && <span style={{ color: T.muted }}> {Object.entries(a.details).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(' · ')}</span>}
          </div>))}
      </div>
    </>
  )
}

export function TempPassword({ email, password }: { email: string; password: string }) {
  return (
    <div style={{ background: T.panel2, padding: 12, borderRadius: 8, marginTop: 10, fontSize: 13 }}>
      <strong style={{ color: T.warn }}>Login created — share these details securely; the password is shown only once:</strong>
      <div style={{ fontFamily: 'monospace', marginTop: 6 }}>{email} / {password}</div>
      <div style={{ color: T.muted, marginTop: 4 }}>They should change it after signing in (Account → Change password).</div>
    </div>
  )
}
