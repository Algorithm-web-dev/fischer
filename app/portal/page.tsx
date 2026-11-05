import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase'
import { PasswordForm } from '@/components/PasswordForm'
import { PortalSignOut } from '@/components/PortalSignOut'

export const dynamic = 'force-dynamic'

const C = { ink: '#0E1A2B', muted: '#5B6B80', line: '#E3E8EF', bg: '#F6F8FB', navy: '#0B1F3A', accent: '#C98A00' }
const monthLabel = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/**
 * Client portal home. Row-level security limits every query here to the
 * clients this login belongs to (client_users).
 */
export default async function PortalPage() {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')
  const { data: links } = await supabase.from('client_users').select('client_id').eq('user_id', user.id)
  const ids = (links ?? []).map(l => l.client_id)
  const { data: clients } = ids.length ? await supabase.from('clients').select('id, name, report_logo_url').in('id', ids) : { data: [] }

  const sections = await Promise.all((clients ?? []).map(async c => {
    const [{ data: snaps }, { data: audits }] = await Promise.all([
      supabase.from('monthly_snapshots').select('period').eq('client_id', c.id).order('period', { ascending: false }).limit(24),
      supabase.from('audits').select('completed_at').eq('client_id', c.id).eq('status', 'complete').order('completed_at', { ascending: false }).limit(200)
    ])
    const months = new Set<string>([
      ...(snaps ?? []).map(s => String(s.period).slice(0, 7)),
      ...(audits ?? []).map(a => String(a.completed_at).slice(0, 7))
    ])
    return { client: c, months: Array.from(months).sort().reverse() }
  }))

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.ink, fontFamily: "'Space Grotesk', system-ui, sans-serif", padding: '32px 16px' }}>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: 3, textTransform: 'uppercase', color: C.accent, fontWeight: 700 }}>Conversion reports</div>
            <div style={{ color: C.muted, fontSize: 14 }}>{user.email}</div>
          </div>
          <PortalSignOut />
        </header>
        {sections.length === 0 && <p>Your account isn&apos;t linked to a client yet. Please contact your account manager.</p>}
        {sections.map(({ client, months }) => (
          <section key={client.id} style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', marginBottom: 18, boxShadow: '0 1px 3px rgba(14,26,43,.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
              {client.report_logo_url && <img src={client.report_logo_url} alt="" style={{ maxHeight: 40, maxWidth: 140 }} />}
              <h1 style={{ fontSize: 24, margin: 0, color: C.navy }}>{client.name}</h1>
            </div>
            {months.length === 0 ? <p style={{ color: C.muted }}>Your first report will appear here once the baseline audit is complete.</p> : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {months.map((m, i) => (
                  <li key={m} style={{ borderTop: `1px solid ${C.line}` }}>
                    <Link href={`/portal/report/${client.id}/${m}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', color: C.ink, textDecoration: 'none' }}>
                      <span><strong>{monthLabel(m)}</strong>{i === 0 && m === new Date().toISOString().slice(0, 7) ? <span style={{ color: C.muted }}> · month to date</span> : null}</span>
                      <span style={{ color: C.accent, fontWeight: 600 }}>View report →</span>
                    </Link>
                  </li>))}
              </ul>
            )}
          </section>
        ))}
        <section style={{ background: '#fff', borderRadius: 14, padding: '24px 28px', boxShadow: '0 1px 3px rgba(14,26,43,.08)' }}>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Change password</h2>
          <PasswordForm dark={false} />
        </section>
      </div>
    </div>
  )
}
