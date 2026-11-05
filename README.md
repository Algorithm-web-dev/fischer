# ♟ Fischer — CRO Agent
### Algorithm Agency

Fischer audits a client's pages the way a visitor sees them, backs every finding with evidence, stores every run, and tracks each client month over month: what changed on the site, what happened to conversions afterwards, and which A/B tests won. Each month it produces a client report you can share as a link or a PDF.

---

## What Fischer does

| | |
|---|---|
| **Sees the real page** | Loads every page in headless Chromium at desktop (1440px) and mobile (390px), dismisses cookie banners, scrolls to trigger lazy loading, and captures the **full page** as numbered screenshot sections. Text is extracted from the *rendered* DOM, so JavaScript sites work. Layout is measured from the live render: what's above the fold, CTA size/colour/position, form fields, sideways overflow, small tap targets, broken images, JS errors. |
| **Evidence, not assumptions** | Every finding must cite its evidence (quoted copy, a measured value, a GA4/Clarity/PageSpeed number, or "mobile section 2") and its source. Findings that cite no evidence, or cite data that wasn't supplied (e.g. "Clarity shows…" with no Clarity connected), move to *unverified*. They're kept for the team and left out of client reports. The model may return few findings for a strong page; it is no longer forced to produce at least 5. |
| **Numbers computed in code** | Revenue opportunity, A/B test sample sizes, test duration and significance are calculated in `lib/stats.ts` from real traffic, never by the model. |
| **Every run stored** | Each audit keeps its screenshots, layout, extracted content, PageSpeed/GA4/Clarity data, a page fingerprint, and the model output. |
| **Month-over-month tracking** | Tracked pages are re-audited every 30 days. Each audit reviews the previous audit's issues (resolved / improved / still present / worse) against the new screenshots, and detects what changed on the page. Monthly GA4 and Clarity snapshots are stored per client. |
| **Change → impact** | Shipped backlog items, concluded A/B tests, detected page changes and manual entries go into a change log. Each change is measured over the 28 days before vs the 28 days after (GA4). |
| **A/B tests** | Hypotheses come with a traffic-based test plan. Briefs give exact copy and targeting. Results are entered manually or pulled from GA4, then a two-proportion significance test is run. A test that wins is written to the change log. |
| **Client reports** | A monthly report covering KPIs vs last month, an industry comparison, a 6-month trend, where revenue is leaking, the funnel, lead quality, changes and their impact, A/B tests, page audits with screenshots and fixes, and next month's plan. Share it as a no-login link or download a PDF. |
| **Revenue leak map** | Every landing page × device from GA4, compared with the site's own conversion rate for that device (floored at 80% of the industry median once benchmarks exist). Valued in rand at half the gap, with no double counting. Mobile-vs-desktop gap and paid traffic on weak pages are shown separately. Leaking pages can be tracked with one click, or automatically each month. Audits of a leaking page are told why it was picked. |
| **Tracking check** | During every audit, Fischer records which tags actually fire: GA4 (incl. server-side), GTM, Clarity, Google Ads, Meta, LinkedIn, TikTok, Hotjar. It also checks consent signals and the GA4 event list. Problems (tag missing or not sending, duplicate IDs, consent blocking analytics, no key events, conversion event missing) become findings and alerts. |
| **Funnels + tracking kit** | Open funnels per device: lead (visitors → form start → submit) and e-commerce (view → cart → checkout → purchase), with the biggest drop, mobile gaps, the value of a 10% improvement, and the form fields people abandon on. `public/fischer-tracking.js` adds the standard lead events (form_start/submit/abandon, confirmed lead, call, WhatsApp, email clicks) plus first-touch UTMs, and never reads form values. |
| **Journey checks** | Weekly, the browser acts as a mobile visitor. Lead: taps the main CTA, finds the form and inspects field types, labels, tap sizes, validation, CAPTCHA and contact links. Checkout: add to cart → cart → checkout, checking forced login, shipping visibility and payment methods. **Never submits anything.** A broken journey raises an alert. |
| **Alerts** | Broken journeys, tracking problems, a >20% month-over-month conversion drop, guardrail breaches, and scheduled audits that fail or need input. Deduplicated while open, shown on the dashboard, and optionally posted to Slack/Teams (`ALERT_WEBHOOK_URL`). |
| **Background queue** | Audits are queued and run by a per-minute worker (`claim_next_audit`, `SKIP LOCKED`), in parallel, with 3 retries and crashed-job recovery. Scheduled re-audits run on `FISCHER_SCHEDULED_MODEL` (default Sonnet 5.5); manual audits use `FISCHER_MODEL` (default Opus 5.5). |
| **CRM lead quality** | The CRM, Zapier or Make posts leads to `/api/leads/ingest` (per-client key, hashed; no personal data stored). Fischer reports qualified rate, win rate and revenue per lead by landing page and source. Real revenue per lead becomes the leak map's value per conversion. |
| **Benchmarks + test library** | Anonymised conversion-rate medians by industry and device (min. 3 clients, last 3 months). A library of every concluded test, tagged by change type, with win rates. Both feed audits and test planning. |

---

## What was broken, and what changed

| Problem | Fix |
|---|---|
| Audits were built on a plain `fetch()` of the raw HTML (an empty shell on most modern sites) plus one 900px screenshot. Everything below the fold was a guess. | `lib/capture.ts`: real-browser, full-page, two-viewport capture, with text from the rendered DOM and measured layout facts. |
| The output schema **forced 5–10 friction points** and 3–5 tests on every page, so the model padded with generic issues. | Findings are optional (0–10), each requires evidence plus sources, and `validateFindings()` filters out unsupported ones. Strengths are reported too. |
| The model did the revenue arithmetic. | `computeRevenueImpact()` does it. The model only supplies lift percentages. |
| **Clarity integration returned zeros.** The parser looked for `data.results`, which the Clarity API doesn't return, so every audit told the model "0% rage clicks". | Rewritten for the real array-of-metrics response, with page matching that ignores `www`/query strings/trailing slashes, session-weighted aggregation and tests. A daily job stores history because Clarity only exposes 3 days. |
| **GA4 used the deprecated `conversions` metric.** The page filter (`CONTAINS "/"`) matched every page, and "exit pages" were really top pages by sessions. | `keyEvents` (or the client's chosen event via `keyEvents:<event>`), exact page path matching, honest landing-page data, calendar-month date ranges. |
| **Cron jobs could never run.** The middleware redirected session-less requests (i.e. Vercel Cron) to the login page. | `/api/cron/*` and `/report/*` are excluded from session auth. Crons check `CRON_SECRET`, and API routes return a JSON 401 instead of an HTML redirect. |
| Forced `tool_choice` is rejected by current Claude models. | All model calls go through `lib/llm.ts`: structured outputs (`output_config.format`, Zod-validated), streaming, refusal fallback. |
| Comparing audits matched friction points by fuzzy title. | The model reviews each previous issue against the new screenshots. A deterministic page fingerprint diff records what actually changed. |
| `/api/audit` accepted any URL, including internal addresses. | `lib/validate.ts` blocks localhost and private/metadata IPs (SSRF). |

---

## Setup

### 1. Install
```bash
npm install
```

### 2. Supabase
Run the migrations **in order** in the SQL editor:
`0001` → `0002` → `0003` → `0004_tracking_reports_tests` → `0005_revenue_leaks` → `0006_tracking_check` → `0007_journeys_alerts` → `0008_job_queue` → `0009_leads`

Migrations 0004–0009 are safe to re-run. All nine were verified against PostgreSQL 16.

Then create team accounts under Authentication → Users.

### 3. Environment
```bash
cp .env.local.example .env.local
```
Required: `ANTHROPIC_API_KEY`, Supabase URL + anon + service-role keys, `CRON_SECRET`. Recommended: `GOOGLE_PAGESPEED_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_KEY` (GA4), Upstash (rate limiting), `FISCHER_PUBLIC_URL`, `ALERT_WEBHOOK_URL` (Slack/Teams incoming webhook). Optional: `FISCHER_MODEL`, `FISCHER_SCHEDULED_MODEL`, `FISCHER_REAUDIT_DAYS`.

### 4. Hosting (Vercel)
- **Pro plan needed.** Audits run up to 300s (full-page capture at two viewports + model analysis), and the monthly job runs hourly. Hobby caps functions at 60s and crons at once a day.
- Cron schedules are in `vercel.json`: **worker (every minute)**, snapshots + leak maps + queuing re-audits (hourly), Clarity history (daily 02:15 UTC), journey checks (daily 03:20 UTC, each page weekly), guardrails (daily).
- If Vercel Deployment Protection is on, PDF export needs `FISCHER_PUBLIC_URL` to point at a URL the function can reach (e.g. your production domain).

### 5. Run locally
```bash
npm run dev
```
For local screenshots, set `CHROME_EXECUTABLE_PATH` to your Chrome binary (the serverless Chromium build only runs on Linux).

---

## Onboarding a client

1. **Clients → Add client.** Enter the name, website and value per conversion (average order or lead value).
2. **GA4:** add the property ID. Ask the client to add the service account email (from `GOOGLE_SERVICE_ACCOUNT_KEY`) as a **Viewer** in GA4 Admin → Property access management. Optionally set the conversion event (e.g. `generate_lead`); it must be marked as a key event in GA4.
3. **Clarity:** in Clarity → Settings → Data Export → *Generate new API token*, then paste the project ID and token.
4. **Settings → Test connections** confirms GA4 access and stores the first day of Clarity data.
5. **Settings → Tracking kit:** copy the snippet into the client's GTM (Custom HTML, All Pages), set the thank-you path, mark the lead event as a key event in GA4, and register `field_name` as a custom dimension.
6. **Revenue leaks → Build leak map**, then **Track top 3 leaking pages** (or track pages by hand under Pages & audits). Tick *auto-track* in Settings to do this monthly.
7. For each tracked page, choose a **journey** (lead or checkout) and click **Audit now** to set the baseline.
8. **Lead quality → Create ingest key** and connect the CRM. Turn on `injectHiddenFields` in the tracking kit so every lead carries its landing page and UTMs.

## The monthly cycle

| When | What happens |
|---|---|
| Every minute | Worker runs queued audits. |
| Daily | Clarity's last 24h is stored per client. The current month's GA4 snapshot is refreshed. Journey checks run for pages not checked in 7 days. |
| Every 30 days per page | Tracked pages are re-audited automatically, with follow-up on last month's issues and page-change detection. |
| 1st–4th of the month | Last month's snapshot is built and refreshed while GA4 finalises late data. Last month's leak map and funnel are built, top leaks auto-tracked (if enabled), and a conversion-drop alert raised if needed. |
| During the month | Move backlog items to *shipped* (logged as changes), run A/B tests, log manual changes. |
| Report day | **Reports** tab → pick the month → *Create client link* or *Download PDF*. |

## A/B test results from GA4 (optional)

Entering visitor and conversion counts manually always works. To pull them automatically:
1. Make the testing tool write the visitor's variant to a **user property** (VWO, Convert, AB Tasty and Optimizely GA4 integrations can, or use `gtag('set', 'user_properties', { exp_variant: 'TEST12-B' })`).
2. Register it in GA4 Admin → Custom definitions as a **user-scoped** custom dimension.
3. On the test, set the dimension (`customUser:exp_variant`) and the control/variant values, then click **Sync from GA4**.

---

## Screens

| Path | Purpose |
|---|---|
| `/` | Login |
| `/clients` | Client list with integration status |
| `/clients/[id]` | Dashboard: Overview (monthly table, score history), Pages & audits, Changes, A/B tests, Reports, Settings |
| `/audit` | Run a one-off or client audit. `/audit?view=<id>` shows a stored audit. |
| `/report/[token]` | Public client report (token-protected, printable) |

## API

All routes need a team session except `/report/*` (share token), `/api/cron/*` (`CRON_SECRET`), `/api/leads/ingest` (ingest key) and `/fischer-tracking.js`.

| Route | |
|---|---|
| `POST /api/audit` | Run an audit (`clientId` or `clientName`, `pageUrl`, `pageType`, `businessGoal`). With `async: true` it is queued (202, poll `GET /api/audits/[id]`). Otherwise it returns `complete` or `needs_manual_input` with the missing pieces; resubmit with `auditId` + `manualHtml` / `manualScreenshotDesktop` / `manualScreenshotMobile`. |
| `GET/POST /api/clients/[id]/leaks` | Latest leak map / build one now (`days`, `period`, `trackTop`) |
| `GET /api/clients/[id]/leads?days=` · `POST /api/clients/[id]/lead-key` | Lead quality report / create or rotate the CRM ingest key |
| `POST /api/leads/ingest` | CRM lead feed (`Authorization: Bearer fsk_…`). One lead, an array, or `{ leads: [...] }`, max 500. Upserts by `externalId`. |
| `GET/POST /api/journeys` | Journey checks for a client / run one for a tracked page |
| `GET/PATCH /api/alerts` | Open alerts / resolve |
| `GET /api/benchmarks[?clientId=]` · `GET /api/test-library?industry=&tag=` | Anonymised benchmarks / concluded tests and win rates |
| `GET /api/audits?clientId=&pageUrl=` · `GET /api/audits/[id]` | Audit history / full audit |
| `GET/POST/PATCH /api/clients` · `GET /api/clients/[id]` | Clients (Clarity tokens are masked on read) |
| `POST /api/clients/[id]/test-integrations` | Check GA4 + Clarity credentials |
| `GET /api/clients/[id]/trends` | Monthly snapshots, score history per page, changes, tests |
| `GET/POST/PATCH/DELETE /api/tracked-pages` | Pages re-audited monthly |
| `GET/POST/DELETE /api/changes` | Change log (`?measure=1` computes before/after impact) |
| `PATCH /api/backlog/[id]` | Update a backlog item (moving to `shipped` logs a change) |
| `POST /api/test-brief` · `GET /api/test-brief?clientId=` | Create a test from an audit hypothesis / list tests |
| `GET/PATCH /api/tests/[id]` · `POST /api/tests/[id]/sync-ga4` | Test lifecycle, results + significance, GA4 pull |
| `GET/POST/DELETE /api/reports/[clientId]` | Report data / create share link / revoke |
| `GET /api/reports/[clientId]/pdf?period=YYYY-MM` | PDF download |

Unchanged: `/api/backlog`, `/api/backlog/from-audit`, `/api/backlog/[id]/pxl-score`, `/api/guardrails`, `/api/market-share`, `/api/audits/compare`, `/api/reports/[clientId]/draft`.

---

## Tests

```bash
npm test
```
94 unit tests, no credentials needed: confidence gate (including bot-protection pages), the Clarity parser against the real response shape, statistics, finding validation and audit post-processing, page change detection, URL safety, GA4 helpers, HTML parsing, leak map maths (incl. no double counting and benchmark floors), tracking detection, funnels, journey issues, lead normalisation and quality, benchmarks and the test library.

Also verified in this environment: full-page capture, the tracking check, the tracking kit (real browser) and both journey types against local test pages; all migrations and the queue's claim function (ordering, crash recovery, attempt limit, two-worker race) against PostgreSQL 16.

Not covered by automated tests (needs live credentials): the end-to-end audit with a real model call, GA4/Clarity/PageSpeed API calls, Supabase writes, PDF rendering on Vercel.

## Known limitations

- **Single-tenant.** Any logged-in team member sees every client. That's fine for an agency team. Before letting clients or other agencies log in themselves, add an `agency_id` / `client_id`-scoped RLS model. (Clients can already view their reports via share links without an account.)
- **Funnels are open funnels** (users who reached each step's event), not strictly sequential. GA4's sequential funnel API is still alpha.
- **Journey checks never submit,** so they prove the form is reachable and well built, not that submissions arrive. The tracking kit's lead event plus the conversion-drop alert cover that.
- **Before/after ≠ causation.** Change impact compares 28-day windows, and seasonality and campaigns also move numbers. Reports say so. A/B tests are the controlled evidence.
- **Clarity history starts when you connect it.** Clarity only exposes the last 3 days, so month-level Clarity data builds up from the first daily collection.
- **Heavily bot-protected sites** (Cloudflare challenges etc.) are detected and the audit asks for manual screenshots/HTML instead of auditing the challenge page.
- Pages longer than ~10,800px (desktop) / ~11,900px (mobile) are captured down to that depth, and the prompt notes the truncation.

---

## Algorithm Agency IP

Fischer is proprietary to Algorithm Agency. The system prompt, audit framework, and revenue calculation methodology are Algorithm Agency intellectual property. Do not share this codebase externally.
