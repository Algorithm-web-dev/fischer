import type { SupabaseClient } from '@supabase/supabase-js'

/** Agency-wide branding for client reports and emails (agency_settings, single row). */
export interface Branding {
  agencyName: string
  logoUrl: string | null
  primaryColor: string
  accentColor: string
  footer: string | null
  showFischerName: boolean
  emailFrom: string | null
  emailReplyTo: string | null
}

export const DEFAULT_BRANDING: Branding = {
  agencyName: 'Algorithm Agency', logoUrl: null, primaryColor: '#0B1F3A', accentColor: '#C98A00',
  footer: null, showFischerName: true, emailFrom: null, emailReplyTo: null
}

const HEX = /^#[0-9a-f]{6}$/i

export async function getBranding(supabase: SupabaseClient): Promise<Branding> {
  const { data } = await supabase.from('agency_settings').select('*').eq('id', 1).maybeSingle()
  if (!data) return DEFAULT_BRANDING
  return {
    agencyName: data.agency_name || DEFAULT_BRANDING.agencyName,
    logoUrl: data.logo_url || null,
    primaryColor: HEX.test(data.primary_color) ? data.primary_color : DEFAULT_BRANDING.primaryColor,
    accentColor: HEX.test(data.accent_color) ? data.accent_color : DEFAULT_BRANDING.accentColor,
    footer: data.report_footer || null,
    showFischerName: data.show_fischer_name !== false,
    emailFrom: data.email_from || null,
    emailReplyTo: data.email_reply_to || null
  }
}

/** Validates a settings update; returns DB columns or an error string. Pure — unit tested. */
export function brandingUpdate(b: Record<string, unknown>): Record<string, unknown> | string {
  const u: Record<string, unknown> = {}
  const str = (v: unknown, max: number) => (v == null || v === '' ? null : String(v).slice(0, max))
  if (b.agencyName !== undefined) { if (!String(b.agencyName).trim()) return 'Agency name is required.'; u.agency_name = String(b.agencyName).trim().slice(0, 80) }
  if (b.logoUrl !== undefined) { const v = str(b.logoUrl, 500); if (v && !/^https:\/\//.test(v)) return 'Logo URL must start with https://'; u.logo_url = v }
  for (const [k, col] of [['primaryColor', 'primary_color'], ['accentColor', 'accent_color']] as const) {
    if (b[k] !== undefined) { if (!HEX.test(String(b[k]))) return `${k} must be a hex colour like #0B1F3A.`; u[col] = String(b[k]) }
  }
  if (b.footer !== undefined) u.report_footer = str(b.footer, 200)
  if (b.showFischerName !== undefined) u.show_fischer_name = !!b.showFischerName
  if (b.emailFrom !== undefined) u.email_from = str(b.emailFrom, 200)
  if (b.emailReplyTo !== undefined) { const v = str(b.emailReplyTo, 200); if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'Reply-to must be an email address.'; u.email_reply_to = v }
  u.updated_at = new Date().toISOString()
  return u
}
