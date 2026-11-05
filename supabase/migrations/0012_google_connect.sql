-- Fischer — one-click Google connection (GA4, Search Console, Google Ads)
-- Run after 0011_roles_portal.sql.
alter table clients add column if not exists google_refresh_token text;      -- encrypted (lib/secrets.ts)
alter table clients add column if not exists google_email text;              -- which Google account was connected
alter table clients add column if not exists google_connected_at timestamptz;
alter table clients add column if not exists gsc_site_url text;              -- e.g. 'sc-domain:acme.co.za' or 'https://www.acme.co.za/'
alter table clients add column if not exists google_ads_customer_id text;    -- 123-456-7890
alter table clients add column if not exists google_ads_login_customer_id text; -- manager (MCC) id, if accessed through one
