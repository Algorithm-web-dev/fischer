'use client'
export function PortalSignOut() {
  return (
    <button
      onClick={async () => { await fetch('/api/auth', { method: 'DELETE' }); window.location.href = '/' }}
      style={{ background: 'none', border: '1px solid #D5DCE5', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', color: '#0E1A2B', fontFamily: 'inherit' }}
    >Sign out</button>
  )
}
