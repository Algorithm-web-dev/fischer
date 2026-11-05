'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })

    const data = await res.json()

    if (res.ok) {
      router.push('/clients')
    } else {
      setError(data.error || 'Login failed.')
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #080E1A 0%, #0D1B2E 50%, #080E1A 100%)',
      padding: '20px'
    }}>
      <div style={{ width: '100%', maxWidth: '420px' }}>
        <div style={{ textAlign: 'center', marginBottom: '48px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '12px', marginBottom: '24px'
          }}>
            <div style={{
              width: '48px', height: '48px', background: 'linear-gradient(135deg, #FFD700, #FFA500)',
              borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '24px', fontWeight: 700, color: '#080E1A'
            }}>♟</div>
            <div>
              <div style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.5px', lineHeight: 1, color: '#fff' }}>FISCHER</div>
              <div style={{ fontSize: '11px', color: '#7A9BBD', letterSpacing: '3px', marginTop: '2px' }}>CRO AGENT</div>
            </div>
          </div>
          <p style={{ color: '#7A9BBD', fontSize: '14px', margin: 0, lineHeight: 1.6 }}>
            Algorithm Agency internal tool.<br />Sign in with your team account.
          </p>
        </div>

        <div style={{
          background: '#112240', border: '1px solid #1E3A5F', borderRadius: '16px',
          padding: '40px', boxShadow: '0 24px 48px rgba(0,0,0,0.4)'
        }}>
          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: '18px' }}>
              <label style={{ display: 'block', fontSize: '12px', color: '#7A9BBD', letterSpacing: '2px', marginBottom: '10px' }}>EMAIL</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@algorithmagency.co.za" required
                style={{
                  width: '100%', padding: '14px 16px', background: '#0D1B2E',
                  border: '1px solid #1E3A5F', borderRadius: '8px', color: '#FFFFFF',
                  fontSize: '15px', outline: 'none', boxSizing: 'border-box'
                }}
              />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', fontSize: '12px', color: '#7A9BBD', letterSpacing: '2px', marginBottom: '10px' }}>PASSWORD</label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="Enter your password" required
                style={{
                  width: '100%', padding: '14px 16px', background: '#0D1B2E',
                  border: error ? '1px solid #FF4757' : '1px solid #1E3A5F', borderRadius: '8px',
                  color: '#FFFFFF', fontSize: '15px', outline: 'none', boxSizing: 'border-box'
                }}
              />
              {error && (
                <p style={{ color: '#FF4757', fontSize: '13px', margin: '8px 0 0' }}>✕ {error}</p>
              )}
            </div>

            <button
              type="submit" disabled={loading || !email || !password}
              style={{
                width: '100%', padding: '14px', background: loading ? '#0A7FA8' : 'linear-gradient(135deg, #00C2FF, #0A7FA8)',
                border: 'none', borderRadius: '8px', color: '#080E1A', fontSize: '14px',
                fontWeight: 700, letterSpacing: '1px', cursor: loading ? 'wait' : 'pointer',
                opacity: (!email || !password) ? 0.5 : 1
              }}
            >
              {loading ? 'SIGNING IN...' : 'ACCESS FISCHER →'}
            </button>
          </form>
        </div>

        <p style={{ textAlign: 'center', color: '#4A6A8A', fontSize: '12px', marginTop: '24px' }}>
          Algorithm Agency · Fischer v2.0 · Internal Use Only
        </p>
      </div>
    </div>
  )
}
