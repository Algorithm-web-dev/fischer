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
