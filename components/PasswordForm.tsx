'use client'
import { useState } from 'react'

/** Change-password form (used on /account and /portal). Styling via props so it fits both themes. */
export function PasswordForm({ dark = true }: { dark?: boolean }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const input = { width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${dark ? '#1E3A5F' : '#D5DCE5'}`, background: dark ? '#0D1B2E' : '#fff', color: dark ? '#fff' : '#0E1A2B', fontSize: 14, boxSizing: 'border-box' as const, marginBottom: 10, fontFamily: 'inherit' }
  return (
    <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setMsg(null)
      const res = await fetch('/api/auth', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: current, newPassword: next }) })
      const d = await res.json().catch(() => ({}))
      setMsg(res.ok ? { ok: true, text: 'Password changed.' } : { ok: false, text: d.error || 'Could not change password.' })
      if (res.ok) { setCurrent(''); setNext('') }
      setBusy(false)
    }} style={{ maxWidth: 360 }}>
      <input type="password" autoComplete="current-password" placeholder="Current password" style={input} value={current} onChange={e => setCurrent(e.target.value)} required />
      <input type="password" autoComplete="new-password" placeholder="New password (10+ characters)" style={input} value={next} onChange={e => setNext(e.target.value)} minLength={10} required />
      <button disabled={busy} style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: dark ? 'linear-gradient(135deg, #FFD700, #FFA500)' : '#0B1F3A', color: dark ? '#080E1A' : '#fff', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>{busy ? 'Saving…' : 'Change password'}</button>
      {msg && <div style={{ marginTop: 8, fontSize: 13, color: msg.ok ? '#2ED573' : '#FF4757' }}>{msg.text}</div>}
    </form>
  )
}
