import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHtml } from '../lib/scraper'

const SAMPLE_HTML = `
<!DOCTYPE html>
<html>
<head>
  <title>Subaru Forester — Test Drive Today</title>
  <meta name="description" content="Book a test drive of the new Subaru Forester.">
</head>
<body>
  <h1>The All-New Subaru Forester</h1>
  <h2>Adventure Awaits</h2>
  <p>Experience the freedom of the open road with best-in-class safety ratings and legendary reliability. Our vehicles are trusted by thousands of South African families every year, and every purchase comes with a comprehensive warranty and dedicated support.</p>
  <button>Book a Test Drive</button>
  <a href="/brochure" class="btn">Download Brochure</a>
  <form>
    <input type="text" placeholder="Full Name" name="fullName" />
    <input type="email" placeholder="Email Address" name="email" />
    <input type="tel" placeholder="Phone Number" name="phone" />
    <button type="submit">Request a Callback</button>
  </form>
  <p>Rated 5 stars by verified customer reviews. Money back guarantee on all test drives.</p>
  <img src="/hero.jpg" />
  <img src="/gallery1.jpg" />
</body>
</html>
`

const THIN_JS_SHELL_HTML = `
<!DOCTYPE html>
<html>
<head><title>App</title></head>
<body>
  <div id="root"></div>
  <script src="/bundle.js"></script>
</body>
</html>
`.padEnd(6000, ' ') // padded to exceed the 5000-char JS-render heuristic threshold

test('parseHtml extracts title and meta description', () => {
  const result = parseHtml(SAMPLE_HTML, 'https://example.com/forester')
  assert.equal(result.title, 'Subaru Forester — Test Drive Today')
  assert.equal(result.metaDescription, 'Book a test drive of the new Subaru Forester.')
})

test('parseHtml extracts headings with correct levels', () => {
  const result = parseHtml(SAMPLE_HTML, 'https://example.com/forester')
  assert.equal(result.headings.length, 2)
  assert.equal(result.headings[0].level, 'h1')
  assert.equal(result.headings[0].text, 'The All-New Subaru Forester')
  assert.equal(result.headings[1].level, 'h2')
})

test('parseHtml detects CTA buttons/links by keyword matching', () => {
  const result = parseHtml(SAMPLE_HTML, 'https://example.com/forester')
  assert.ok(result.ctaButtons.some(t => t.includes('Test Drive')), 'should detect "Book a Test Drive"')
  assert.ok(result.ctaButtons.some(t => t.includes('Download Brochure')), 'should detect download CTA')
  assert.ok(result.ctaButtons.some(t => t.includes('Request a Callback')), 'should detect form submit CTA')
})

test('parseHtml extracts form fields and submit text correctly', () => {
  const result = parseHtml(SAMPLE_HTML, 'https://example.com/forester')
  assert.equal(result.forms.length, 1)
  assert.equal(result.forms[0].fieldCount, 3)
  assert.deepEqual(result.forms[0].fieldLabels, ['Full Name', 'Email Address', 'Phone Number'])
  assert.equal(result.forms[0].submitText, 'Request a Callback')
})

test('parseHtml detects trust signals by keyword', () => {
  const result = parseHtml(SAMPLE_HTML, 'https://example.com/forester')
  assert.ok(result.trustSignals.some(t => t.toLowerCase().includes('guarantee')))
})

test('parseHtml counts images correctly', () => {
  const result = parseHtml(SAMPLE_HTML, 'https://example.com/forester')
  assert.equal(result.imageCount, 2)
})

test('parseHtml flags likely-JS-rendered pages via the thin-content heuristic', () => {
  const result = parseHtml(THIN_JS_SHELL_HTML, 'https://example.com/spa')
  assert.equal(result.fetchedWithJs, true, 'a near-empty body on a large HTML payload should trip the heuristic')
})

test('parseHtml does NOT flag a normal content-rich page as JS-rendered', () => {
  const result = parseHtml(SAMPLE_HTML, 'https://example.com/forester')
  assert.equal(result.fetchedWithJs, false)
})

test('parseHtml strips script/style tags from body text extraction', () => {
  const htmlWithScript = SAMPLE_HTML.replace('</body>', '<script>console.log("should not appear in bodyTextSample")</script></body>')
  const result = parseHtml(htmlWithScript, 'https://example.com/forester')
  assert.ok(!result.bodyTextSample.includes('should not appear'), 'script contents must not leak into extracted text')
})
