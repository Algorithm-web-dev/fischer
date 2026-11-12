import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createSupabaseServerClient, createSupabaseServiceClient } from '@/lib/supabase'
import { buildMonthlyReport } from '@/lib/report'
import { ReportView } from '@/components/ReportView'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** A client portal user's monthly report. Access is checked with their own session (RLS) before building. */
export default async function PortalReport({ params }: { params: { clientId: string; period: string } }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(params.period)) notFound()
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')
  // RLS: returns the row only if this login may see this client
  const { data: client } = await supabase.from('clients').select('id').eq('id', params.clientId).maybeSingle()
  if (!client) notFound()

  const report = await buildMonthlyReport(createSupabaseServiceClient(), client.id, params.period)
  return (
    <div>
      <div style={{ background: '#F6F8FB', padding: '14px 16px 0', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ maxWidth: 980, margin: '0 auto' }}><Link href="/portal" style={{ color: '#5B6B80', fontSize: 14 }}>← All reports</Link></div>
      </div>
      <ReportView report={report} />
    </div>
  )
}
