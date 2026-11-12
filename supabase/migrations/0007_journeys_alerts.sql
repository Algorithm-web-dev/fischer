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
