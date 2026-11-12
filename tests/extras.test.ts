import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyUrl, parseSitemapLocs } from '../lib/discovery'
import { brandingUpdate, DEFAULT_BRANDING } from '../lib/branding'
import { reportEmailHtml } from '../lib/report-email'
import { summarise } from '../lib/accessibility'

test('discovery classifies conversion pages', () => {
  assert.equal(classifyUrl('https://a.co.za/'), 'home')
  assert.equal(classifyUrl('https://a.co.za/checkout'), 'checkout')
  assert.equal(classifyUrl('https://a.co.za/cart.html'), 'cart')
  assert.equal(classifyUrl('https://a.co.za/get-a-quote'), 'quote')
  assert.equal(classifyUrl('https://a.co.za/book-a-test-drive'), 'booking')
  assert.equal(classifyUrl('https://a.co.za/contact-us'), 'lead_form')
  assert.equal(classifyUrl('https://a.co.za/products/solar-panel-450w'), 'product')
  assert.equal(classifyUrl('https://a.co.za/blog/solar-myths'), 'content')
})

test('sitemap parsing handles CDATA, entities and indexes', () => {
  const locs = parseSitemapLocs(`<urlset><url><loc>https://a.com/a?x=1&amp;y=2</loc></url><url><loc><![CDATA[https://a.com/b]]></loc></url></urlset>
    <sitemapindex><sitemap><loc> https://a.com/sitemap-2.xml </loc></sitemap></sitemapindex>`)
  assert.deepEqual(locs, ['https://a.com/a?x=1&y=2', 'https://a.com/b', 'https://a.com/sitemap-2.xml'])
})

test('branding validation', () => {
  assert.match(String(brandingUpdate({ primaryColor: 'red' })), /hex colour/)
  assert.match(String(brandingUpdate({ logoUrl: 'http://x/logo.png' })), /https/)
  assert.match(String(brandingUpdate({ agencyName: '  ' })), /required/)
  const ok = brandingUpdate({ agencyName: 'Algorithm', primaryColor: '#112233', emailReplyTo: 'hi@algorithm.agency' }) as any
  assert.equal(ok.agency_name, 'Algorithm')
  assert.equal(ok.primary_color, '#112233')
})

test('report email: headline numbers, escaped content, link', () => {
  const r: any = {
    client: { name: 'Acme <Solar>', contactName: 'Ashlin' }, periodLabel: 'October 2026',
    branding: { ...DEFAULT_BRANDING, logoUrl: null },
    kpis: { conversionRate: { current: 2.23, changePct: 16.1 }, conversions: { current: 412, changePct: 24.8 }, avgFischerScore: { current: 68 } },
    changes: [{}, {}], tests: [{}], pages: [{ summary: 'Form cut to 4 fields.' }]
  }
  const { subject, html, text } = reportEmailHtml(r, 'https://fischer.example/report/tok')
  assert.equal(subject, 'Acme <Solar> — conversion report, October 2026')
  assert.ok(html.includes('Acme &lt;Solar&gt;'))
  assert.ok(!html.includes('<Solar>'))
  assert.match(html, /2\.23% \(▲ 16\.1%\)/)
  assert.match(html, /https:\/\/fischer\.example\/report\/tok/)
  assert.match(text, /Changes made: 2/)
})

test('accessibility summary orders by impact and counts instances', () => {
  const s = summarise([
    { id: 'region', impact: 'moderate', help: 'h', helpUrl: '', nodes: 5, examples: [] },
    { id: 'color-contrast', impact: 'serious', help: 'h', helpUrl: '', nodes: 3, examples: [] },
    { id: 'select-name', impact: 'critical', help: 'h', helpUrl: '', nodes: 1, examples: [] }
  ], 40)
  assert.deepEqual(s.violations.map(v => v.id), ['select-name', 'color-contrast', 'region'])
  assert.deepEqual(s.counts, { critical: 1, serious: 3, moderate: 5, minor: 0 })
})
