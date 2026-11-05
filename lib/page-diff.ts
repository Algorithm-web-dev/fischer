import type { ScrapedContent } from './scraper'
import type { LayoutFacts } from './capture'

/**
 * A compact, comparable snapshot of what a page shows — stored with every
 * audit so that month-to-month we can say objectively whether the page
 * changed (and what), independent of what the model says.
 */
export interface PageFingerprint {
  title: string
  h1: string | null
  headings: string[]
  ctas: string[]
  aboveFoldCtasDesktop: string[]
  aboveFoldCtasMobile: string[]
  formFieldCount: number
  forms: { fields: number; submit: string }[]
  wordCount: number
  trustSignalCount: number
  imageCount: number
  pageHeightDesktop: number | null
}

export interface PageChange {
  field: string
  label: string
  before: string
  after: string
}

export interface PageDiff {
  changed: boolean
  significant: boolean     // a change a visitor would notice (H1, CTA, form, title)
  changes: PageChange[]
  summary: string
}

export function fingerprintPage(
  content: ScrapedContent | null,
  desktop?: LayoutFacts,
  mobile?: LayoutFacts
): PageFingerprint {
  return {
    title: clean(content?.title || ''),
    h1: desktop?.h1AboveFold ?? content?.headings.find(h => h.level === 'h1')?.text ?? null,
    headings: (content?.headings ?? []).map(h => clean(h.text)).slice(0, 30),
    ctas: uniq((content?.ctaButtons ?? []).map(clean)).slice(0, 25),
    aboveFoldCtasDesktop: uniq((desktop?.ctasAboveFold ?? []).map(c => clean(c.text))),
    aboveFoldCtasMobile: uniq((mobile?.ctasAboveFold ?? []).map(c => clean(c.text))),
    formFieldCount: desktop?.formFieldCount ?? (content?.forms ?? []).reduce((s, f) => s + f.fieldCount, 0),
    forms: (content?.forms ?? []).map(f => ({ fields: f.fieldCount, submit: clean(f.submitText) })),
    wordCount: content?.wordCount ?? 0,
    trustSignalCount: content?.trustSignals.length ?? 0,
    imageCount: content?.imageCount ?? 0,
    pageHeightDesktop: desktop?.pageHeight ?? null
  }
}

export function diffFingerprints(prev: PageFingerprint | null | undefined, curr: PageFingerprint): PageDiff {
  if (!prev) return { changed: false, significant: false, changes: [], summary: 'First capture of this page — nothing to compare yet.' }

  const changes: PageChange[] = []
  const push = (field: string, label: string, before: unknown, after: unknown) =>
    changes.push({ field, label, before: String(before ?? '—'), after: String(after ?? '—') })

  if (norm(prev.title) !== norm(curr.title)) push('title', 'Page title', prev.title, curr.title)
  if (norm(prev.h1 || '') !== norm(curr.h1 || '')) push('h1', 'Main headline (H1)', prev.h1, curr.h1)

  const listDiff = (field: string, label: string, a: string[], b: string[]) => {
    const A = new Set(a.map(norm)), B = new Set(b.map(norm))
    const added = b.filter(x => !A.has(norm(x)))
    const removed = a.filter(x => !B.has(norm(x)))
    if (added.length) push(field + '_added', `${label} added`, '', added.join(' | '))
    if (removed.length) push(field + '_removed', `${label} removed`, removed.join(' | '), '')
  }
  listDiff('above_fold_cta_desktop', 'Above-the-fold CTA (desktop)', prev.aboveFoldCtasDesktop, curr.aboveFoldCtasDesktop)
  listDiff('above_fold_cta_mobile', 'Above-the-fold CTA (mobile)', prev.aboveFoldCtasMobile, curr.aboveFoldCtasMobile)
  listDiff('headings', 'Section heading', prev.headings, curr.headings)
  listDiff('ctas', 'Button/link', prev.ctas, curr.ctas)

  if (prev.formFieldCount !== curr.formFieldCount) push('form_fields', 'Visible form fields', prev.formFieldCount, curr.formFieldCount)
  const subA = prev.forms.map(f => f.submit).join(' | '), subB = curr.forms.map(f => f.submit).join(' | ')
  if (norm(subA) !== norm(subB)) push('form_submit', 'Form submit button text', subA, subB)

  if (relChange(prev.wordCount, curr.wordCount) > 0.2) push('word_count', 'Amount of copy (words)', prev.wordCount, curr.wordCount)
  if (prev.trustSignalCount !== curr.trustSignalCount && Math.abs(prev.trustSignalCount - curr.trustSignalCount) >= 2) {
    push('trust', 'Trust signals found in text', prev.trustSignalCount, curr.trustSignalCount)
  }
  if (prev.pageHeightDesktop && curr.pageHeightDesktop && relChange(prev.pageHeightDesktop, curr.pageHeightDesktop) > 0.15) {
    push('page_height', 'Page length (desktop px)', prev.pageHeightDesktop, curr.pageHeightDesktop)
  }

  const significantFields = ['title', 'h1', 'above_fold_cta_desktop_added', 'above_fold_cta_desktop_removed',
    'above_fold_cta_mobile_added', 'above_fold_cta_mobile_removed', 'form_fields', 'form_submit']
  const significant = changes.some(c => significantFields.includes(c.field))

  const summary = changes.length === 0
    ? 'No visible changes detected since the previous audit.'
    : `${changes.length} change(s) detected: ${changes.slice(0, 4).map(c => c.label).join(', ')}${changes.length > 4 ? '…' : ''}.`

  return { changed: changes.length > 0, significant, changes, summary }
}

function clean(s: string) { return s.replace(/\s+/g, ' ').trim() }
function norm(s: string) { return clean(s).toLowerCase() }
function uniq(a: string[]) { return Array.from(new Set(a.filter(Boolean))) }
function relChange(a: number, b: number) { return a === 0 ? (b === 0 ? 0 : 1) : Math.abs(b - a) / a }
