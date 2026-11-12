-- Fischer — agency branding, scheduled report emails, accessibility results, site discovery
-- Run after 0013_mockups_kit_tests.sql.

-- One row of agency-wide settings (id is always 1)
create table if not exists agency_settings (
  id int primary key default 1 check (id = 1),
  agency_name text not null default 'Algorithm Agency',
  logo_url text,
  primary_color text not null default '#0B1F3A',
  accent_color text not null default '#C98A00',
  report_footer text,
  show_fischer_name boolean not null default true,     -- "prepared … with Fischer" on reports
  email_from text,                                      -- e.g. 'Reports <reports@algorithm.agency>' (verified sender domain)
  email_reply_to text,
  updated_at timestamptz not null default now()
);
insert into agency_settings (id) values (1) on conflict (id) do nothing;

alter table clients add column if not exists report_recipients text[] not null default '{}';
alter table clients add column if not exists report_email_enabled boolean not null default false;
alter table clients add column if not exists report_email_day int not null default 5 check (report_email_day between 1 and 28);

create table if not exists report_emails (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  period date not null,
  recipients text[] not null,
  status text not null check (status in ('sent', 'failed')),
  error text,
  share_token text,
  sent_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists report_emails_client_idx on report_emails(client_id, period);

alter table audits add column if not exists accessibility jsonb;   -- lib/accessibility.ts summary

create table if not exists site_scans (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  result jsonb not null,                                -- lib/discovery.ts DiscoveryResult
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists site_scans_client_idx on site_scans(client_id, created_at desc);

alter table agency_settings enable row level security;
alter table report_emails enable row level security;
alter table site_scans enable row level security;
drop policy if exists fischer_read on agency_settings;
drop policy if exists fischer_write on agency_settings;
drop policy if exists fischer_read on report_emails;
drop policy if exists fischer_write on report_emails;
drop policy if exists fischer_read on site_scans;
drop policy if exists fischer_write on site_scans;
create policy fischer_read on agency_settings for select using (fischer_is_team() or exists (select 1 from client_users where user_id = auth.uid()));
create policy fischer_write on agency_settings for all using (fischer_is_admin()) with check (fischer_is_admin());
create policy fischer_read on report_emails for select using (fischer_is_team());
create policy fischer_write on report_emails for all using (fischer_is_writer()) with check (fischer_is_writer());
create policy fischer_read on site_scans for select using (fischer_is_team());
create policy fischer_write on site_scans for all using (fischer_is_writer()) with check (fischer_is_writer());
