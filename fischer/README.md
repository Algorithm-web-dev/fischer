# ♟ Fischer v2 — CRO Agent
### Algorithm Agency Internal Tool

Fischer is Algorithm Agency's AI-powered CRO audit agent. Feed it a URL and analytics data, and it returns a full conversion audit — friction points, revenue impact, and A/B test hypotheses — backed by the page's **actual scraped content**, not a guess.

This is a backend rebuild of the original Phase 1 MVP. **The frontend is being rebuilt in Lovable** — this repo is now primarily an API + data layer. The two pages under `app/` (`/` and `/audit`) are a minimal fallback UI kept just so the API is testable end-to-end without waiting on the Lovable build.

---

## What changed from Phase 1, and why

| # | Problem in Phase 1 | Fix in v2 |
|---|---|---|
| 1 | Prompt said "fetch the page" but only `web_search` was wired up — audits ran on search snippets, not the real page | `lib/scraper.ts` does a real server-side fetch + HTML parse (title, headings, CTA text, form fields, trust signals, body copy) before the prompt is built |
| 2 | Frontend parsed Claude's markdown output line-by-line, matching exact header strings — silently broke on any wording drift | `lib/claude.ts` now forces structured JSON output via tool-use (`submit_fischer_audit`) — typed, schema-validated, no prose parsing anywhere |
| 3 | Zero persistence — every audit vanished on tab close | Supabase schema (`supabase/migrations/0001_core_schema.sql`): `audits`, `backlog_items`, `clients` tables. Every audit is saved; friction points can be promoted straight into the backlog |
| 4 | Shared password stored as the literal cookie value, compared in plaintext, no per-user identity | Real Supabase Auth — each team member has their own account, sessions are proper signed tokens, `created_by` tracks who ran what |
| 5 | No rate limiting on login or audit routes | Upstash Redis rate limiting (`lib/ratelimit.ts`) — 5 login attempts/min per IP, 10 audits/hour per user. Reuses the same Redis instance as Fischer Memory rather than a new one |

Also fixed: hardcoded dated model snapshot → `claude-sonnet-4-6` alias; no input validation on the page URL → validated before any fetch happens; no distinction between "scrape failed" and "scrape succeeded but page is thin" → the model gets an explicit confidence flag either way and is instructed never to invent detail to cover a gap.

### Screenshots — seeing the page, not just its text

Text/DOM extraction alone can't judge visual hierarchy, CTA prominence, contrast, or clutter — two pages with identical HTML can convert completely differently based on how they actually look. `lib/screenshot.ts` captures real above-the-fold screenshots at both desktop (1440×900) and mobile (375×812) viewports, using a serverless-compatible headless Chromium (`@sparticuz/chromium` + `puppeteer-core`) running inside this same Vercel function — no separate crawler service, no new infrastructure.

Both screenshots are sent to Claude as real image content blocks (not described in text), uploaded to Supabase Storage for persistence, and referenced from the `audits` table. If screenshot capture fails for any reason, the audit still runs on text/DOM data alone — the prompt explicitly tells Claude not to make visual claims in that case rather than guessing.

**Vercel plan note:** `maxDuration = 90` on the audit route (scrape + 2 screenshots + Claude call). Vercel's Hobby plan caps functions at 60s — this route will need a Pro plan or higher to run reliably in production.

### Confidence-gated manual capture — automatic first, manual only when needed

Manual input is no longer a checkbox the user has to remember to tick. Auto-capture always runs first; `lib/confidence.ts` assesses whether what it got is actually usable per piece (HTML content, desktop screenshot, mobile screenshot independently):

- **HTML** is flagged low-confidence if the fetch failed outright, the scraper's own JS-render heuristic tripped, or the word count is suspiciously thin (<50 words)
- **Each screenshot viewport** is flagged independently — a mobile-specific block or redirect doesn't take down the desktop capture

**If everything auto-captured is good enough:** the audit runs immediately, in one request, exactly like the fully-automatic path — no friction added for the common case where auto just works.

**If something's missing:** the route returns early *without calling Claude* (`status: "needs_manual_input"`, plus the specific reason per piece) and persists whatever *did* succeed against the audit row. The frontend surfaces only the fields actually needed — if just the mobile screenshot failed, that's the only upload field shown, not a full manual-mode form. The user fills in the gap and resubmits with the same `auditId`; the route picks up where it left off rather than starting over, and only re-attempts auto-capture for viewports that still need it (a manually-supplied viewport is never re-captured, which would otherwise create a duplicate image sent to Claude).

**Why this is better than an opt-in checkbox:** manual effort is now proportional to what actually failed, not a blanket decision the user has to make upfront. A page that auto-captures perfectly costs zero extra clicks; a page that's gated behind login only asks for what it genuinely can't get on its own.

---

## Tests

```bash
npm test
```

29 unit tests covering the pure logic — no live credentials needed (no Supabase, Anthropic, or GA4 calls):
- `tests/scraper.test.ts` — HTML parsing (`parseHtml`): CTA/form/trust-signal extraction, the JS-render heuristic, script-tag stripping
- `tests/confidence.test.ts` — the confidence gate: independent per-viewport screenshot checks, thin-content and JS-render detection, boundary cases
- `tests/ga4.test.ts` — guardrail threshold math for all three threshold types, including the zero-baseline divide-by-zero case and the exact-boundary case
- `tests/pxl.test.ts` — PXL schema integrity (10 criteria, unique keys, weight sum)

These were run and verified before this was packaged — including a deliberate sanity check (temporarily breaking the guardrail threshold logic to confirm the tests actually fail, not just pass vacuously) before reverting.

**Not covered by these tests** — anything requiring live external services: the actual audit route end-to-end, screenshot capture, PageSpeed/GA4 API calls, Claude prompt output. Those need real credentials and are best tested against a staging Supabase project once one exists, not in an automated suite here.

## Stack

- **Next.js 14** (App Router) — API routes only, going forward
- **Anthropic Claude Sonnet 4.6** — audit reasoning, structured tool-use output
- **Supabase** — Postgres + Auth + RLS
- **Upstash Redis** — rate limiting
- **cheerio** — server-side HTML parsing for the scraper
- **Vercel** — hosting

---

## Setup

### 1. Install
```bash
npm install
```

### 2. Supabase
1. Create a project at [supabase.com](https://supabase.com) (or use the existing one if Fischer Memory already lives there — check for a `backlog_items` naming clash first).
2. Run `supabase/migrations/0001_core_schema.sql` in the SQL Editor.
3. Create team accounts: Dashboard → Authentication → Users → Add User (one per team member — Luke, Ashlin, etc). Or script it with `supabase.auth.admin.createUser()`.
4. Copy the Project URL, anon key, and service role key into `.env.local`.

### 3. Upstash Redis
Reuse the existing Fischer Memory Redis instance credentials if there is one — no need for a second database.

### 4. Environment
```bash
cp .env.local.example .env.local
# fill in ANTHROPIC_API_KEY, Supabase and Upstash values
```

### 5. Run
```bash
npm run dev
```

---

## API contract (for the Lovable frontend)

All routes require an authenticated Supabase session (cookie-based, set by `/api/auth`). Lovable's frontend should either:
- **(a)** Use Supabase's own client SDK directly for reads (audits, backlog) — RLS handles authorization automatically, or
- **(b)** Call these Next.js routes for anything that triggers Claude (auditing) or needs server-side logic (scraping, backlog promotion)

### `POST /api/auth`
```json
{ "email": "luke@algorithmagency.co.za", "password": "..." }
```
→ `{ "ok": true, "user": { "id", "email" } }`, sets session cookies.

### `DELETE /api/auth` — sign out

### `POST /api/audit`
```json
{
  "clientName": "Subaru South Africa",
  "pageUrl": "https://...",
  "pageType": "Landing Page",
  "businessGoal": "Lead Generation",
  "monthlyTraffic": "15000",
  "currentConversionRate": "1.8",
  "avgOrderValue": "45000",
  "deviceSplit": "60% Mobile / 40% Desktop",
  "bounceRate": "62",
  "avgSessionDuration": "1m 42s",
  "topExitPages": "/checkout, /contact",
  "additionalContext": "...",

  "auditId": "(optional) present when resubmitting after a needs_manual_input response",
  "manualHtml": "(optional) pasted DevTools outerHTML",
  "manualScreenshotDesktop": "(optional) base64 image",
  "manualScreenshotMobile": "(optional) base64 image"
}
```

Two possible response shapes:

**Auto-capture got everything it needed** (the common case — no extra round trip):
```json
{ "auditId": "uuid", "status": "complete", "captureMode": "auto", "scrapeSucceeded": true, "screenshotsSucceeded": true, "screenshotUrls": { "desktop": "...", "mobile": "..." }, "result": AuditResult }
```

**Auto-capture couldn't get everything — Claude was NOT called, no cost incurred:**
```json
{
  "auditId": "uuid",
  "status": "needs_manual_input",
  "needsManualHtml": false,
  "needsManualDesktop": true,
  "needsManualMobile": false,
  "reasons": { "desktop": "Desktop screenshot capture failed." }
}
```
Resubmit the same request with `auditId` set and the flagged field(s) filled in — only the missing pieces need to be supplied; anything that already succeeded is not re-requested.

See `lib/claude.ts` for the full `AuditResult` shape (fischerScore, summary, confidenceNote, frictionPoints[], revenueImpact, abTestHypotheses[], actionPlan).

Rate limited to 10/hour per user → `429` with a retry time if exceeded.

### `GET /api/backlog?clientId=...&tier=...`
→ `{ "items": BacklogItem[] }`

### `POST /api/backlog`
Manually add a backlog item (see `supabase/migrations/0001_core_schema.sql` for the full field list).

### `POST /api/backlog/from-audit`
```json
{ "auditId": "uuid", "clientId": "uuid" }
```
Promotes every friction point from a completed audit into `backlog_items`, all starting in `tier: "watching"` per the CRO SOP — nothing skips straight to "this month."

---

---

## Phase 3 — the five remaining SOP/rollout-plan builds

Everything below closes out the gaps flagged across the CRO SOP and the rollout plan. Each is genuinely new — not present in Phase 2.

### 1. Core Web Vitals (Google PageSpeed Insights)

`lib/pagespeed.ts` — fetches mobile and desktop scores independently (per Google's own recommendation, since the two genuinely differ) and feeds LCP/INP/CLS straight into the audit prompt alongside the scraped content and screenshots. A slow page is now something Fischer can actually see and cite as a friction point, not an invisible gap. Free, 25,000 queries/day, no infrastructure.

Fetched *after* the confidence gate passes — no point spending PSI quota on a request that's about to bail out for manual input anyway.

### 2. Guardrail metric polling

`lib/ga4.ts` + `app/api/cron/guardrails/route.ts` + `vercel.json` — real Google Analytics Data API integration, checked on a schedule (daily by default, see `vercel.json`), not by a person remembering to log into GA4. Per the CRO SOP: 2-4 metrics per client, pre-set thresholds, a breach is a reportable finding on its own.

**Setup required before this runs for real:** a GA4 service account (`GOOGLE_SERVICE_ACCOUNT_KEY`) needs Viewer access explicitly granted on each client's GA4 property — the key alone grants nothing. Use `POST /api/guardrails` to register what to watch per client (metric name, GA4 property ID, GA4 metric name, threshold).

The cron route uses the service-role Supabase client deliberately, since Vercel's scheduler has no logged-in user session — RLS's `authenticated`-only policies would otherwise block it.

### 3. PXL auto-scoring

`lib/pxl.ts` + `POST /api/backlog/[id]/pxl-score` — the 10 binary PXL criteria from CRO SOP Section 04, scored via forced tool-use (not a subjective 1-10), grounded in the backlog item's actual source audit context where available rather than scored from the title alone. Weighted (above-the-fold and qualitative-evidence-backed items score higher) — see `PXL_CRITERIA` in `lib/pxl.ts` if the weighting needs adjusting for how your team actually prioritizes.

### 4. Market share / competitor analysis

`lib/marketshare.ts` + `POST /api/market-share` — genuinely new; this did not exist anywhere in the uploaded codebase (the `market-share.functions.ts` referenced in earlier work must live in the separate TanStack/Supabase project). Three pieces:
- **Competitor audit** — a lighter version of the main audit pipeline (same scraper, shorter Claude prompt: score + top 3-5 friction points only, not the full revenue/A-B-test depth), run once per competitor
- **Traffic estimate** — Claude's `web_search` tool, zero marginal cost, honestly labeled as indicative ("50k-100k monthly visits", not a fake-precise number). DataForSEO remains the documented upgrade path for clients who need real precision — not built here
- **Synthesis** — the four-section output (Market Position / Competitive Gaps / Revenue Opportunity / Recovery Roadmap) proven out in earlier planning, now actually implemented with structured output

Persists to `competitor_audits` and `market_share_analyses`. Cadence (monthly light refresh for Tier A, quarterly for Tier B, on-request for Tier C, per CRO SOP Section 06) is a scheduling decision for whoever calls this route — it's not built as its own cron, since the right cadence differs per client tier.

### 5. Report auto-draft

`GET /api/reports/[clientId]/draft` — assembles the exact JSON shape the branded report generator (`generate_report.py` from the CRO report kit) expects, directly from live data: shipped items and their results, what's currently in "this month," what's queued in "next," and a market-share highlight for the Fischer Intelligence slot. This is a first draft to edit, not a document to write from a blank page — it does not render the PDF itself, that stays a separate step using the existing Python/Playwright pipeline.

## Known limitations, worth knowing before scaling this up

- **The text/DOM scraper only sees static HTML** — JS-heavy SPAs may come back thin from `lib/scraper.ts`. The screenshots, however, use a real headless browser and *do* render JavaScript correctly — so a JS-heavy page will still get a proper visual audit even when its text extraction is weak. The prompt is written to treat these as independent signals rather than assuming one implies the other.
- **Screenshot capture adds real cold-start cost.** Launching headless Chromium takes 2-4 seconds per invocation; capturing two viewports plus the scrape plus the Claude call is why `maxDuration` is set to 90s. Worth monitoring actual run times once this is live — if audits start timing out, screenshot capture should move to a background job rather than blocking the main request.
- **Audit route runs synchronously** (scrape + screenshots + Claude call in one request). Fine for now; if this starts feeling slow, this should move to a background job (Supabase Edge Function or a queue) with the frontend polling `audits.status`.
- **RLS is single-tenant** (any authenticated user sees everything). Fine while it's just Algorithm Agency's team; needs `agency_id`-scoped policies before any external agency ever gets access.
- **Not yet added: Core Web Vitals / page speed data.** A slow page can be the single biggest conversion killer and neither the scraper nor the screenshots can see it. Google's PageSpeed Insights API is free (25,000 queries/day) and gives LCP/INP/CLS for both mobile and desktop — worth adding as the next data source, same pattern as the screenshot capture.
- **Minor inefficiency on resubmission:** if only one viewport needed manual input, the other viewport (which already succeeded automatically) gets auto-recaptured from scratch on resubmit rather than reusing the first attempt's result. Harmless — just an extra Chromium launch — but worth optimizing later by fetching the already-uploaded screenshot back from Supabase Storage instead of recapturing it.
- **Guardrail polling needs real setup before it does anything.** The cron job runs on schedule regardless, but every guardrail needs its GA4 property ID registered via `POST /api/guardrails`, and the service account needs Viewer access granted per-property in each client's own GA4 Admin panel — this doesn't happen automatically just because the env var is set.
- **Market share traffic estimates are indicative, not precise** — by design, since they're free (`web_search`-based). If a specific client relationship needs defensible precise numbers for a board presentation, that's the trigger for the documented DataForSEO upgrade, not a reason to distrust the default.
- **The `@anthropic-ai/sdk` version installed doesn't have typed support for the `web_search` tool yet** — `lib/marketshare.ts` casts the tools array to `any` for that one call. The Messages API itself supports it regardless of SDK type lag; worth removing the cast once the SDK catches up.

---

## Algorithm Agency IP

Fischer is proprietary to Algorithm Agency. The system prompt, audit framework, and revenue calculation methodology are Algorithm Agency intellectual property. Do not share this codebase externally.

**Fischer v2.0** · Algorithm Agency · Internal Use Only
