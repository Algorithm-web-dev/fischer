import { randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildMonthlyReport, type MonthlyReport } from './report'
import { periodToDate } from './snapshots'

/**
 * Monthly report emails, sent with Resend (RESEND_API_KEY; the From address
 * must be on a domain verified in Resend — set it in Admin → Branding).
 * The email is a short summary with a link to the full report (a share link
 * valid for 60 days), so nothing large or sensitive sits in inboxes.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export function isEmail(s: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) }

/** Pure — unit tested. */
export function reportEmailHtml(r: MonthlyReport, url: string): { subject: string; html: string; text: string } {
  const b = r.branding
  const k = r.kpis
  const pct = (v: number | null) => v == null ? '' : ` (${v > 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(1)}%)`
  const lines: [string, string][] = []
  if (k.conversionRate.current != null) lines.push(['Conversion rate', `${k.conversionRate.current.toFixed(2)}%${pct(k.conversionRate.changePct)}`])
  if (k.conversions.current != null) lines.push(['Conversions', `${k.conversions.current.toLocaleString('en-ZA')}${pct(k.conversions.changePct)}`])
  if (k.avgFischerScore.current != null) lines.push(['Fischer Score', `${k.avgFischerScore.current}/100`])
  lines.push(['Changes made', String(r.changes.length)])
  if (r.tests.length) lines.push(['A/B tests', String(r.tests.length)])
  const subject = `${r.client.name} — conversion report, ${r.periodLabel}`
  const rows = lines.map(([l, v]) => `<tr><td style="padding:6px 0;color:#5B6B80">${esc(l)}</td><td style="padding:6px 0;text-align:right;font-weight:700">${esc(v)}</td></tr>`).join('')
  const html = `<!doctype html><html><body style="margin:0;background:#F6F8FB;font-family:Arial,Helvetica,sans-serif;color:#0E1A2B">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:12px;padding:28px">
<tr><td>${b.logoUrl ? `<img src="${esc(b.logoUrl)}" alt="${esc(b.agencyName)}" style="max-height:32px;margin-bottom:16px">` : ''}
<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${b.accentColor};font-weight:700">Conversion report · ${esc(r.periodLabel)}</div>
<h1 style="font-size:22px;margin:6px 0 16px;color:${b.primaryColor}">${esc(r.client.name)}</h1>
<table role="presentation" width="100%" style="font-size:14px;border-top:1px solid #E3E8EF;border-bottom:1px solid #E3E8EF;margin-bottom:20px">${rows}</table>
${r.pages[0]?.summary ? `<p style="font-size:14px;line-height:1.6;margin:0 0 20px">${esc(r.pages[0].summary)}</p>` : ''}
<a href="${esc(url)}" style="display:inline-block;background:${b.primaryColor};color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700">View the full report</a>
<p style="font-size:12px;color:#5B6B80;margin-top:24px">${esc(b.agencyName)}${r.client.contactName ? ` · Questions? Reply to this email or contact ${esc(r.client.contactName)}` : ''}</p>
</td></tr></table></td></tr></table></body></html>`
  const text = `${subject}\n\n${lines.map(([l, v]) => `${l}: ${v}`).join('\n')}\n\nFull report: ${url}\n\n${b.agencyName}`
  return { subject, html, text }
}

export async function sendReportEmail(service: SupabaseClient, params: { clientId: string; period: string; recipients?: string[]; userId?: string | null; origin: string }) {
  const { data: client } = await service.from('clients').select('id, name, report_recipients').eq('id', params.clientId).single()
  if (!client) throw new Error('Client not found.')
  const to = (params.recipients ?? client.report_recipients ?? []).map((e: string) => e.trim()).filter(isEmail)
  if (!to.length) throw new Error('No valid report recipients set for this client.')
  if (!process.env.RESEND_API_KEY) throw new Error('Email is not set up: add RESEND_API_KEY.')

  const report = await buildMonthlyReport(service, params.clientId, params.period)
  if (!report.branding.emailFrom) throw new Error('Set the "From" address in Admin → Branding (a domain verified in Resend).')

  const token = randomBytes(24).toString('base64url')
  await service.from('report_shares').insert({
    client_id: params.clientId, token, period: periodToDate(params.period),
    expires_at: new Date(Date.now() + 60 * 86400000).toISOString(), created_by: params.userId ?? null
  })
  const url = `${params.origin}/report/${token}`
  const { subject, html, text } = reportEmailHtml(report, url)

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: report.branding.emailFrom, to, subject, html, text, reply_to: report.branding.emailReplyTo ?? undefined })
  })
  const ok = res.ok
  const error = ok ? null : `${res.status}: ${(await res.text()).slice(0, 300)}`
  await service.from('report_emails').insert({
    client_id: params.clientId, period: periodToDate(params.period), recipients: to,
    status: ok ? 'sent' : 'failed', error, share_token: token, sent_by: params.userId ?? null
  })
  if (!ok) throw new Error(`Email failed — ${error}`)
  return { sentTo: to, url }
}
