/*!
 * Fischer tracking kit — standard lead-generation events for GA4.
 * Algorithm Agency. Install once per site (GTM Custom HTML tag on All Pages, or a <script> tag).
 *
 *   <script>window.fischerConfig = { leadEvent: 'generate_lead', thankYouPath: '/thank-you' };</script>
 *   <script src="https://YOUR-FISCHER-DOMAIN/fischer-tracking.js" async></script>
 *
 * Events pushed to the dataLayer (and sent with gtag() when GA4 is installed without GTM):
 *   form_start      first interaction with a form          { form_id, form_name, page_path }
 *   form_submit     form submitted                         { form_id, form_name, page_path, field_count }
 *   form_abandon    left the page after starting a form    { form_id, form_name, field_name, page_path }
 *   <leadEvent>     confirmed lead (thank-you page or success message)  { lead_source_page, utm_* }
 *   click_to_call   tel: link clicked                      { link_text, page_path }
 *   whatsapp_click  WhatsApp link clicked                  { link_text, page_path }
 *   email_click     mailto: link clicked                   { link_text, page_path }
 *
 * Optional config:
 *   leadEvent            name of the confirmed-lead event (default 'generate_lead')
 *   thankYouPath         path (or array of paths) of the thank-you page(s)
 *   successSelector      CSS selector that appears when a form succeeds without a page change
 *   injectHiddenFields   true → adds hidden fischer_* inputs (landing page, UTMs, click IDs) to
 *                        every form so your CRM receives the lead's source (default false)
 *   debug                true → logs events to the console
 *   abTests              true → runs live Fischer A/B tests for this site (variants are page
 *                        edits set up in Fischer). Visitors are assigned once (stored on their
 *                        device); the arm is sent to GA4 as user property "fischer_exp" and an
 *                        "experience_impression" event. Briefly hides the page (max 700 ms) on
 *                        a visitor's first page view to avoid flicker.
 *   testsUrl             override the test config URL (default: same origin as this script)
 *
 * Privacy: no field VALUES are ever read or sent — only field names/labels. First-touch
 * attribution is kept in localStorage on the visitor's device for 90 days.
 */
(function () {
  'use strict';
  if (window.__fischerTracking) return;
  window.__fischerTracking = true;

  var cfg = window.fischerConfig || {};
  var SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';
  var LEAD_EVENT = cfg.leadEvent || 'generate_lead';
  var STORE_KEY = 'fischer_attribution';
  var started = {};      // formKey → true
  var submitted = {};
  var lastField = {};

  function path() { return location.pathname; }

  function send(name, params) {
    params = params || {};
    params.page_path = params.page_path || path();
    window.dataLayer = window.dataLayer || [];
    var hasGTM = !!window.google_tag_manager;
    if (typeof window.gtag === 'function' && !hasGTM) {
      window.gtag('event', name, params);
    } else {
      var payload = { event: name };
      for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k)) payload[k] = params[k];
      window.dataLayer.push(payload);
    }
    if (cfg.debug && window.console) console.log('[fischer]', name, params);
  }

  // ---------- First-touch attribution ----------
  function readAttribution() {
    try { var a = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); if (a && a.expires > Date.now()) return a; } catch (e) {}
    return null;
  }
  function captureAttribution() {
    var q = new URLSearchParams(location.search);
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'msclkid'];
    var fresh = {};
    var any = false;
    keys.forEach(function (k) { var v = q.get(k); if (v) { fresh[k] = v.slice(0, 150); any = true; } });
    var existing = readAttribution();
    if (!existing || any) {
      fresh.landing_page = path();
      fresh.referrer = document.referrer ? document.referrer.slice(0, 200) : '';
      fresh.first_seen = new Date().toISOString();
      fresh.expires = Date.now() + 90 * 86400000;
      try { localStorage.setItem(STORE_KEY, JSON.stringify(existing && !any ? existing : fresh)); } catch (e) {}
    }
  }
  captureAttribution();

  function attributionParams() {
    var a = readAttribution() || {};
    var out = { lead_source_page: a.landing_page || path() };
    ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) { if (a[k]) out[k] = a[k]; });
    return out;
  }

  // ---------- Forms ----------
  function formKey(form) { return form.id || form.getAttribute('name') || form.getAttribute('action') || ('form-' + Array.prototype.indexOf.call(document.forms, form)); }
  function formInfo(form) { return { form_id: form.id || '', form_name: form.getAttribute('name') || form.getAttribute('aria-label') || '' }; }
  function fieldName(el) {
    var label = el.id && document.querySelector('label[for="' + el.id + '"]');
    return (el.getAttribute('name') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || (label && label.textContent) || el.type || 'field').trim().slice(0, 60);
  }
  function isField(el) {
    return el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !/^(hidden|submit|button|image|reset)$/i.test(el.type || '');
  }

  document.addEventListener('focusin', function (e) {
    var el = e.target;
    if (!isField(el) || !el.form) return;
    var key = formKey(el.form);
    lastField[key] = fieldName(el);
    if (!started[key]) { started[key] = true; var p = formInfo(el.form); send('form_start', p); }
  }, true);

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (isField(el) && el.form) lastField[formKey(el.form)] = fieldName(el);
  }, true);

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var key = formKey(form);
    submitted[key] = true;
    var p = formInfo(form);
    p.field_count = Array.prototype.filter.call(form.elements, isField).length;
    send('form_submit', p);
  }, true);

  function onLeave() {
    for (var key in started) {
      if (started[key] && !submitted[key] && !started[key + ':abandoned']) {
        started[key + ':abandoned'] = true;
        var form = null;
        for (var i = 0; i < document.forms.length; i++) if (formKey(document.forms[i]) === key) form = document.forms[i];
        var p = form ? formInfo(form) : { form_id: key, form_name: '' };
        p.field_name = lastField[key] || '(none)';
        p.transport_type = 'beacon';
        send('form_abandon', p);
      }
    }
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') onLeave(); });
  window.addEventListener('pagehide', onLeave);

  // ---------- Confirmed lead ----------
  var leadSent = false;
  function sendLead() { if (leadSent) return; leadSent = true; send(LEAD_EVENT, attributionParams()); }
  var thankYou = cfg.thankYouPath ? [].concat(cfg.thankYouPath) : [];
  if (thankYou.some(function (p) { return path() === p || path().indexOf(p) === 0; })) sendLead();
  if (cfg.successSelector && window.MutationObserver) {
    var check = function () { if (document.querySelector(cfg.successSelector)) { sendLead(); obs.disconnect(); } };
    var obs = new MutationObserver(check);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---------- Contact clicks ----------
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var p = { link_text: (a.textContent || '').trim().slice(0, 60) };
    if (/^tel:/i.test(href)) send('click_to_call', p);
    else if (/^mailto:/i.test(href)) send('email_click', p);
    else if (/(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|^whatsapp:)/i.test(href)) send('whatsapp_click', p);
  }, true);

  // ---------- Hidden source fields for the CRM ----------
  function inject() {
    if (!cfg.injectHiddenFields) return;
    var a = readAttribution() || {};
    var fields = { fischer_landing_page: a.landing_page || path(), fischer_utm_source: a.utm_source || '', fischer_utm_medium: a.utm_medium || '',
      fischer_utm_campaign: a.utm_campaign || '', fischer_gclid: a.gclid || '', fischer_referrer: a.referrer || '' };
    Array.prototype.forEach.call(document.forms, function (form) {
      for (var name in fields) {
        if (form.querySelector('input[name="' + name + '"]')) continue;
        var input = document.createElement('input');
        input.type = 'hidden'; input.name = name; input.value = fields[name];
        form.appendChild(input);
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject); else inject();
  // Forms rendered later (SPAs, popups): re-check at most twice a second
  var pending = false;
  if (cfg.injectHiddenFields && window.MutationObserver) new MutationObserver(function () {
    if (pending) return; pending = true; setTimeout(function () { pending = false; inject(); }, 500);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ---------- Live A/B tests (opt-in: fischerConfig.abTests = true) ----------
  // Variants are page edits ("DOM ops") — same format and sanitising as lib/dom-ops.ts.
  if (!cfg.abTests) return;
  var TESTS_CACHE = 'fischer_tests';
  var host = location.hostname.replace(/^www\./, '');
  var testsUrl = cfg.testsUrl || (SCRIPT_SRC ? SCRIPT_SRC.replace(/\/fischer-tracking\.js.*$/, '') + '/api/kit/config' : '');
  var mobile = window.matchMedia && window.matchMedia('(max-width: 767px)').matches;

  function cleanFragment(html) {
    var t = document.createElement('template');
    t.innerHTML = html;
    var bad = t.content.querySelectorAll('script,style,iframe,object,embed,link,meta,base,form');
    for (var i = 0; i < bad.length; i++) bad[i].parentNode.removeChild(bad[i]);
    var all = t.content.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var attrs = Array.prototype.slice.call(all[j].attributes);
      for (var k = 0; k < attrs.length; k++) {
        var a = attrs[k];
        if (/^on/i.test(a.name) || (/^(href|src|action|formaction|xlink:href)$/i.test(a.name) && /^\s*(javascript|data|vbscript):/i.test(a.value))) all[j].removeAttribute(a.name);
      }
    }
    return t.content;
  }
  var SAFE_ATTR = /^(placeholder|href|alt|title|aria-label|type|inputmode|autocomplete|value|src|target|rel)$/i;
  function applyOps(ops) {
    var pendingOps = [];
    ops.forEach(function (op) {
      var el = null;
      try { el = document.querySelector(op.selector); } catch (e) { return; }
      if (!el) { pendingOps.push(op); return; }
      if (el.getAttribute('data-fx-done') && el.getAttribute('data-fx-done').indexOf(op.action) !== -1 && op.action !== 'setStyle') return;
      if (op.action === 'setText') el.textContent = op.value;
      else if (op.action === 'setHtml') { el.innerHTML = ''; el.appendChild(cleanFragment(op.value)); }
      else if (op.action === 'hide') el.style.setProperty('display', 'none', 'important');
      else if (op.action === 'setStyle') (op.style || []).forEach(function (s) { if (!/url\(|expression\(|javascript:/i.test(s.value)) el.style.setProperty(s.property, s.value, 'important'); });
      else if (op.action === 'insertBefore') el.parentNode.insertBefore(cleanFragment(op.value), el);
      else if (op.action === 'insertAfter') el.parentNode.insertBefore(cleanFragment(op.value), el.nextSibling);
      else if (op.action === 'setAttribute' && SAFE_ATTR.test(op.attribute) && !/^\s*(javascript|data|vbscript):/i.test(op.value)) el.setAttribute(op.attribute, op.value);
      el.setAttribute('data-fx-done', (el.getAttribute('data-fx-done') || '') + ' ' + op.action);
    });
    return pendingOps;
  }
  function pathMatches(m) {
    if (!m || m === '*') return true;
    var p = path().replace(/\/+$/, '') || '/';
    if (m.slice(-1) === '*') return p.indexOf(m.slice(0, -1).replace(/\/+$/, '')) === 0;
    return p === (m.replace(/\/+$/, '') || '/');
  }
  function arm(test) {
    var key = 'fischer_exp_' + test.key, v = null;
    try { v = localStorage.getItem(key); } catch (e) {}
    if (v !== 'control' && v !== 'variant') {
      v = Math.random() < (test.split || 0.5) ? 'variant' : 'control';
      try { localStorage.setItem(key, v); } catch (e) {}
    }
    return v;
  }
  var running = {};
  function run(tests) {
    (tests || []).forEach(function (t) {
      if (running[t.key] || !pathMatches(t.urlMatch)) return;
      if ((t.device === 'mobile' && !mobile) || (t.device === 'desktop' && mobile)) return;
      running[t.key] = true;
      var a = arm(t);
      var value = t.key + '-' + a;
      if (typeof window.gtag === 'function') window.gtag('set', 'user_properties', { fischer_exp: value });
      send('experience_impression', { exp_variant_string: 'FX-' + value, fischer_exp: value });
      if (a !== 'variant') return;
      var left = applyOps(t.ops || []);
      // Elements rendered later (SPAs): keep trying for a few seconds
      if (left.length && window.MutationObserver) {
        var obs = new MutationObserver(function () { left = applyOps(left); if (!left.length) obs.disconnect(); });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(function () { obs.disconnect(); }, 5000);
      }
    });
  }
  function reveal() { var s = document.getElementById('fischer-ab-hide'); if (s) s.parentNode.removeChild(s); }
  function onReady(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }

  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(TESTS_CACHE) || 'null'); } catch (e) {}
  if (cached && cached.host === host) {
    onReady(function () { run(cached.tests); });                    // no flicker on repeat views
  } else {
    var st = document.createElement('style');                         // first view: hide briefly
    st.id = 'fischer-ab-hide'; st.textContent = 'body{opacity:0 !important}';
    (document.head || document.documentElement).appendChild(st);
    setTimeout(reveal, 700);
  }
  if (testsUrl) {
    fetch(testsUrl + '?host=' + encodeURIComponent(host), { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : { tests: [] }; })
      .then(function (j) {
        try { localStorage.setItem(TESTS_CACHE, JSON.stringify({ host: host, tests: j.tests || [], at: Date.now() })); } catch (e) {}
        onReady(function () { run(j.tests || []); reveal(); });
      })
      .catch(reveal);
  } else reveal();
})();
