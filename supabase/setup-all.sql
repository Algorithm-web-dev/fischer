-- ============================================================
-- Fischer — complete database setup (migrations 0001–0015 combined)
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Create your own login (Authentication → Users) BEFORE running it:
-- every login that exists at that moment becomes a Fischer admin.
-- Generated from supabase/migrations/*.sql — those files remain the source of truth.
-- ============================================================

-- ------------------------------------------------------------
-- 0001_core_schema.sql
-- ------------------------------------------------------------
-- Fischer Phase 2 — Core schema
-- Run this in Supabase SQL editor, or via `supabase db push` if using the CLI.

-- ============================================================
-- CLIENTS
-- One row per retainer client. Tier drives cadence (see CRO SOP Section 03/04).
-- ============================================================
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  primary_url text,
  tier text not null default 'B' check (tier in ('A', 'B', 'C')),
  cro_hours_monthly numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- AUDITS
-- One row per Fischer audit run. output is the structured JSON
-- from Claude (see lib/claude.ts AuditResult schema), not raw prose.
-- ============================================================
create table if not exists audits (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete set null,
  client_name text not null,          -- denormalised for cases with no client_id yet
  page_url text not null,
  page_type text,
  business_goal text,
  input_data jsonb not null,          -- the raw form input (traffic, CVR, AOV, etc.)
  scraped_content jsonb,              -- what the scraper actually extracted (see lib/scraper.ts)
  screenshot_desktop_url text,        -- Supabase Storage public URL, above-the-fold desktop
  screenshot_mobile_url text,         -- Supabase Storage public URL, above-the-fold mobile
  output jsonb,                       -- the structured AuditResult from Claude
  fischer_score int,                  -- 1-100, pulled out of output for fast querying/sorting
  status text not null default 'pending' check (status in ('pending', 'running', 'needs_manual_input', 'complete', 'failed')),
  error_message text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists audits_client_id_idx on audits(client_id);
create index if not exists audits_created_at_idx on audits(created_at desc);

-- ============================================================
-- BACKLOG ITEMS
-- Every friction point / opportunity a client has, tiered per the
-- CRO SOP (Watching -> Next -> This Month -> Shipped). Populated
-- automatically from audit friction points, not hand-typed.
-- ============================================================
create table if not exists backlog_items (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  source_audit_id uuid references audits(id) on delete set null,

  title text not null,
  description text,

  tier text not null default 'watching'
    check (tier in ('watching', 'next', 'this_month', 'shipped')),

  evidence_type text not null default 'quant'
    check (evidence_type in ('quant', 'qual', 'competitive', 'both')),
  evidence_refs jsonb default '{}'::jsonb,   -- { ga4_stat, clarity_url, competitor_audit_id }

  ice_impact int check (ice_impact between 1 and 10),
  ice_confidence int check (ice_confidence between 1 and 10),
  ice_ease int check (ice_ease between 1 and 10),
  ice_score numeric generated always as (
    (coalesce(ice_impact, 0) + coalesce(ice_confidence, 0) + coalesce(ice_ease, 0)) / 3.0
  ) stored,

  pxl_score jsonb,                     -- the 10-criterion binary breakdown, nullable until scored

  severity text check (severity in ('high', 'medium', 'low')),
  result_summary text,                 -- populated once shipped — the before/after number

  owner text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists backlog_items_client_id_idx on backlog_items(client_id);
create index if not exists backlog_items_tier_idx on backlog_items(tier);

-- ============================================================
-- updated_at triggers
-- ============================================================
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists clients_set_updated_at on clients;
create trigger clients_set_updated_at before update on clients
  for each row execute function set_updated_at();

drop trigger if exists backlog_items_set_updated_at on backlog_items;
create trigger backlog_items_set_updated_at before update on backlog_items
  for each row execute function set_updated_at();

-- ============================================================
-- Row Level Security
-- Phase 2 is single-agency (Algorithm Agency), so the policy is simple:
-- any authenticated team member can read/write everything. If Fischer
-- ever goes multi-tenant (other agencies), swap these for agency_id-scoped
-- policies before onboarding a second agency.
-- ============================================================
alter table clients enable row level security;
alter table audits enable row level security;
alter table backlog_items enable row level security;

create policy "Authenticated users can read clients" on clients
  for select using (auth.role() = 'authenticated');
create policy "Authenticated users can write clients" on clients
  for all using (auth.role() = 'authenticated');

create policy "Authenticated users can read audits" on audits
  for select using (auth.role() = 'authenticated');
create policy "Authenticated users can write audits" on audits
  for all using (auth.role() = 'authenticated');

create policy "Authenticated users can read backlog_items" on backlog_items
  for select using (auth.role() = 'authenticated');
create policy "Authenticated users can write backlog_items" on backlog_items
  for all using (auth.role() = 'authenticated');

-- ============================================================
-- Storage bucket for screenshots
-- Run this once — or create the bucket manually via Dashboard > Storage.
-- Public read (screenshots aren't sensitive, and this keeps the report
-- generator simple — it can just use the URL directly), authenticated write.
-- ============================================================
insert into storage.buckets (id, name, public)
values ('fischer-screenshots', 'fischer-screenshots', true)
on conflict (id) do nothing;

create policy "Public can view screenshots" on storage.objects
  for select using (bucket_id = 'fischer-screenshots');
create policy "Authenticated users can upload screenshots" on storage.objects
  for insert with check (bucket_id = 'fischer-screenshots' and auth.role() = 'authenticated');

-- ------------------------------------------------------------
-- 0002_pagespeed_guardrails_marketshare.sql
-- ------------------------------------------------------------
-- Fischer Phase 3 — Core Web Vitals, Guardrails, Market Share/Competitor Analysis
-- Run after 0001_core_schema.sql.

-- ============================================================
-- PAGESPEED / CORE WEB VITALS
-- Attached to audits — one row per (audit, strategy) so mobile and desktop
-- are tracked independently, per Google's own recommendation.
-- ============================================================
alter table audits add column if not exists pagespeed_desktop jsonb;
alter table audits add column if not exists pagespeed_mobile jsonb;

-- ============================================================
-- GUARDRAIL METRICS
-- What Section 07 of the CRO SOP calls "guardrail monitoring." Each row is
-- one metric being watched for one client, checked on a schedule (see
-- app/api/cron/guardrails/route.ts), not something a person checks by hand.
-- ============================================================
create table if not exists guardrail_metrics (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,

  metric_name text not null,               -- e.g. 'revenue_per_visitor', 'conversion_rate'
  ga4_property_id text not null,           -- GA4 property to pull this metric from
  ga4_metric text not null,                -- the actual GA4 API metric name, e.g. 'averagePurchaseRevenue'

  threshold_type text not null default 'max_drop_pct'
    check (threshold_type in ('max_drop_pct', 'min_value', 'max_value')),
  threshold_value numeric not null,        -- e.g. 2 for "must not drop more than 2%"

  baseline_value numeric,                  -- the value this metric is compared against
  current_value numeric,
  status text not null default 'ok' check (status in ('ok', 'breached', 'unknown')),
  last_checked_at timestamptz,

  active boolean not null default true,    -- pause a guardrail without deleting its history
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists guardrail_metrics_client_id_idx on guardrail_metrics(client_id);
create index if not exists guardrail_metrics_status_idx on guardrail_metrics(status);

drop trigger if exists guardrail_metrics_set_updated_at on guardrail_metrics;
create trigger guardrail_metrics_set_updated_at before update on guardrail_metrics
  for each row execute function set_updated_at();

-- Historical log of every check — lets you see a breach trend, not just the
-- current status. Guardrail rows above always hold only the latest reading.
create table if not exists guardrail_checks (
  id uuid primary key default gen_random_uuid(),
  guardrail_id uuid not null references guardrail_metrics(id) on delete cascade,
  value numeric,
  status text not null check (status in ('ok', 'breached', 'unknown')),
  checked_at timestamptz not null default now()
);

create index if not exists guardrail_checks_guardrail_id_idx on guardrail_checks(guardrail_id);

-- ============================================================
-- COMPETITOR AUDITS + MARKET SHARE ANALYSIS
-- A lighter version of the main audit pipeline (same scrape/screenshot/
-- confidence-gate machinery, shorter Claude prompt) run per competitor,
-- then synthesised into a market position summary. Feeds backlog_items
-- with evidence_type = 'competitive' exactly like friction points do.
-- ============================================================
create table if not exists competitor_audits (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  competitor_name text not null,
  competitor_url text not null,

  fischer_score int,
  top_friction_points jsonb,          -- lightweight — top 3-5, not the full audit depth
  traffic_estimate jsonb,             -- { monthlyVisits, source: 'web_search' | 'dataforseo', confidence }

  scraped_content jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'complete', 'failed')),
  error_message text,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists competitor_audits_client_id_idx on competitor_audits(client_id);

create table if not exists market_share_analyses (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  client_audit_id uuid references audits(id) on delete set null,
  competitor_audit_ids uuid[] not null default '{}',

  market_position text,
  competitive_gaps jsonb,             -- [{ competitor, gap, revenueOpportunity }]
  revenue_opportunity jsonb,
  recovery_roadmap jsonb,             -- [{ step, description }]

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists market_share_analyses_client_id_idx on market_share_analyses(client_id);

-- ============================================================
-- RLS — same single-tenant policy as migration 1
-- ============================================================
alter table guardrail_metrics enable row level security;
alter table guardrail_checks enable row level security;
alter table competitor_audits enable row level security;
alter table market_share_analyses enable row level security;

create policy "Authenticated users can read guardrail_metrics" on guardrail_metrics
  for select using (auth.role() = 'authenticated');
create policy "Authenticated users can write guardrail_metrics" on guardrail_metrics
  for all using (auth.role() = 'authenticated');

create policy "Authenticated users can read guardrail_checks" on guardrail_checks
  for select using (auth.role() = 'authenticated');
create policy "Service role can write guardrail_checks" on guardrail_checks
  for insert with check (true); -- written by the cron job via service role, not user sessions

create policy "Authenticated users can read competitor_audits" on competitor_audits
  for select using (auth.role() = 'authenticated');
create policy "Authenticated users can write competitor_audits" on competitor_audits
  for all using (auth.role() = 'authenticated');

create policy "Authenticated users can read market_share_analyses" on market_share_analyses
  for select using (auth.role() = 'authenticated');
create policy "Authenticated users can write market_share_analyses" on market_share_analyses
  for all using (auth.role() = 'authenticated');

-- ------------------------------------------------------------
-- 0003_client_integrations_audit_compare.sql
-- ------------------------------------------------------------
-- Fischer Phase 4 — Client Integrations (GA4 auto-pull, Clarity frustration data)
-- Run after 0002_pagespeed_guardrails_marketshare.sql.

-- ============================================================
-- CLIENT INTEGRATIONS
-- Every field a client needs for Fischer to pull live data automatically.
-- Once these are populated, the audit form no longer needs manual
-- analytics input — Fischer fetches everything from the APIs.
-- ============================================================

-- GA4 integration: service account already exists (GOOGLE_SERVICE_ACCOUNT_KEY env),
-- we just need to know which property belongs to which client.
alter table clients add column if not exists ga4_property_id text;

-- Clarity integration: per-project API token + project ID.
-- Token is a JWT generated in Clarity Settings → Data Export → Generate new API token.
-- Capped at 10 requests/day per project — fine for retainer volume.
alter table clients add column if not exists clarity_project_id text;
alter table clients add column if not exists clarity_api_token text;

-- Industry context — helps Claude understand conversion benchmarks
alter table clients add column if not exists industry text;
alter table clients add column if not exists avg_order_value numeric;
alter table clients add column if not exists currency text not null default 'ZAR';

-- ============================================================
-- AUDIT ENRICHMENT
-- Store the live-pulled GA4 + Clarity data alongside each audit so
-- we have a historical record of what Fischer actually saw at audit time.
-- ============================================================
alter table audits add column if not exists ga4_data jsonb;
alter table audits add column if not exists clarity_data jsonb;
alter table audits add column if not exists capture_metadata jsonb;

-- ============================================================
-- AUDIT COMPARISON / DIFF
-- A view that pairs each audit with its predecessor for the same page,
-- so the diff endpoint doesn't need complex self-join logic every time.
-- ============================================================
create or replace view audit_pairs as
select
  a.id as audit_id,
  a.client_id,
  a.page_url,
  a.fischer_score,
  a.output,
  a.completed_at,
  lag(a.id) over w as previous_audit_id,
  lag(a.fischer_score) over w as previous_fischer_score,
  lag(a.output) over w as previous_output,
  lag(a.completed_at) over w as previous_completed_at
from audits a
where a.status = 'complete'
window w as (partition by a.client_id, a.page_url order by a.completed_at);

-- ============================================================
-- A/B TEST BRIEFS
-- Expanded test briefs generated from audit hypotheses. These are
-- implementation-ready specs, not just the raw hypothesis JSON.
-- ============================================================
create table if not exists test_briefs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  source_audit_id uuid references audits(id) on delete set null,
  backlog_item_id uuid references backlog_items(id) on delete set null,

  hypothesis_name text not null,
  brief jsonb not null,       -- full structured brief (control, variant, metrics, copy, etc.)
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'running', 'completed', 'abandoned')),

  test_start_date date,
  test_end_date date,
  result_summary text,
  cvr_delta numeric,          -- percentage point change (e.g. +0.4 means went from 1.8% to 2.2%)

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists test_briefs_client_id_idx on test_briefs(client_id);

drop trigger if exists test_briefs_set_updated_at on test_briefs;
create trigger test_briefs_set_updated_at before update on test_briefs
  for each row execute function set_updated_at();

-- RLS
alter table test_briefs enable row level security;

create policy "Authenticated users can read test_briefs" on test_briefs
  for select using (auth.role() = 'authenticated');
create policy "Authenticated users can write test_briefs" on test_briefs
  for all using (auth.role() = 'authenticated');

-- ------------------------------------------------------------
-- 0004_tracking_reports_tests.sql
-- ------------------------------------------------------------
-- Fischer — month-over-month tracking, change log, A/B test results, client reports
-- Run after 0003_client_integrations_audit_compare.sql.

-- ============================================================
-- CLIENTS: conversion definition + report branding
-- ============================================================
-- The GA4 event that counts as a conversion for this client (e.g. 'generate_lead',
-- 'purchase'). Must be marked as a key event in GA4. NULL = all key events.
alter table clients add column if not exists ga4_conversion_event text;
alter table clients add column if not exists report_logo_url text;
alter table clients add column if not exists report_contact_name text;
alter table clients add column if not exists report_contact_email text;

-- ============================================================
-- AUDITS: full-page screenshots, fingerprint, change detection, scheduling
-- ============================================================
alter table audits add column if not exists screenshots jsonb;            -- { desktop: [{index,y,height,url}], mobile: [...] }
alter table audits add column if not exists layout jsonb;                 -- { desktop: LayoutFacts, mobile: LayoutFacts }
alter table audits add column if not exists page_fingerprint jsonb;       -- lib/page-diff.ts PageFingerprint
alter table audits add column if not exists page_diff jsonb;              -- diff vs previous audit of same page
alter table audits add column if not exists previous_audit_id uuid references audits(id) on delete set null;
alter table audits add column if not exists trigger text not null default 'manual';  -- 'manual' | 'scheduled'
alter table audits add column if not exists model text;
alter table audits add column if not exists tracked_page_id uuid;

alter table audits drop constraint if exists audits_status_check;
alter table audits add constraint audits_status_check
  check (status in ('pending', 'queued', 'running', 'needs_manual_input', 'complete', 'failed'));

create index if not exists audits_page_idx on audits(client_id, page_url, completed_at desc);

-- ============================================================
-- TRACKED PAGES — the pages re-audited automatically every month
-- ============================================================
create table if not exists tracked_pages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  page_url text not null,
  page_type text not null default 'Landing Page',
  business_goal text not null default 'Lead Generation',
  active boolean not null default true,
  last_audit_id uuid references audits(id) on delete set null,
  last_audit_at timestamptz,
  created_at timestamptz not null default now(),
  unique (client_id, page_url)
);
create index if not exists tracked_pages_client_idx on tracked_pages(client_id);

alter table audits drop constraint if exists audits_tracked_page_fk;
alter table audits add constraint audits_tracked_page_fk
  foreign key (tracked_page_id) references tracked_pages(id) on delete set null;

-- ============================================================
-- MONTHLY SNAPSHOTS — one row per client per calendar month.
-- GA4 totals + per-tracked-page metrics + Clarity month aggregate.
-- This is what month-over-month reporting compares.
-- ============================================================
create table if not exists monthly_snapshots (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  period date not null,                 -- first day of the month
  ga4 jsonb,                            -- GA4AuditData for the calendar month
  pages jsonb,                          -- [{ pageUrl, ga4: GA4PageMetrics, clarity: ClarityPageData }]
  clarity jsonb,                        -- site-wide ClarityPageData aggregated over stored days
  clarity_days int not null default 0,
  errors jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, period)
);
create index if not exists monthly_snapshots_client_idx on monthly_snapshots(client_id, period desc);

drop trigger if exists monthly_snapshots_set_updated_at on monthly_snapshots;
create trigger monthly_snapshots_set_updated_at before update on monthly_snapshots
  for each row execute function set_updated_at();

-- ============================================================
-- CLARITY DAILY — Clarity only exposes the last 1-3 days and allows 10
-- requests/day, so a daily job stores each day. Months are built from this.
-- ============================================================
create table if not exists clarity_daily (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  day date not null,
  data jsonb not null,                  -- { site: ClarityPageData, pages: ClarityPageData[] }
  created_at timestamptz not null default now(),
  unique (client_id, day)
);
create index if not exists clarity_daily_client_idx on clarity_daily(client_id, day desc);

-- ============================================================
-- CHANGE LOG — every change made to a client's site, with a date.
-- Sources: shipped backlog items, concluded A/B tests, changes Fischer
-- detected between audits, or manual entries. Reports measure each
-- change's before/after impact from this.
-- ============================================================
create table if not exists change_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  page_url text,
  change_date date not null default current_date,
  title text not null,
  description text,
  source text not null default 'manual' check (source in ('manual', 'backlog', 'test', 'detected')),
  backlog_item_id uuid references backlog_items(id) on delete set null,
  test_brief_id uuid references test_briefs(id) on delete set null,
  audit_id uuid references audits(id) on delete set null,
  details jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists change_log_client_idx on change_log(client_id, change_date desc);

-- ============================================================
-- A/B TESTS — results + statistics
-- ============================================================
alter table test_briefs add column if not exists page_url text;
alter table test_briefs add column if not exists hypothesis jsonb;          -- the source hypothesis incl. plan
alter table test_briefs add column if not exists control_visitors int;
alter table test_briefs add column if not exists control_conversions int;
alter table test_briefs add column if not exists variant_visitors int;
alter table test_briefs add column if not exists variant_conversions int;
alter table test_briefs add column if not exists stats jsonb;               -- lib/stats.ts TestResultStats
alter table test_briefs add column if not exists winner text check (winner in ('variant', 'control', 'none'));
alter table test_briefs add column if not exists ga4_dimension text;        -- e.g. 'customUser:exp_variant' (see README)
alter table test_briefs add column if not exists ga4_control_value text;    -- dimension value for control visitors
alter table test_briefs add column if not exists ga4_variant_value text;    -- dimension value for variant visitors
alter table test_briefs add column if not exists results_source text;       -- 'manual' | 'ga4'
alter table test_briefs add column if not exists results_updated_at timestamptz;

-- ============================================================
-- REPORT SHARES — unguessable links clients open without logging in
-- ============================================================
create table if not exists report_shares (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  token text not null unique,
  period date not null,                 -- first day of the reported month
  revoked boolean not null default false,
  expires_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists report_shares_client_idx on report_shares(client_id);

-- ============================================================
-- RLS — team members (authenticated) can do everything; the public report
-- page and cron jobs use the service-role client server-side.
-- ============================================================
alter table tracked_pages enable row level security;
alter table monthly_snapshots enable row level security;
alter table clarity_daily enable row level security;
alter table change_log enable row level security;
alter table report_shares enable row level security;

do $$
declare t text;
begin
  foreach t in array array['tracked_pages', 'monthly_snapshots', 'clarity_daily', 'change_log', 'report_shares'] loop
    execute format('drop policy if exists "Authenticated users can read %1$s" on %1$s', t);
    execute format('drop policy if exists "Authenticated users can write %1$s" on %1$s', t);
    execute format('create policy "Authenticated users can read %1$s" on %1$s for select using (auth.role() = ''authenticated'')', t);
    execute format('create policy "Authenticated users can write %1$s" on %1$s for all using (auth.role() = ''authenticated'')', t);
  end loop;
end $$;

-- Screenshots are re-uploaded on resubmission (upsert) — allow updates too.
drop policy if exists "Authenticated users can update screenshots" on storage.objects;
create policy "Authenticated users can update screenshots" on storage.objects
  for update using (bucket_id = 'fischer-screenshots' and auth.role() = 'authenticated');

-- ------------------------------------------------------------
-- 0005_revenue_leaks.sql
-- ------------------------------------------------------------
-- Fischer — revenue leak map
-- Run after 0004_tracking_reports_tests.sql.

create table if not exists leak_analyses (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  data jsonb not null,                    -- lib/leaks.ts LeakAnalysis
  recoverable_monthly numeric,            -- pulled out for sorting/dashboards
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists leak_analyses_client_idx on leak_analyses(client_id, created_at desc);

-- When true, the monthly job adds the top leaking pages to tracked_pages automatically.
alter table clients add column if not exists auto_track_leaks boolean not null default false;

alter table leak_analyses enable row level security;
drop policy if exists "Authenticated users can read leak_analyses" on leak_analyses;
drop policy if exists "Authenticated users can write leak_analyses" on leak_analyses;
create policy "Authenticated users can read leak_analyses" on leak_analyses for select using (auth.role() = 'authenticated');
create policy "Authenticated users can write leak_analyses" on leak_analyses for all using (auth.role() = 'authenticated');

-- ------------------------------------------------------------
-- 0006_tracking_check.sql
-- ------------------------------------------------------------
-- Fischer — tracking health check stored with each audit
-- Run after 0005_revenue_leaks.sql.
alter table audits add column if not exists tracking jsonb;   -- lib/tracking.ts TrackingReport

-- ------------------------------------------------------------
-- 0007_journeys_alerts.sql
-- ------------------------------------------------------------
-- Fischer — journey walk-throughs and alerts
-- Run after 0006_tracking_check.sql.

-- Which journey to run weekly for a tracked page ('none' | 'lead' | 'ecommerce').
alter table tracked_pages add column if not exists journey_kind text not null default 'none'
  check (journey_kind in ('none', 'lead', 'ecommerce'));
alter table tracked_pages add column if not exists last_journey_at timestamptz;

create table if not exists journey_checks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  tracked_page_id uuid references tracked_pages(id) on delete set null,
  page_url text not null,
  kind text not null,
  passed boolean not null,
  result jsonb not null,           -- lib/journey.ts JourneyResult (screenshots replaced by URLs)
  created_at timestamptz not null default now()
);
create index if not exists journey_checks_page_idx on journey_checks(tracked_page_id, created_at desc);
create index if not exists journey_checks_client_idx on journey_checks(client_id, created_at desc);

create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  type text not null,              -- journey_failed | tracking_broken | conversion_drop | guardrail_breach | audit_needs_input | audit_failed
  dedupe_key text not null,        -- same open alert isn't raised twice
  severity text not null default 'high' check (severity in ('high', 'medium', 'low')),
  title text not null,
  message text,
  link text,
  details jsonb,
  notified_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists alerts_open_idx on alerts(client_id, created_at desc) where resolved_at is null;
create unique index if not exists alerts_open_dedupe on alerts(dedupe_key) where resolved_at is null;

alter table journey_checks enable row level security;
alter table alerts enable row level security;
do $$
declare t text;
begin
  foreach t in array array['journey_checks', 'alerts'] loop
    execute format('drop policy if exists "Authenticated users can read %1$s" on %1$s', t);
    execute format('drop policy if exists "Authenticated users can write %1$s" on %1$s', t);
    execute format('create policy "Authenticated users can read %1$s" on %1$s for select using (auth.role() = ''authenticated'')', t);
    execute format('create policy "Authenticated users can write %1$s" on %1$s for all using (auth.role() = ''authenticated'')', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 0008_job_queue.sql
-- ------------------------------------------------------------
-- Fischer — background audit queue
-- Run after 0007_journeys_alerts.sql.

alter table audits add column if not exists attempts int not null default 0;
alter table audits add column if not exists locked_at timestamptz;
alter table audits add column if not exists queued_at timestamptz;
create index if not exists audits_queue_idx on audits(status, queued_at) where status in ('queued', 'running');

-- Atomically claims the next audit to process. SKIP LOCKED lets several
-- workers run at once without picking the same job. Jobs stuck in "running"
-- for 10+ minutes (worker crashed/timed out) are picked up again.
create or replace function claim_next_audit(max_attempts int default 3)
returns setof audits
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update audits a set status = 'running', locked_at = now(), attempts = a.attempts + 1
  where a.id = (
    select id from audits
    where (status = 'queued' or (status = 'running' and locked_at < now() - interval '10 minutes'))
      and attempts < max_attempts
    order by queued_at nulls first, created_at
    for update skip locked
    limit 1
  )
  returning a.*;
end $$;

-- Jobs that exhausted their attempts while stuck in "running" are marked failed.
create or replace function fail_stuck_audits(max_attempts int default 3)
returns int
language sql
security definer
set search_path = public
as $$
  with f as (
    update audits set status = 'failed', error_message = coalesce(error_message, 'Timed out after ' || max_attempts || ' attempts.')
    where status = 'running' and locked_at < now() - interval '10 minutes' and attempts >= max_attempts
    returning 1
  ) select count(*)::int from f;
$$;

revoke all on function claim_next_audit(int) from public, anon, authenticated;
revoke all on function fail_stuck_audits(int) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 0009_leads.sql
-- ------------------------------------------------------------
-- Fischer — CRM lead quality
-- Run after 0008_job_queue.sql.
-- Deliberately stores NO personal information (no names, emails, phones):
-- only the CRM's lead id, status, value and where the lead came from.

alter table clients add column if not exists lead_ingest_key_hash text;   -- sha256 of the ingest key

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  external_id text not null,               -- the CRM's id for this lead
  created_at timestamptz not null,         -- when the lead came in
  status text not null default 'new' check (status in ('new', 'contacted', 'qualified', 'unqualified', 'won', 'lost')),
  value numeric,                           -- deal value once won
  closed_at timestamptz,
  landing_page text,                       -- path, e.g. /quote
  utm_source text, utm_medium text, utm_campaign text,
  gclid text,
  channel text,                            -- optional CRM source label ("Website", "Google Ads"…)
  form_name text,
  updated_at timestamptz not null default now(),
  unique (client_id, external_id)
);
create index if not exists leads_client_created_idx on leads(client_id, created_at desc);

drop trigger if exists leads_set_updated_at on leads;
create trigger leads_set_updated_at before update on leads for each row execute function set_updated_at();

alter table leads enable row level security;
drop policy if exists "Authenticated users can read leads" on leads;
drop policy if exists "Authenticated users can write leads" on leads;
create policy "Authenticated users can read leads" on leads for select using (auth.role() = 'authenticated');
create policy "Authenticated users can write leads" on leads for all using (auth.role() = 'authenticated');

-- ------------------------------------------------------------
-- 0010_usage_errors.sql
-- ------------------------------------------------------------
-- Fischer — Claude usage/cost per call, and an error log
-- Run after 0009_leads.sql.

create table if not exists llm_usage (
  id uuid primary key default gen_random_uuid(),
  feature text not null,              -- audit | audit_scheduled | test_brief | pxl_score | competitor_audit | market_share | traffic_estimate | mockup
  client_id uuid references clients(id) on delete set null,
  audit_id uuid references audits(id) on delete set null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  web_searches int not null default 0,
  cost_usd numeric(10, 4) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists llm_usage_client_idx on llm_usage(client_id, created_at desc);
create index if not exists llm_usage_audit_idx on llm_usage(audit_id);

create table if not exists error_log (
  id uuid primary key default gen_random_uuid(),
  context text not null,              -- e.g. 'audit_pipeline', 'cron:monthly'
  message text not null,
  stack text,
  client_id uuid references clients(id) on delete set null,
  audit_id uuid references audits(id) on delete set null,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index if not exists error_log_created_idx on error_log(created_at desc);

alter table llm_usage enable row level security;
alter table error_log enable row level security;
do $$
declare t text;
begin
  foreach t in array array['llm_usage', 'error_log'] loop
    execute format('drop policy if exists "Authenticated users can read %1$s" on %1$s', t);
    execute format('create policy "Authenticated users can read %1$s" on %1$s for select using (auth.role() = ''authenticated'')', t);
  end loop;
end $$;
-- Writes come from the server (service role) only.

-- ------------------------------------------------------------
-- 0011_roles_portal.sql
-- ------------------------------------------------------------
-- Fischer — roles, client portal users, activity log, and per-client row-level security
-- Run after 0010_usage_errors.sql.
--
-- Before this migration any logged-in user could read and write everything.
-- After it:
--   team admin    → everything, incl. team management and client deletion
--   team analyst  → read/write all client work
--   team viewer   → read-only
--   client user   → read-only, and only their own client's rows
--   anyone else   → nothing
-- Every EXISTING user is made a team admin below, so nobody is locked out.

create table if not exists team_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'analyst' check (role in ('admin', 'analyst', 'viewer')),
  created_at timestamptz not null default now()
);

create table if not exists client_users (
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, client_id)
);
create index if not exists client_users_client_idx on client_users(client_id);

create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  action text not null,                  -- e.g. 'client.update', 'report.share', 'backlog.ship'
  entity_type text,
  entity_id text,
  client_id uuid references clients(id) on delete set null,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_log_created_idx on activity_log(created_at desc);
create index if not exists activity_log_client_idx on activity_log(client_id, created_at desc);

-- Keep existing users working: all current accounts become admins.
insert into team_members (user_id, role)
select id, 'admin' from auth.users
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------- helper functions
create or replace function fischer_team_role() returns text
language sql stable security definer set search_path = public as $$
  select role from team_members where user_id = auth.uid()
$$;

create or replace function fischer_is_team() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where user_id = auth.uid())
$$;

create or replace function fischer_is_writer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where user_id = auth.uid() and role in ('admin', 'analyst'))
$$;

create or replace function fischer_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_members where user_id = auth.uid() and role = 'admin')
$$;

create or replace function fischer_can_read_client(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select fischer_is_team() or (cid is not null and exists (select 1 from client_users where user_id = auth.uid() and client_id = cid))
$$;

-- Used by middleware: 'admin' | 'analyst' | 'viewer' | 'client' | null
create or replace function fischer_whoami() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role from team_members where user_id = auth.uid()),
    (select 'client' from client_users where user_id = auth.uid() limit 1)
  )
$$;

grant execute on function fischer_team_role(), fischer_is_team(), fischer_is_writer(), fischer_is_admin(),
  fischer_can_read_client(uuid), fischer_whoami() to authenticated;

-- ---------------------------------------------------------------- replace all policies
do $$
declare
  t text;
  pol record;
  client_tables text[] := array['backlog_items', 'guardrail_metrics', 'competitor_audits', 'market_share_analyses',
    'test_briefs', 'tracked_pages', 'monthly_snapshots', 'clarity_daily', 'change_log', 'report_shares',
    'leak_analyses', 'journey_checks', 'leads'];
  team_only text[] := array['guardrail_checks', 'llm_usage', 'activity_log'];
  all_tables text[] := client_tables || team_only || array['clients', 'audits', 'alerts', 'error_log', 'team_members', 'client_users'];
begin
  foreach t in array all_tables loop
    execute format('alter table %I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on %I', pol.policyname, t);
    end loop;
  end loop;

  -- Tables keyed by client: clients' users may read their own rows; team writers write.
  foreach t in array client_tables loop
    execute format('create policy fischer_read on %I for select using (fischer_can_read_client(client_id))', t);
    execute format('create policy fischer_write on %I for all using (fischer_is_writer()) with check (fischer_is_writer())', t);
  end loop;

  foreach t in array team_only loop
    execute format('create policy fischer_read on %I for select using (fischer_is_team())', t);
    execute format('create policy fischer_write on %I for all using (fischer_is_writer()) with check (fischer_is_writer())', t);
  end loop;
end $$;

create policy fischer_read on clients for select using (fischer_can_read_client(id));
create policy fischer_write on clients for all using (fischer_is_writer()) with check (fischer_is_writer());

-- Audits without a client (one-off audits) are visible to the team only.
create policy fischer_read on audits for select using (fischer_can_read_client(client_id) or (client_id is null and fischer_is_team()));
create policy fischer_write on audits for all using (fischer_is_writer()) with check (fischer_is_writer());

create policy fischer_read on alerts for select using (fischer_is_team());
create policy fischer_write on alerts for all using (fischer_is_writer()) with check (fischer_is_writer());

create policy fischer_read on error_log for select using (fischer_is_admin());

create policy fischer_read on team_members for select using (fischer_is_team());
create policy fischer_write on team_members for all using (fischer_is_admin()) with check (fischer_is_admin());

create policy fischer_read on client_users for select using (fischer_is_team() or user_id = auth.uid());
create policy fischer_write on client_users for all using (fischer_is_admin()) with check (fischer_is_admin());

-- ---------------------------------------------------------------- storage
drop policy if exists "Authenticated users can upload screenshots" on storage.objects;
drop policy if exists "Authenticated users can update screenshots" on storage.objects;
drop policy if exists "Team can upload screenshots" on storage.objects;
drop policy if exists "Team can update screenshots" on storage.objects;
create policy "Team can upload screenshots" on storage.objects
  for insert with check (bucket_id = 'fischer-screenshots' and fischer_is_writer());
create policy "Team can update screenshots" on storage.objects
  for update using (bucket_id = 'fischer-screenshots' and fischer_is_writer());

-- ------------------------------------------------------------
-- 0012_google_connect.sql
-- ------------------------------------------------------------
-- Fischer — one-click Google connection (GA4, Search Console, Google Ads)
-- Run after 0011_roles_portal.sql.
alter table clients add column if not exists google_refresh_token text;      -- encrypted (lib/secrets.ts)
alter table clients add column if not exists google_email text;              -- which Google account was connected
alter table clients add column if not exists google_connected_at timestamptz;
alter table clients add column if not exists gsc_site_url text;              -- e.g. 'sc-domain:acme.co.za' or 'https://www.acme.co.za/'
alter table clients add column if not exists google_ads_customer_id text;    -- 123-456-7890
alter table clients add column if not exists google_ads_login_customer_id text; -- manager (MCC) id, if accessed through one

-- ------------------------------------------------------------
-- 0013_mockups_kit_tests.sql
-- ------------------------------------------------------------
-- Fischer — visual mockups and A/B tests run by the tracking kit
-- Run after 0012_google_connect.sql.

create table if not exists mockups (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  audit_id uuid references audits(id) on delete cascade,
  test_brief_id uuid references test_briefs(id) on delete cascade,
  source text not null,                 -- 'finding' | 'hypothesis' | 'test'
  source_index int,
  title text not null,
  page_url text not null,
  viewport text not null,
  ops jsonb not null,                   -- lib/dom-ops.ts DomOp[]
  summary text,
  applied jsonb,
  before_url text,
  after_url text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists mockups_audit_idx on mockups(audit_id);
create index if not exists mockups_test_idx on mockups(test_brief_id);

-- Tests run by the tracking kit (public/fischer-tracking.js)
alter table test_briefs add column if not exists variant_ops jsonb;          -- DomOp[] applied for the variant
alter table test_briefs add column if not exists kit_key text;               -- short id, e.g. 'fx7k2'
alter table test_briefs add column if not exists kit_live boolean not null default false;
alter table test_briefs add column if not exists kit_split numeric not null default 0.5;    -- share of visitors in the variant
alter table test_briefs add column if not exists kit_url_match text;         -- path, or prefix ending in *
alter table test_briefs add column if not exists kit_device text not null default 'all' check (kit_device in ('all', 'mobile', 'desktop'));
create unique index if not exists test_briefs_kit_key on test_briefs(kit_key) where kit_key is not null;

alter table mockups enable row level security;
drop policy if exists fischer_read on mockups;
drop policy if exists fischer_write on mockups;
create policy fischer_read on mockups for select using (fischer_can_read_client(client_id) or (client_id is null and fischer_is_team()));
create policy fischer_write on mockups for all using (fischer_is_writer()) with check (fischer_is_writer());

-- ------------------------------------------------------------
-- 0014_branding_emails_a11y_discovery.sql
-- ------------------------------------------------------------
-- Fischer — agency branding, scheduled report emails, accessibility results, site discovery
-- Run after 0013_mockups_kit_tests.sql.

-- One row of agency-wide settings (id is always 1)
create table if not exists agency_settings (
  id int primary key default 1 check (id = 1),
  agency_name text not null default 'Algorithm Agency',
  logo_url text,
  primary_color text not null default '#0B1F3A',
  accent_color text not null default '#C98A00',
  report_footer text,
  show_fischer_name boolean not null default true,     -- "prepared … with Fischer" on reports
  email_from text,                                      -- e.g. 'Reports <reports@algorithm.agency>' (verified sender domain)
  email_reply_to text,
  updated_at timestamptz not null default now()
);
insert into agency_settings (id) values (1) on conflict (id) do nothing;

alter table clients add column if not exists report_recipients text[] not null default '{}';
alter table clients add column if not exists report_email_enabled boolean not null default false;
alter table clients add column if not exists report_email_day int not null default 5 check (report_email_day between 1 and 28);

create table if not exists report_emails (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  period date not null,
  recipients text[] not null,
  status text not null check (status in ('sent', 'failed')),
  error text,
  share_token text,
  sent_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists report_emails_client_idx on report_emails(client_id, period);

alter table audits add column if not exists accessibility jsonb;   -- lib/accessibility.ts summary

create table if not exists site_scans (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  result jsonb not null,                                -- lib/discovery.ts DiscoveryResult
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists site_scans_client_idx on site_scans(client_id, created_at desc);

alter table agency_settings enable row level security;
alter table report_emails enable row level security;
alter table site_scans enable row level security;
drop policy if exists fischer_read on agency_settings;
drop policy if exists fischer_write on agency_settings;
drop policy if exists fischer_read on report_emails;
drop policy if exists fischer_write on report_emails;
drop policy if exists fischer_read on site_scans;
drop policy if exists fischer_write on site_scans;
create policy fischer_read on agency_settings for select using (fischer_is_team() or exists (select 1 from client_users where user_id = auth.uid()));
create policy fischer_write on agency_settings for all using (fischer_is_admin()) with check (fischer_is_admin());
create policy fischer_read on report_emails for select using (fischer_is_team());
create policy fischer_write on report_emails for all using (fischer_is_writer()) with check (fischer_is_writer());
create policy fischer_read on site_scans for select using (fischer_is_team());
create policy fischer_write on site_scans for all using (fischer_is_writer()) with check (fischer_is_writer());

-- ------------------------------------------------------------
-- 0015_drop_audit_pairs_view.sql
-- ------------------------------------------------------------
-- Fischer — remove the unused audit_pairs view.
-- Run after 0014_branding_emails_a11y_discovery.sql.
--
-- Views run with their owner's rights by default, so this view bypassed the
-- row-level security on `audits`: through Supabase's API any logged-in user
-- (including client portal logins) could read every client's audits. Nothing
-- in Fischer uses it (audit comparison queries the audits table directly).
drop view if exists audit_pairs;
