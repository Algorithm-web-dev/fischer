'use client'
import { useCallback, useEffect, useState } from 'react'
import { Button, Field, inputStyle, cardStyle, T, api } from '@/components/ui'
import { TempPassword } from '@/components/TeamAdmin'

/** Client Settings: portal logins, data export and deletion (admin actions). */
export function ClientAccess({ client }: { client: any }) {
  const [users, setUsers] = useState<any[]>([])
  const [email, setEmail] = useState('')
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null)
  const [confirmName, setConfirmName] = useState('')
  const [error, setError] = useState('')
  const load = useCallback(() => api(`/api/clients/${client.id}/users`).then(d => setUsers(d.users)).catch(() => {}), [client.id])
  useEffect(() => { load() }, [load])

  return (
    <>
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Client portal</h3>
        <p style={{ fontSize: 13, color: T.muted, marginTop: -6 }}>People at {client.name} who can sign in and see their monthly reports (read-only, this client only). Admins can add and remove them.</p>
        {users.map(u => (
          <div key={u.user_id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: `1px solid ${T.line}` }}>
            <span style={{ flex: 1 }}>{u.email}</span>
            <Button kind="danger" onClick={async () => { try { await api(`/api/clients/${client.id}/users?userId=${u.user_id}`, { method: 'DELETE' }); load() } catch (e) { setError(e instanceof Error ? e.message : 'Failed') } }}>Remove</Button>
          </div>))}
        <div style={{ display: 'flex', gap: 10, alignItems: 'end', marginTop: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px' }}><Field label="Email"><input style={inputStyle} type="email" value={email} onChange={e => setEmail(e.target.value)} /></Field></div>
          <div style={{ marginBottom: 14 }}><Button disabled={!email} onClick={async () => {
            setError(''); setTemp(null)
            try { const r = await api(`/api/clients/${client.id}/users`, { method: 'POST', json: { email } }); if (r.tempPassword) setTemp({ email: r.user.email, password: r.tempPassword }); setEmail(''); load() }
            catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
          }}>Give portal access</Button></div>
        </div>
        {temp && <TempPassword {...temp} />}
        {error && <div style={{ color: T.bad, marginTop: 8 }}>{error}</div>}
      </div>
      <div style={{ ...cardStyle, borderColor: T.bad }}>
        <h3 style={{ marginTop: 0 }}>Data &amp; deletion</h3>
        <p style={{ fontSize: 13, color: T.muted, marginTop: -6 }}>For access or erasure requests (POPIA/GDPR). Admins only.</p>
        <a href={`/api/clients/${client.id}/export`}><Button kind="ghost">Export all data (JSON)</Button></a>
        <div style={{ marginTop: 16, fontSize: 13 }}>Permanently delete {client.name} with every audit, screenshot, snapshot, lead, test, report link and portal login&apos;s access. This cannot be undone.</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'end', marginTop: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px' }}><Field label={`Type "${client.name}" to confirm`}><input style={inputStyle} value={confirmName} onChange={e => setConfirmName(e.target.value)} /></Field></div>
          <div style={{ marginBottom: 14 }}><Button kind="danger" disabled={confirmName !== client.name} onClick={async () => {
            try { const r = await api(`/api/clients/${client.id}`, { method: 'DELETE', json: { confirmName } }); alert(`Deleted: ${r.rowsDeleted} records and ${r.screenshotsDeleted} screenshots.`); window.location.href = '/clients' }
            catch (e) { setError(e instanceof Error ? e.message : 'Failed') }
          }}>Delete client permanently</Button></div>
        </div>
      </div>
    </>
  )
}
