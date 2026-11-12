import { z } from 'zod'

/**
 * Page edits ("DOM ops") — the shared format for visual mockups and for live
 * A/B test variants run by the tracking kit. Deliberately small: change text,
 * change markup (sanitised), hide, restyle, insert, set an attribute. No
 * scripts, no event handlers, no javascript: URLs — enforced here on the
 * server and again in the browser (public/fischer-tracking.js).
 */
export const DomOpSchema = z.object({
  selector: z.string().describe('CSS selector of the target element, taken from the element list provided.'),
  action: z.enum(['setText', 'setHtml', 'hide', 'setStyle', 'insertBefore', 'insertAfter', 'setAttribute']),
  value: z.string().describe('New text / sanitised HTML / attribute value. Empty for hide and setStyle.'),
  style: z.array(z.object({ property: z.string(), value: z.string() })).describe('CSS declarations for setStyle (e.g. background-color, font-size). Empty otherwise.'),
  attribute: z.string().describe('Attribute name for setAttribute (e.g. placeholder, href). Empty otherwise.')
})
export type DomOp = z.infer<typeof DomOpSchema>

const ALLOWED_ATTRS = new Set(['placeholder', 'href', 'alt', 'title', 'aria-label', 'type', 'inputmode', 'autocomplete', 'value', 'src', 'target', 'rel'])
const ALLOWED_STYLE = /^(color|background|background-color|font-size|font-weight|line-height|padding|padding-[a-z]+|margin|margin-[a-z]+|border|border-[a-z-]+|border-radius|width|max-width|min-width|height|min-height|display|text-align|text-transform|letter-spacing|box-shadow|position|top|bottom|left|right|z-index|gap|justify-content|align-items|flex-direction|order|opacity)$/

/** Removes scripts, event handlers, iframes and javascript:/data: URLs from an HTML snippet. */
export function sanitizeHtml(html: string): string {
  return String(html)
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href|action|formaction)\s*=\s*("|')\s*(javascript|data|vbscript):[^"']*\2/gi, '$1="#"')
    .slice(0, 5000)
}

/** Validates and sanitises ops before they're stored or served. Returns cleaned ops and rejected ones. */
export function cleanOps(ops: DomOp[]): { ops: DomOp[]; rejected: { op: DomOp; reason: string }[] } {
  const out: DomOp[] = []
  const rejected: { op: DomOp; reason: string }[] = []
  for (const op of ops.slice(0, 20)) {
    if (!op.selector || op.selector.length > 300 || /[<>]/.test(op.selector)) { rejected.push({ op, reason: 'bad selector' }); continue }
    if (op.action === 'setAttribute') {
      const a = op.attribute.toLowerCase()
      if (!ALLOWED_ATTRS.has(a)) { rejected.push({ op, reason: `attribute ${a} not allowed` }); continue }
      if ((a === 'href' || a === 'src') && /^\s*(javascript|data|vbscript):/i.test(op.value)) { rejected.push({ op, reason: 'unsafe URL' }); continue }
    }
    const style = op.action === 'setStyle' ? op.style.filter(s => ALLOWED_STYLE.test(s.property.toLowerCase()) && !/url\(|expression\(|javascript:/i.test(s.value)).slice(0, 15) : []
    if (op.action === 'setStyle' && style.length === 0) { rejected.push({ op, reason: 'no allowed styles' }); continue }
    const value = op.action === 'setHtml' || op.action === 'insertBefore' || op.action === 'insertAfter' ? sanitizeHtml(op.value) : String(op.value ?? '').slice(0, 2000)
    out.push({ ...op, value, style })
  }
  return { ops: out, rejected }
}

/**
 * Browser-side applier, as a string for page.evaluate (mockups). The same
 * logic lives in public/fischer-tracking.js for live tests — keep in sync.
 * Returns per-op results so mockups can report selectors that weren't found.
 */
export function applyOpsScript(ops: DomOp[]): string {
  return `(() => {
    const ops = ${JSON.stringify(ops)};
    const results = [];
    const clean = (html) => { const t = document.createElement('template'); t.innerHTML = html;
      t.content.querySelectorAll('script,style,iframe,object,embed,link,meta,base,form').forEach(n => n.remove());
      t.content.querySelectorAll('*').forEach(el => { for (const a of Array.from(el.attributes)) {
        if (/^on/i.test(a.name) || (/^(href|src|action|formaction|xlink:href)$/i.test(a.name) && /^\\s*(javascript|data|vbscript):/i.test(a.value))) el.removeAttribute(a.name); } });
      return t.content; };
    for (const op of ops) {
      let els = [];
      try { els = Array.from(document.querySelectorAll(op.selector)); } catch (e) { results.push({ selector: op.selector, ok: false, error: 'invalid selector' }); continue; }
      if (!els.length) { results.push({ selector: op.selector, ok: false, error: 'not found' }); continue; }
      const el = els[0];
      if (op.action === 'setText') el.textContent = op.value;
      else if (op.action === 'setHtml') { el.innerHTML = ''; el.appendChild(clean(op.value)); }
      else if (op.action === 'hide') el.style.setProperty('display', 'none', 'important');
      else if (op.action === 'setStyle') op.style.forEach(s => el.style.setProperty(s.property, s.value, 'important'));
      else if (op.action === 'insertBefore') el.parentNode.insertBefore(clean(op.value), el);
      else if (op.action === 'insertAfter') el.parentNode.insertBefore(clean(op.value), el.nextSibling);
      else if (op.action === 'setAttribute') el.setAttribute(op.attribute, op.value);
      results.push({ selector: op.selector, ok: true, top: Math.round(el.getBoundingClientRect().top + window.scrollY) });
    }
    return results;
  })()`
}

/** Collects the editable elements of a page with stable selectors, for the model to target. */
export const ELEMENTS_SCRIPT = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const sel = el => {
    if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id) && document.querySelectorAll('#' + el.id).length === 1) return '#' + el.id;
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.body && parts.length < 6) {
      let p = n.tagName.toLowerCase();
      if (n.id && /^[A-Za-z][\\w-]*$/.test(n.id)) { parts.unshift('#' + n.id); break; }
      const sib = Array.from(n.parentNode.children).filter(c => c.tagName === n.tagName);
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(n) + 1) + ')';
      parts.unshift(p); n = n.parentNode;
    }
    return parts.join(' > ');
  };
  const els = Array.from(document.querySelectorAll('h1,h2,h3,p,a,button,input,select,textarea,label,img,form,li,[role="button"]'))
    .filter(vis).filter(el => !el.closest('footer')).slice(0, 220);
  return els.map((el, i) => ({
    selector: sel(el), tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('alt') || '').trim().replace(/\\s+/g, ' ').slice(0, 90),
    top: Math.round(el.getBoundingClientRect().top + window.scrollY)
  })).filter(e => e.text || ['input', 'img', 'form', 'select', 'textarea'].includes(e.tag));
})()`
