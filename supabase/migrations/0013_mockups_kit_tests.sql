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
