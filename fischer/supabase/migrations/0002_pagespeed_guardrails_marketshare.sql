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
