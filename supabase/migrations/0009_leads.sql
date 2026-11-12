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
