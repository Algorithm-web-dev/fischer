import type { Page } from 'puppeteer-core'
import { launchBrowser, VIEWPORTS } from './capture'

/**
 * Journey walk-through — Fischer's browser behaves like a mobile visitor.
 *
 * Lead journey: load page → tap the main CTA → find the form → inspect it
 *   (field types, labels, required/validation, tap sizes, CAPTCHA, contact
 *   links). NEVER submits — no junk leads reach the client.
 * E-commerce journey (start on a product page): add to cart → cart →
 *   checkout page → check guest checkout, shipping visibility, payment
 *   options. NEVER enters payment details. (The only side effect is an item
 *   in an anonymous session cart.)
 *
 * Run weekly by /api/cron/journeys; a failure that wasn't there last week
 * raises an alert. Broken forms are the most common silent lead killer.
 */

export type JourneyKind = 'lead' | 'ecommerce'

export interface JourneyStep {
  name: string
  ok: boolean
  detail: string
  url?: string
  screenshot?: string   // base64 JPEG (viewport only), uploaded by the caller
}

export interface JourneyIssue { severity: 'high' | 'medium' | 'low'; code: string; message: string; fix: string }

export interface FormInspection {
  fieldCount: number
  requiredCount: number
  fields: { name: string; type: string; hasLabel: boolean; autocomplete: string | null; height: number; required: boolean }[]
  submitText: string | null
  submitVisible: boolean
  html5Validation: boolean      // empty required fields are rejected by the browser
  noValidate: boolean
  captcha: boolean
}

export interface JourneyResult {
  kind: JourneyKind
  startUrl: string
  viewport: 'mobile'
  ranAt: string
  steps: JourneyStep[]
  form: FormInspection | null
  contact: { tel: boolean; whatsapp: boolean; email: boolean }
  checkout: { reached: boolean; guestCheckout: boolean | null; forcedLogin: boolean | null; shippingShown: boolean | null; paymentMethods: string[] } | null
  consoleErrors: string[]
  issues: JourneyIssue[]
  passed: boolean               // no high-severity issues
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function runJourney(url: string, kind: JourneyKind): Promise<JourneyResult> {
  const browser = await launchBrowser()
  const cfg = VIEWPORTS.mobile
  const consoleErrors: string[] = []
  const steps: JourneyStep[] = []
  const result: JourneyResult = {
    kind, startUrl: url, viewport: 'mobile', ranAt: new Date().toISOString(), steps, form: null,
    contact: { tel: false, whatsapp: false, email: false }, checkout: null, consoleErrors, issues: [], passed: false
  }
  try {
    const page = await browser.newPage()
    page.on('pageerror', e => { if (consoleErrors.length < 15) consoleErrors.push(String((e as Error)?.message ?? e).slice(0, 200)) })
    await page.setUserAgent(cfg.userAgent)
    await page.setViewport({ width: cfg.width, height: cfg.height, deviceScaleFactor: 1, isMobile: true, hasTouch: true })

    // 1. Load
    const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null)
    const status = res?.status()
    const loaded = !!status && status < 400
    steps.push({ name: 'Load page', ok: loaded, detail: loaded ? `HTTP ${status}` : `Page failed to load (${status ?? 'timeout'})`, url: page.url(), screenshot: await shot(page) })
    if (!loaded) return finish(result)
    await sleep(800)
    await page.evaluate(ACCEPT_COOKIES).catch(() => {})
    await sleep(400)

    result.contact = await page.evaluate(CONTACT_SCRIPT) as JourneyResult['contact']

    if (kind === 'lead') await leadJourney(page, result)
    else await ecommerceJourney(page, result)
  } catch (err) {
    steps.push({ name: 'Journey', ok: false, detail: `Journey crashed: ${err instanceof Error ? err.message : String(err)}` })
  } finally {
    await browser.close().catch(() => {})
  }
  return finish(result)
}

async function leadJourney(page: Page, result: JourneyResult) {
  // Is there already a form on the page?
  let form = (await page.evaluate(FORM_SCRIPT)) as FormInspection | null
  if (!form) {
    // 2. Tap the main CTA
    const cta = (await page.evaluate(MAIN_CTA_SCRIPT)) as { text: string; href: string | null; index: number } | null
    if (!cta) {
      result.steps.push({ name: 'Find main CTA', ok: false, detail: 'No call-to-action button found on the page.' })
      return
    }
    if (cta.href && /^(tel:|mailto:)|wa\.me|whatsapp/i.test(cta.href)) {
      result.steps.push({ name: 'Main CTA', ok: true, detail: `Main CTA "${cta.text}" opens ${cta.href.split(':')[0]} — no form journey to test.` })
      return
    }
    const before = page.url()
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => null),
      page.evaluate(`(() => { const el = window.__fischerCtas[${cta.index}]; el.scrollIntoView({block:'center'}); el.click(); })()`)
    ])
    await sleep(1200)
    const after = page.url()
    const status = await page.evaluate('document.title').catch(() => '')
    const notFound = /404|not found|page not found/i.test(String(status))
    result.steps.push({
      name: `Tap "${cta.text}"`, ok: !notFound,
      detail: notFound ? `The CTA leads to an error page (${after}).` : after !== before ? `Opened ${after}` : 'Opened on the same page (modal or scroll).',
      url: after, screenshot: await shot(page)
    })
    if (notFound) return
    form = (await page.evaluate(FORM_SCRIPT)) as FormInspection | null
  }

  if (!form) {
    result.steps.push({ name: 'Find form', ok: false, detail: 'No visible form found after following the main CTA.' })
    return
  }
  result.form = form
  await page.evaluate(`(() => { const f = window.__fischerForm; if (f) f.scrollIntoView({block:'start'}); })()`)
  await sleep(400)
  result.steps.push({
    name: 'Inspect form', ok: form.submitVisible,
    detail: `${form.fieldCount} fields (${form.requiredCount} required), submit "${form.submitText ?? '?'}"${form.captcha ? ', CAPTCHA present' : ''}. Not submitted.`,
    url: page.url(), screenshot: await shot(page)
  })
}

async function ecommerceJourney(page: Page, result: JourneyResult) {
  const added = (await page.evaluate(ADD_TO_CART_SCRIPT)) as { clicked: boolean; text: string | null; needsOption: boolean }
  if (!added.clicked) {
    result.steps.push({ name: 'Add to cart', ok: false, detail: added.needsOption ? 'Add-to-cart needs a size/variant choice that could not be made automatically.' : 'No add-to-cart button found — start this journey on a product page.' })
    return
  }
  await sleep(2500)
  result.steps.push({ name: `Tap "${added.text}"`, ok: true, detail: 'Added to cart.', url: page.url(), screenshot: await shot(page) })

  // Go to checkout: checkout button (cart drawer) → cart link → common cart URLs.
  // Only count it as reached when a page that is actually a checkout loads OK.
  const clickAndWait = async (script: string) => {
    const [resp, clicked] = await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 }).catch(() => null),
      page.evaluate(script).catch(() => false)
    ])
    await sleep(800)
    return { clicked: !!clicked, status: resp ? resp.status() : 200 }
  }
  const isCheckout = async (status: number) => {
    if (status >= 400) return false
    const title = String(await page.evaluate('document.title').catch(() => ''))
    return /checkout/i.test(page.url()) && !/404|not found/i.test(title)
  }

  let reached = false
  let r = await clickAndWait(CHECKOUT_BUTTON_SCRIPT)
  if (r.clicked) reached = await isCheckout(r.status)
  if (!reached) {
    const cart = await clickAndWait(CART_LINK_SCRIPT)
    if (cart.clicked && cart.status < 400) {
      r = await clickAndWait(CHECKOUT_BUTTON_SCRIPT)
      if (r.clicked) reached = await isCheckout(r.status)
    }
  }
  for (const path of ['/cart', '/basket']) {
    if (reached) break
    const resp = await page.goto(new URL(page.url()).origin + path, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null)
    if (!resp || resp.status() >= 400) continue
    r = await clickAndWait(CHECKOUT_BUTTON_SCRIPT)
    if (r.clicked) reached = await isCheckout(r.status)
  }
  const facts = (await page.evaluate(CHECKOUT_FACTS_SCRIPT)) as { guest: boolean; forcedLogin: boolean; shipping: boolean; payments: string[] }
  result.checkout = { reached, guestCheckout: reached ? facts.guest : null, forcedLogin: reached ? facts.forcedLogin : null, shippingShown: reached ? facts.shipping : null, paymentMethods: facts.payments }
  result.steps.push({ name: 'Reach checkout', ok: reached, detail: reached ? `Checkout loaded (${page.url()}). Stopped before entering any details.` : 'Could not reach a checkout page from the cart.', url: page.url(), screenshot: await shot(page) })
}

async function shot(page: Page): Promise<string | undefined> {
  try { return Buffer.from(await page.screenshot({ type: 'jpeg', quality: 65 })).toString('base64') } catch { return undefined }
}

/** Pure: issues from a finished journey. Unit tested. */
export function journeyIssues(r: Omit<JourneyResult, 'issues' | 'passed'>): JourneyIssue[] {
  const issues: JourneyIssue[] = []
  const add = (severity: JourneyIssue['severity'], code: string, message: string, fix: string) => issues.push({ severity, code, message, fix })
  for (const s of r.steps) if (!s.ok) add('high', `step_failed:${s.name}`, `${s.name}: ${s.detail}`, 'Fix this step — visitors hit the same wall.')

  const f = r.form
  if (r.kind === 'lead' && f) {
    if (!f.submitVisible) add('high', 'submit_hidden', 'The form has no visible submit button on mobile.', 'Make the submit button visible and reachable without horizontal scrolling.')
    if (f.fieldCount > 6) add('medium', 'too_many_fields', `The form asks for ${f.fieldCount} fields.`, 'Cut to the minimum needed to make first contact (usually name, phone/email, one qualifier) or split into two steps.')
    const unlabeled = f.fields.filter(x => !x.hasLabel)
    if (unlabeled.length) add('medium', 'missing_labels', `${unlabeled.length} field(s) rely on placeholder text only (${unlabeled.slice(0, 3).map(x => x.name).join(', ')}).`, 'Add visible labels; placeholders disappear as soon as someone starts typing.')
    const phone = f.fields.find(x => /phone|tel|mobile|cell/i.test(x.name))
    if (phone && phone.type !== 'tel') add('medium', 'phone_keyboard', `The phone field "${phone.name}" opens the text keyboard instead of the number pad.`, 'Use type="tel" on phone fields.')
    const email = f.fields.find(x => /e-?mail/i.test(x.name))
    if (email && email.type !== 'email') add('low', 'email_keyboard', `The email field "${email.name}" isn't type="email".`, 'Use type="email" so mobile shows the @ keyboard and browsers can autofill.')
    if (f.fields.every(x => !x.autocomplete)) add('low', 'no_autocomplete', 'No fields use autocomplete attributes, so browsers can\'t autofill.', 'Add autocomplete="name", "email", "tel" etc.')
    const small = f.fields.filter(x => x.height > 0 && x.height < 40)
    if (small.length) add('medium', 'small_fields', `${small.length} field(s) are under 40px tall — hard to tap on a phone.`, 'Make inputs at least 44px tall on mobile.')
    if (f.requiredCount === 0 && !f.html5Validation) add('low', 'no_validation', 'No required fields or browser validation — empty or junk submissions may get through (unless validated by script).', 'Mark the essential fields required and validate inline.')
    if (f.captcha) add('low', 'captcha', 'A visible CAPTCHA adds friction to every submission.', 'Prefer invisible reCAPTCHA v3/Turnstile or a honeypot.')
  }
  if (r.kind === 'lead' && !r.contact.tel && !r.contact.whatsapp) {
    add('medium', 'no_quick_contact', 'No tappable phone number or WhatsApp link on the page.', 'Add a tel: link and a WhatsApp button — many mobile visitors prefer them to forms.')
  }
  if (r.checkout?.reached) {
    if (r.checkout.forcedLogin && !r.checkout.guestCheckout) add('high', 'forced_login', 'Checkout requires creating an account or logging in.', 'Offer guest checkout — forced registration is one of the top causes of checkout abandonment.')
    if (r.checkout.shippingShown === false) add('medium', 'shipping_hidden', 'Shipping cost is not visible at the start of checkout.', 'Show delivery cost (or "free delivery over R…") on the product page and cart.')
  }
  if (r.consoleErrors.length >= 3) add('medium', 'js_errors', `${r.consoleErrors.length} JavaScript errors during the journey (e.g. "${r.consoleErrors[0]}").`, 'Fix the errors — they often break forms or tracking on some devices.')
  return issues.sort((a, b) => ['high', 'medium', 'low'].indexOf(a.severity) - ['high', 'medium', 'low'].indexOf(b.severity))
}

function finish(r: JourneyResult): JourneyResult {
  r.issues = journeyIssues(r)
  r.passed = !r.issues.some(i => i.severity === 'high')
  return r
}

// ---------------------------------------------------------------- browser scripts (strings: see capture.ts)

const ACCEPT_COOKIES = `(() => {
  const s = document.querySelector('#onetrust-accept-btn-handler, #CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll');
  if (s) return s.click();
  const words = ['accept all', 'accept cookies', 'allow all', 'i agree', 'agree', 'accept', 'got it'];
  for (const el of document.querySelectorAll('button, [role="button"]')) {
    const t = (el.innerText || '').trim().toLowerCase();
    if (words.includes(t) && el.offsetParent !== null) return el.click();
  }
})()`

const CONTACT_SCRIPT = `(() => {
  const hrefs = Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href') || '');
  return { tel: hrefs.some(h => /^tel:/i.test(h)), whatsapp: hrefs.some(h => /wa\\.me|whatsapp/i.test(h)), email: hrefs.some(h => /^mailto:/i.test(h)) };
})()`

const MAIN_CTA_SCRIPT = `(() => {
  const words = /(quote|book|contact|enquire|inquire|get started|apply|request|call|sign ?up|register|demo|trial|start|get in touch|talk to)/i;
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const els = Array.from(document.querySelectorAll('a, button, [role="button"]')).filter(vis)
    .filter(el => !el.closest('nav, footer, [role="navigation"]'))
    .filter(el => words.test((el.innerText || el.getAttribute('aria-label') || '').trim()));
  if (!els.length) return null;
  els.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const sa = ra.width * ra.height - Math.max(0, ra.top) * 2, sb = rb.width * rb.height - Math.max(0, rb.top) * 2; return sb - sa; });
  window.__fischerCtas = els;
  const el = els[0];
  return { text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60), href: el.getAttribute('href'), index: 0 };
})()`

const FORM_SCRIPT = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const isField = el => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !/^(hidden|submit|button|image|reset|checkbox|radio)$/i.test(el.type || '');
  const forms = Array.from(document.querySelectorAll('form')).filter(vis)
    .map(f => ({ f, fields: Array.from(f.elements).filter(isField).filter(vis) }))
    .filter(x => x.fields.length > 0 && !(x.fields.length === 1 && /search|q$/i.test(x.fields[0].name || x.fields[0].type)));
  if (!forms.length) return null;
  forms.sort((a, b) => b.fields.length - a.fields.length);
  const { f, fields } = forms[0];
  window.__fischerForm = f;
  const labelFor = el => (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest('label');
  const submit = f.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
  const required = fields.filter(el => el.required || el.getAttribute('aria-required') === 'true');
  return {
    fieldCount: fields.length,
    requiredCount: required.length,
    fields: fields.map(el => ({
      name: (el.getAttribute('name') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.type || 'field').slice(0, 50),
      type: el.tagName === 'INPUT' ? (el.type || 'text') : el.tagName.toLowerCase(),
      hasLabel: !!labelFor(el) || !!el.getAttribute('aria-label') || !!el.getAttribute('aria-labelledby'),
      autocomplete: el.getAttribute('autocomplete'),
      height: Math.round(el.getBoundingClientRect().height),
      required: el.required || el.getAttribute('aria-required') === 'true'
    })),
    submitText: submit ? ((submit.innerText || submit.value || '').trim().slice(0, 60) || null) : null,
    submitVisible: !!submit && vis(submit) && submit.getBoundingClientRect().right <= window.innerWidth + 2,
    html5Validation: !f.noValidate && required.some(el => typeof el.checkValidity === 'function' && el.value === '' && !el.checkValidity()),
    noValidate: !!f.noValidate,
    captcha: !!f.querySelector('.g-recaptcha:not([data-size="invisible"]), iframe[src*="recaptcha"][title*="challenge" i], .h-captcha, .cf-turnstile')
  };
})()`

const ADD_TO_CART_SCRIPT = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const btn = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"]')).filter(vis)
    .find(el => /(add to (cart|bag|basket|trolley)|buy now)/i.test(el.innerText || el.value || ''));
  if (!btn) return { clicked: false, text: null, needsOption: false };
  const unselected = Array.from(document.querySelectorAll('select[name*="size" i], select[name*="option" i], select[name*="variant" i]')).filter(s => !s.value);
  for (const s of unselected) { const opt = Array.from(s.options).find(o => o.value && !o.disabled); if (opt) { s.value = opt.value; s.dispatchEvent(new Event('change', { bubbles: true })); } }
  if (btn.disabled) return { clicked: false, text: (btn.innerText || btn.value || '').trim(), needsOption: true };
  btn.click();
  return { clicked: true, text: (btn.innerText || btn.value || '').trim().slice(0, 40), needsOption: false };
})()`

const CHECKOUT_BUTTON_SCRIPT = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const el = Array.from(document.querySelectorAll('a, button, input[type="submit"]')).filter(vis)
    .find(e => /^(proceed to )?check ?out|secure checkout|continue to checkout/i.test((e.innerText || e.value || '').trim()));
  if (el) { el.click(); return true; }
  return false;
})()`

const CART_LINK_SCRIPT = `(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const el = Array.from(document.querySelectorAll('a[href], button')).filter(vis)
    .find(e => /^(view )?(cart|basket|bag|trolley)$|view (cart|basket|bag)|go to (cart|basket)/i.test((e.innerText || e.getAttribute('aria-label') || '').trim()));
  if (el) { el.click(); return true; }
  return false;
})()`

const CHECKOUT_FACTS_SCRIPT = `(() => {
  const text = (document.body ? document.body.innerText : '').toLowerCase();
  const pw = !!document.querySelector('input[type="password"]');
  const guest = /guest|continue without (an )?account|check ?out as guest/.test(text) || (!pw && !!document.querySelector('input[type="email"], input[name*="email" i]'));
  const payments = ['visa', 'mastercard', 'eft', 'payfast', 'payflex', 'snapscan', 'zapper', 'ozow', 'paypal', 'apple pay', 'google pay', 'mobicred', 'peach', 'yoco'].filter(p => text.includes(p));
  return { guest, forcedLogin: pw && !guest, shipping: /shipping|delivery/.test(text) && /(r ?\\d|free)/.test(text), payments };
})()`
