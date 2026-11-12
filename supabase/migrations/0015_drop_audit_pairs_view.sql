-- Fischer — remove the unused audit_pairs view.
-- Run after 0014_branding_emails_a11y_discovery.sql.
--
-- Views run with their owner's rights by default, so this view bypassed the
-- row-level security on `audits`: through Supabase's API any logged-in user
-- (including client portal logins) could read every client's audits. Nothing
-- in Fischer uses it (audit comparison queries the audits table directly).
drop view if exists audit_pairs;
