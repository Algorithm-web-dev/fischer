-- Fischer — background audit queue
-- Run after 0007_journeys_alerts.sql.

alter table audits add column if not exists attempts int not null default 0;
alter table audits add column if not exists locked_at timestamptz;
alter table audits add column if not exists queued_at timestamptz;
create index if not exists audits_queue_idx on audits(status, queued_at) where status in ('queued', 'running');

-- Atomically claims the next audit to process. SKIP LOCKED lets several
-- workers run at once without picking the same job. Jobs stuck in "running"
-- for 10+ minutes (worker crashed/timed out) are picked up again.
create or replace function claim_next_audit(max_attempts int default 3)
returns setof audits
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update audits a set status = 'running', locked_at = now(), attempts = a.attempts + 1
  where a.id = (
    select id from audits
    where (status = 'queued' or (status = 'running' and locked_at < now() - interval '10 minutes'))
      and attempts < max_attempts
    order by queued_at nulls first, created_at
    for update skip locked
    limit 1
  )
  returning a.*;
end $$;

-- Jobs that exhausted their attempts while stuck in "running" are marked failed.
create or replace function fail_stuck_audits(max_attempts int default 3)
returns int
language sql
security definer
set search_path = public
as $$
  with f as (
    update audits set status = 'failed', error_message = coalesce(error_message, 'Timed out after ' || max_attempts || ' attempts.')
    where status = 'running' and locked_at < now() - interval '10 minutes' and attempts >= max_attempts
    returning 1
  ) select count(*)::int from f;
$$;

revoke all on function claim_next_audit(int) from public, anon, authenticated;
revoke all on function fail_stuck_audits(int) from public, anon, authenticated;
