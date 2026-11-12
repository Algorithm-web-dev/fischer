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
