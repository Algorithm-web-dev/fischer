import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { buildMonthlyReport } from '@/lib/report'
import { ReportView } from '@/components/ReportView'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const metadata: Metadata = {
  title: 'Conversion Report',
  robots: { index: false, follow: false }
}

/**
 * Public, client-facing monthly report. Access is by unguessable token only
 * (created by POST /api/reports/[clientId]); revoked or expired tokens 404.
 */
export default async function ReportPage({ params, searchParams }: { params: { token: string }; searchParams: { print?: string } }) {
  const supabase = createSupabaseServiceClient()
  const { data: share } = await supabase.from('report_shares')
    .select('client_id, period, revoked, expires_at').eq('token', params.token).single()

  if (!share || share.revoked || (share.expires_at && new Date(share.expires_at) < new Date())) notFound()

  const report = await buildMonthlyReport(supabase, share.client_id, String(share.period).slice(0, 7))
  return <ReportView report={report} print={searchParams.print === '1'} />
}
