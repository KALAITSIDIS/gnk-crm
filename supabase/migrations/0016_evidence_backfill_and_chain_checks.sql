-- =============================================================================
-- 0016 — evidence_report backfill + nightly hash-chain verification
--        (T-audit-reports follow-up; enum value added in 0015)
--
-- 1. Backfill existing generated reports to doc_type 'evidence_report'.
--    storage_path is the reliable key — reports.ts writes
--    '<org>/reports/evidence-<contact>-<stamp>.pdf' and the path column is
--    trigger-frozen (protect_document_columns), unlike the editable title.
--
-- 2. chain_checks: one row per org with the latest verify_events_chain()
--    result, refreshed nightly by pg_cron. The commission-evidence preview
--    stopped running the org-wide chain walk on every GET (T-audit-reports —
--    it is O(all org events)); this gives the preview and /reports an honest
--    "last verified" badge instead. Generation still verifies live.
-- =============================================================================

update documents
set doc_type = 'evidence_report'
where doc_type = 'other' and storage_path like '%/reports/evidence-%';

-- ---------- chain_checks: staff-readable nightly verification cache ----------
create table chain_checks (
  org_id uuid primary key references organizations(id),
  checked_at timestamptz not null,
  ok boolean not null
);

alter table chain_checks enable row level security;
revoke all on chain_checks from anon, authenticated;
grant select on chain_checks to authenticated;

create policy chain_checks_select on chain_checks for select
  using (org_id = current_org_id());
-- no insert/update/delete policies: only the cron function writes

create or replace function run_chain_checks() returns void
language sql security definer set search_path = public as $$
  insert into chain_checks (org_id, checked_at, ok)
  select o.id, now(), verify_events_chain(o.id) from organizations o
  on conflict (org_id) do update
    set checked_at = excluded.checked_at, ok = excluded.ok;
$$;
revoke execute on function run_chain_checks() from public, anon, authenticated;

-- 03:30 nightly, after expire-mandates (03:00) so its events are covered too
select cron.schedule('verify-events-chain', '30 3 * * *', $$select run_chain_checks()$$);

-- seed the cache so the badge is live immediately, not first at 03:30
select run_chain_checks();
