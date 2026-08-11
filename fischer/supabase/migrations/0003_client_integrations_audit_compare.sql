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
