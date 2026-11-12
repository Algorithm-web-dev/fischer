import type { SupabaseClient } from '@supabase/supabase-js'
import { normaliseIndustry } from './benchmarks'
import { TEST_TAGS, tagTest } from './test-tags'

/**
 * Test library — every concluded A/B test across all clients, anonymised and
 * tagged by what it changed. Win rates and typical lifts per tag feed new
 * audits' hypotheses ("in automotive, hero CTA tests won 3 of 4"), so each
 * client's tests make Fischer better for the next one.
 */

export { TEST_TAGS, tagTest } from './test-tags'

export interface LibraryEntry {
  id: string
  industry: string | null
  pageType: string | null
  tags: string[]
  name: string
  change: string
  winner: 'variant' | 'control' | 'none'
  relativeLift: number | null
  confidence: number | null
  endDate: string | null
}

export interface TagSummary { tag: string; label: string; tests: number; wins: number; winRate: number; avgWinningLift: number | null }

/** Pure — unit tested. */
export function summariseLibrary(entries: LibraryEntry[]): TagSummary[] {
  return TEST_TAGS.concat([{ tag: 'other', label: 'Other', re: /$^/ }]).map(t => {
    const list = entries.filter(e => e.tags.includes(t.tag))
    const wins = list.filter(e => e.winner === 'variant')
    const lifts = wins.map(w => w.relativeLift).filter((x): x is number => typeof x === 'number')
    return {
      tag: t.tag, label: t.label, tests: list.length, wins: wins.length,
      winRate: list.length ? Math.round((wins.length / list.length) * 100) : 0,
      avgWinningLift: lifts.length ? Math.round((lifts.reduce((s, x) => s + x, 0) / lifts.length) * 10) / 10 : null
    }
  }).filter(s => s.tests > 0).sort((a, b) => b.tests - a.tests)
}

export async function loadLibrary(supabase: SupabaseClient, filter: { industry?: string | null; tag?: string | null } = {}): Promise<LibraryEntry[]> {
  const [{ data: tests }, { data: clients }, { data: audits }] = await Promise.all([
    supabase.from('test_briefs').select('id, client_id, source_audit_id, hypothesis_name, hypothesis, brief, stats, winner, test_end_date, status')
      .eq('status', 'completed').not('stats', 'is', null).order('test_end_date', { ascending: false }).limit(2000),
    supabase.from('clients').select('id, industry'),
    supabase.from('audits').select('id, page_type').not('page_type', 'is', null).limit(5000)
  ])
  const ind = new Map((clients ?? []).map(c => [c.id, normaliseIndustry(c.industry)]))
  const pageType = new Map((audits ?? []).map(a => [a.id, a.page_type as string]))
  let entries: LibraryEntry[] = (tests ?? []).map(t => {
    const change = t.brief?.variant?.description || t.hypothesis?.variant || ''
    const text = [t.hypothesis_name, t.hypothesis?.hypothesis, change, t.hypothesis?.basedOnIssue].filter(Boolean).join(' ')
    return {
      id: t.id,
      industry: ind.get(t.client_id) ?? null,
      pageType: t.source_audit_id ? pageType.get(t.source_audit_id) ?? null : null,
      tags: tagTest(text),
      name: t.hypothesis_name,
      change: String(change).slice(0, 300),
      winner: (t.winner ?? 'none') as LibraryEntry['winner'],
      relativeLift: t.stats?.relativeLift ?? null,
      confidence: t.stats?.confidence ?? null,
      endDate: t.test_end_date
    }
  })
  const fi = normaliseIndustry(filter.industry)
  if (fi) entries = entries.filter(e => e.industry === fi)
  if (filter.tag) entries = entries.filter(e => e.tags.includes(filter.tag!))
  return entries
}

/** Prompt section for audits: what has worked before (same industry first, then everywhere). */
export async function libraryPromptSection(supabase: SupabaseClient, industry: string | null | undefined): Promise<string> {
  const all = await loadLibrary(supabase)
  if (all.length < 3) return ''
  const fi = normaliseIndustry(industry)
  const same = fi ? all.filter(e => e.industry === fi) : []
  const use = same.length >= 3 ? same : all
  const scope = same.length >= 3 ? `in ${fi}` : 'across all industries'
  const summary = summariseLibrary(use).slice(0, 6)
  const wins = use.filter(e => e.winner === 'variant' && e.relativeLift != null).sort((a, b) => (b.relativeLift ?? 0) - (a.relativeLift ?? 0)).slice(0, 5)
  const losses = use.filter(e => e.winner === 'control').slice(0, 3)
  return `**PAST A/B TEST RESULTS (Algorithm Agency, anonymised, ${use.length} concluded tests ${scope}):**
${summary.map(s => `- ${s.label}: ${s.wins}/${s.tests} won${s.avgWinningLift != null ? `, winners averaged +${s.avgWinningLift}%` : ''}`).join('\n')}
${wins.length ? `Winning examples: ${wins.map(w => `"${w.name}" (+${w.relativeLift}%)`).join('; ')}.` : ''}
${losses.length ? `Ideas that lost: ${losses.map(l => `"${l.name}"`).join('; ')}.` : ''}
Use this to prioritise and estimate your test hypotheses — prefer change types with a good track record, and set expectedLiftPct in line with past winners. Only propose a test if this page's own evidence supports it.`
}
