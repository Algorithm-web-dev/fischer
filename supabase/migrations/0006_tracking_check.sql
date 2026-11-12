-- Fischer — tracking health check stored with each audit
-- Run after 0005_revenue_leaks.sql.
alter table audits add column if not exists tracking jsonb;   -- lib/tracking.ts TrackingReport
