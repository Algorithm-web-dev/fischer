'use client'
import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'

export const T = {
  bg: '#080E1A', panel: '#112240', panel2: '#0D1B2E', line: '#1E3A5F', text: '#FFFFFF', muted: '#7A9BBD',
  gold: '#FFD700', good: '#2ED573', bad: '#FF4757', warn: '#FF9F43'
}

export const inputStyle: CSSProperties = {
  width: '100%', padding: '10px 12px', background: T.panel2, border: `1px solid ${T.line}`, borderRadius: 8,
  color: T.text, fontSize: 14, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit'
}
export const labelStyle: CSSProperties = { display: 'block', fontSize: 11, color: T.muted, letterSpacing: 1.5, marginBottom: 6, fontWeight: 600, textTransform: 'uppercase' }
export const cardStyle: CSSProperties = { background: T.panel, border: `1px solid ${T.line}`, borderRadius: 12, padding: 22, marginBottom: 18 }

export function Button({ children, onClick, disabled, kind = 'primary', type = 'button', style }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: 'primary' | 'ghost' | 'danger'; type?: 'button' | 'submit'; style?: CSSProperties
}) {
  const base: CSSProperties = { padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, fontFamily: 'inherit', border: 'none' }
  const kinds: Record<string, CSSProperties> = {
    primary: { background: 'linear-gradient(135deg, #FFD700, #FFA500)', color: T.bg },
    ghost: { background: 'transparent', color: T.text, border: `1px solid ${T.line}` },
    danger: { background: 'transparent', color: T.bad, border: `1px solid ${T.bad}` }
  }
  return <button type={type} onClick={onClick} disabled={disabled} style={{ ...base, ...kinds[kind], ...style }}>{children}</button>
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label style={{ display: 'block', marginBottom: 14 }}><span style={labelStyle}>{label}</span>{children}</label>
}

export function Pill({ children, color = T.muted }: { children: ReactNode; color?: string }) {
  return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}`, textTransform: 'uppercase', letterSpacing: 0.5 }}>{children}</span>
}

export function Nav() {
  const link: CSSProperties = { color: T.muted, textDecoration: 'none', fontSize: 14, fontWeight: 600 }
  return (
    <nav style={{ display: 'flex', gap: 20, alignItems: 'center', padding: '14px 24px', borderBottom: `1px solid ${T.line}`, flexWrap: 'wrap' }}>
      <span style={{ fontWeight: 700, letterSpacing: 2 }}>♟ FISCHER</span>
      <Link href="/clients" style={link}>Clients</Link>
      <Link href="/audit" style={link}>Run audit</Link>
      <Link href="/library" style={link}>Library</Link>
      <button
        onClick={async () => { await fetch('/api/auth', { method: 'DELETE' }); window.location.href = '/' }}
        style={{ ...link, marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
      >Sign out</button>
    </nav>
  )
}

export function Page({ children, title, actions }: { children: ReactNode; title: string; actions?: ReactNode }) {
  return (
    <div>
      <Nav />
      <main style={{ maxWidth: 1180, margin: '0 auto', padding: '24px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
          <h1 style={{ fontSize: 22, margin: 0 }}>{title}</h1>
          {actions}
        </div>
        {children}
      </main>
    </div>
  )
}

export async function api<T = any>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data as T
}

export const scoreColor = (s: number | null | undefined) => s == null ? T.muted : s >= 70 ? T.good : s >= 45 ? T.warn : T.bad
