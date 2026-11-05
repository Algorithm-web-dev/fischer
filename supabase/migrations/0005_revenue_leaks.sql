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
