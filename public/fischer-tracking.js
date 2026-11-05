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
 *
 * Privacy: no field VALUES are ever read or sent — only field names/labels. First-touch
 * attribution is kept in localStorage on the visitor's device for 90 days.
 */
(function () {
  'use strict';
  if (window.__fischerTracking) return;
  window.__fischerTracking = true;

  var cfg = window.fischerConfig || {};
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
})();
