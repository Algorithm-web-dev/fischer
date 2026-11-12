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
