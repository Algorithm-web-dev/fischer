import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { requireUser, bad, parsePeriod } from '@/lib/api'
import { launchBrowser } from '@/lib/capture'
import { previousPeriod, periodToDate } from '@/lib/snapshots'

export const maxDuration = 120

/**
 * Renders the client report to a PDF with the same headless Chromium used for
 * audits. A short-lived (1 hour) share token is minted so the browser can load
 * the public report page without a session.
 */
export async function GET(req: NextRequest, { params }: { params: { clientId: string } }) {
  const auth = await requireUser(); if (auth.error) return auth.error
  const period = parsePeriod(req.nextUrl.searchParams.get('period')) ?? previousPeriod()

  const { data: client } = await auth.supabase.from('clients').select('name').eq('id', params.clientId).single()
  if (!client) return bad('Client not found.', 404)

  const token = randomBytes(24).toString('base64url')
  const { error } = await auth.supabase.from('report_shares').insert({
    client_id: params.clientId, token, period: periodToDate(period),
    expires_at: new Date(Date.now() + 3600_000).toISOString(), created_by: auth.user.id
  })
  if (error) return bad(error.message, 500)

  const origin = process.env.FISCHER_PUBLIC_URL || req.nextUrl.origin
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1240, height: 1754 })
    await page.goto(`${origin}/report/${token}?print=1`, { waitUntil: 'networkidle0', timeout: 60000 })
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } })
    const filename = `${client.name.replace(/[^a-z0-9]+/gi, '-')}-CRO-report-${period}.pdf`
    return new NextResponse(Buffer.from(pdf), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` }
    })
  } catch (err) {
    return bad(`PDF rendering failed: ${err instanceof Error ? err.message : String(err)}`, 500)
  } finally {
    await browser.close().catch(() => {})
    // The one-off token is no longer needed once the PDF exists.
    await auth.supabase.from('report_shares').update({ revoked: true }).eq('token', token)
  }
}
