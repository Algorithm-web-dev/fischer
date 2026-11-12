import type { Page } from 'puppeteer-core'

/**
 * Accessibility check with axe-core (WCAG 2.1 A/AA rules) during capture.
 * Accessibility problems are conversion problems too: low-contrast buttons,
 * unlabelled form fields and unreachable controls lose real visitors — and
 * some clients have compliance obligations.
 */
export interface A11yViolation {
  id: string
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null
  help: string
  helpUrl: string
  nodes: number
  examples: string[]      // up to 3 CSS targets
}

export interface A11ySummary {
  checkedAt: string
  violations: A11yViolation[]
  counts: { critical: number; serious: number; moderate: number; minor: number }
  passes: number
}

export async function runAxe(page: Page): Promise<A11ySummary | null> {
  try {
    const axe = (await import('axe-core')).default as unknown as { source: string }
    await page.evaluate(axe.source)
    const raw = (await page.evaluate(`axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      resultTypes: ['violations'], iframes: false
    }).then(r => ({ violations: r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl,
      nodes: v.nodes.length, examples: v.nodes.slice(0, 3).map(n => (n.target || []).join(' ')) })), passes: r.passes.length }))`)) as { violations: A11yViolation[]; passes: number }
    return summarise(raw.violations, raw.passes)
  } catch {
    return null
  }
}

/** Pure — unit tested. */
export function summarise(violations: A11yViolation[], passes: number): A11ySummary {
  const order = { critical: 0, serious: 1, moderate: 2, minor: 3 } as Record<string, number>
  const sorted = violations.slice().sort((a, b) => (order[a.impact ?? 'minor'] ?? 4) - (order[b.impact ?? 'minor'] ?? 4) || b.nodes - a.nodes)
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 }
  for (const v of sorted) if (v.impact) counts[v.impact] += v.nodes
  return { checkedAt: new Date().toISOString(), violations: sorted.slice(0, 25), counts, passes }
}

export function formatA11yForPrompt(a: A11ySummary): string {
  if (!a.violations.length) return '**ACCESSIBILITY (axe-core, WCAG 2.1 AA):** no violations found.'
  return `**ACCESSIBILITY (axe-core, WCAG 2.1 AA, desktop):** ${a.counts.critical} critical, ${a.counts.serious} serious, ${a.counts.moderate} moderate issue instances.
${a.violations.slice(0, 10).map(v => `- [${v.impact}] ${v.help} — ${v.nodes} element(s), e.g. ${v.examples[0] ?? ''}`).join('\n')}
Raise as findings only those that plausibly cost conversions (e.g. low-contrast CTA, unlabelled form fields, buttons without names) — evidence source "accessibility".`
}
