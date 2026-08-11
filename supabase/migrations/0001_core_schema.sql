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
