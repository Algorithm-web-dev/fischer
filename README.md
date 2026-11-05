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
| **Client reports** | A monthly report covering KPIs vs last month, a 6-month trend, changes and their impact, A/B tests, page audits with screenshots and fixes, and next month's plan. Share it as a no-login link or download a PDF. |

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
`0001_core_schema.sql` → `0002_pagespeed_guardrails_marketshare.sql` → `0003_client_integrations_audit_compare.sql` → `0004_tracking_reports_tests.sql`

Then create team accounts under Authentication → Users.

### 3. Environment
```bash
cp .env.local.example .env.local
```
Required: `ANTHROPIC_API_KEY`, Supabase URL + anon + service-role keys, `CRON_SECRET`. Recommended: `GOOGLE_PAGESPEED_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_KEY` (GA4), Upstash (rate limiting), `FISCHER_PUBLIC_URL`.

### 4. Hosting (Vercel)
- **Pro plan needed.** Audits run up to 300s (full-page capture at two viewports + model analysis), and the monthly job runs hourly. Hobby caps functions at 60s and crons at once a day.
- Cron schedules are in `vercel.json`: guardrails (daily), Clarity history (daily 02:15 UTC), snapshots + scheduled re-audits (hourly).
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
5. **Pages & audits → Track page** for each page to monitor (home, key landing pages, quote form, checkout), then click **Audit now** to set the baseline.

## The monthly cycle

| When | What happens |
|---|---|
| Daily | Clarity's last 24h is stored per client. The current month's GA4 snapshot is refreshed. |
| Every 30 days per page | Tracked pages are re-audited automatically, with follow-up on last month's issues and page-change detection. |
| 1st–4th of the month | Last month's snapshot is built and refreshed while GA4 finalises late data. |
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

All routes need a team session except `/report/*` (token) and `/api/cron/*` (`CRON_SECRET`).

| Route | |
|---|---|
| `POST /api/audit` | Run an audit (`clientId` or `clientName`, `pageUrl`, `pageType`, `businessGoal`). Returns `complete` or `needs_manual_input` with the missing pieces; resubmit with `auditId` + `manualHtml` / `manualScreenshotDesktop` / `manualScreenshotMobile`. |
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
59 unit tests, no credentials needed: confidence gate (including bot-protection pages), the Clarity parser against the real response shape, statistics (significance, sample size, test plans, revenue), finding validation and audit post-processing, page change detection, URL safety, GA4 path/date helpers, HTML parsing.

Not covered by automated tests (needs live credentials): the end-to-end audit with a real model call, GA4/Clarity/PageSpeed API calls, Supabase writes, PDF rendering on Vercel.

## Known limitations

- **Single-tenant.** Any logged-in team member sees every client. That's fine for an agency team. Before letting clients or other agencies log in themselves, add an `agency_id` / `client_id`-scoped RLS model. (Clients can already view their reports via share links without an account.)
- **Before/after ≠ causation.** Change impact compares 28-day windows, and seasonality and campaigns also move numbers. Reports say so. A/B tests are the controlled evidence.
- **Clarity history starts when you connect it.** Clarity only exposes the last 3 days, so month-level Clarity data builds up from the first daily collection.
- **Heavily bot-protected sites** (Cloudflare challenges etc.) are detected and the audit asks for manual screenshots/HTML instead of auditing the challenge page.
- Pages longer than ~10,800px (desktop) / ~11,900px (mobile) are captured down to that depth, and the prompt notes the truncation.

---

## Algorithm Agency IP

Fischer is proprietary to Algorithm Agency. The system prompt, audit framework, and revenue calculation methodology are Algorithm Agency intellectual property. Do not share this codebase externally.
