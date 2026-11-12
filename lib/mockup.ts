import { z } from 'zod'
import { launchBrowser, dismissOverlays, VIEWPORTS, type ViewportName } from './capture'
import { structuredCall, type UsageTag } from './llm'
import { DomOpSchema, cleanOps, applyOpsScript, ELEMENTS_SCRIPT, type DomOp } from './dom-ops'

/**
 * Visual mockup of a recommended change: Fischer opens the live page, asks the
 * model for precise page edits (DomOps) that implement the fix, applies them
 * in the browser, and screenshots before and after at the same position.
 * The same ops can then run as a live A/B variant via the tracking kit.
 */
const MockupSchema = z.object({
  ops: z.array(DomOpSchema).describe('1–8 edits that implement the change. Use selectors from the element list exactly.'),
  summary: z.string().describe('One sentence describing the change as a visitor would see it.'),
  notPossible: z.string().describe('Empty, or why this change cannot be shown with page edits (e.g. it needs a new page or backend work).')
})

export interface MockupResult {
  ops: DomOp[]
  summary: string
  notPossible: string | null
  applied: { selector: string; ok: boolean; error?: string; top?: number }[]
  viewport: ViewportName
  scrollY: number
  before: string | null   // base64 JPEG
  after: string | null
}

export async function generateMockup(params: {
  url: string
  viewport: ViewportName
  change: string              // the fix / variant to implement, in words
  context?: string            // issue + evidence, exact copy suggestions
  existingOps?: DomOp[]       // re-render known ops without asking the model
  track?: UsageTag
}): Promise<MockupResult> {
  const cfg = VIEWPORTS[params.viewport]
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setUserAgent(cfg.userAgent)
    await page.setViewport({ width: cfg.width, height: cfg.height, deviceScaleFactor: 1, isMobile: cfg.isMobile, hasTouch: cfg.isMobile })
    await page.goto(params.url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(async err => {
      const len = await page.evaluate('document.body ? document.body.innerText.length : 0').catch(() => 0)
      if (!len) throw err
    })
    await new Promise(r => setTimeout(r, 900))
    await dismissOverlays(page)

    let ops: DomOp[]
    let summary = ''
    let notPossible: string | null = null
    if (params.existingOps?.length) {
      ops = cleanOps(params.existingOps).ops
    } else {
      const elements = (await page.evaluate(ELEMENTS_SCRIPT)) as { selector: string; tag: string; text: string; top: number }[]
      const shot = Buffer.from(await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64')
      const out = await structuredCall({
        schema: MockupSchema,
        system: 'You turn a CRO recommendation into precise edits on a live web page. Use only selectors from the element list. Keep the site\'s style; change only what the recommendation requires. Write real, final copy — never placeholders.',
        content: [
          { type: 'text', text: `Above-the-fold ${params.viewport} screenshot of ${params.url}:` },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot } },
          { type: 'text', text: `CHANGE TO MAKE:\n${params.change}\n\n${params.context ? `CONTEXT:\n${params.context}\n\n` : ''}EDITABLE ELEMENTS (selector | tag | text | y position):\n${elements.map(e => `${e.selector} | ${e.tag} | ${e.text} | y=${e.top}`).join('\n')}\n\nActions: setText (replace text), setHtml (replace inner HTML — simple tags only), hide, setStyle (CSS declarations), insertBefore / insertAfter (new HTML next to the element), setAttribute (placeholder, href, type, alt…). If the change can't be expressed as edits, explain in notPossible and return no ops.` }
        ],
        maxTokens: 8000,
        effort: 'medium',
        track: params.track ?? { feature: 'mockup' }
      })
      const cleaned = cleanOps(out.ops)
      ops = cleaned.ops
      summary = out.summary
      notPossible = out.notPossible?.trim() || null
    }

    if (ops.length === 0) return { ops, summary, notPossible: notPossible ?? 'No applicable edits.', applied: [], viewport: params.viewport, scrollY: 0, before: null, after: null }

    // Find where the first target is, so before/after show the changed area.
    const tops = (await page.evaluate(`(${JSON.stringify(ops.map(o => o.selector))}).map(s => { try { const el = document.querySelector(s); return el ? el.getBoundingClientRect().top + window.scrollY : null } catch { return null } })`)) as (number | null)[]
    const firstTop = Math.min(...tops.filter((t): t is number => t != null), Number.MAX_SAFE_INTEGER)
    const y = firstTop === Number.MAX_SAFE_INTEGER ? 0 : Math.max(0, Math.round(firstTop - cfg.height * 0.25))
    const clip = { x: 0, y, width: cfg.width, height: cfg.height }
    const before = Buffer.from(await page.screenshot({ type: 'jpeg', quality: 75, clip, captureBeyondViewport: true })).toString('base64')
    const applied = (await page.evaluate(applyOpsScript(ops))) as MockupResult['applied']
    await new Promise(r => setTimeout(r, 300))
    const after = Buffer.from(await page.screenshot({ type: 'jpeg', quality: 75, clip, captureBeyondViewport: true })).toString('base64')
    return { ops, summary, notPossible, applied, viewport: params.viewport, scrollY: y, before, after }
  } finally {
    await browser.close().catch(() => {})
  }
}
