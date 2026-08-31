-- 0072 — KYC contact documents are admin-only (audit 2026-08-29, SEC-02).
--
-- Passport scans, proof of address and source-of-funds declarations are the
-- most sensitive PII this desk holds — AML CDD records. Yet contact-document
-- uploads never set a visibility, so every row defaulted to 'internal', which
-- `documents_select` (0002) shows to EVERY staff role. The stricter
-- 'admin_only' tier has existed since 0001 and was already used for evidence
-- PDFs (lib/actions/reports.ts) — just never for KYC uploads. Nothing is
-- exposed today (both production users are admins); this closes the landmine
-- before the first agent or listing-manager hire steps on it.
--
-- Three layers land together:
--   app     uploadContactDocument now sets visibility via
--           contactDocVisibility() — 'admin_only' for the three KYC types,
--           'internal' for contract/other (need-to-know, not blanket).
--   data    the backfill below flips any existing internal KYC rows.
--   schema  a CHECK makes the invariant hold against every FUTURE path —
--           import scripts and service-role writers bypass the app layer and
--           RLS, but not a constraint. Same lesson as construction_status
--           (audit DB-07): an app-layer vocabulary without a DB guard drifts.
--
-- The documents_protect trigger (0002) freezes `visibility` on UPDATE for
-- app sessions, but its guard is `auth.uid() is not null` — a migration runs
-- as postgres with a null uid, so the backfill passes it BY DESIGN, not by
-- accident. Row-count expectations: production holds operator test data and
-- likely zero contact KYC rows; CI and fresh local databases hold none. The
-- backfill is therefore usually a no-op, and the CHECK is the part that earns
-- its keep.
--
-- ⚠️ DEPLOY ORDER IS INVERTED — CODE FIRST, THEN THIS MIGRATION (the
-- 0055/0057 rule, §0a trap 2). Pre-0072 code inserts KYC docs WITHOUT a
-- visibility, so the column defaults to 'internal' and this CHECK would
-- refuse every contact KYC upload in the window between a hosted apply and
-- the deploy. A refusal is the correct failure DIRECTION for CDD records
-- (loud error beats silent over-exposure), but a wrong ORDER manufactures
-- that failure needlessly: merge, confirm the deploy READY and aliased, and
-- only then apply this to hosted. Fresh databases (CI, local reset) apply it
-- against the new code and never see the gap. 0071 in the same change is
-- ordinary additive-first — the two migrations ship with OPPOSITE orders,
-- which is why each one says its own.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

update public.documents
   set visibility = 'admin_only'
 where entity_type = 'contact'
   and doc_type in ('id_document', 'proof_of_address', 'source_of_funds')
   and visibility <> 'admin_only';

-- Re-run guard added 2026-09-01 (post-audit review): drop-if-exists before
-- each add, the 0045/0049/0054 idiom. INERT on first run; makes a replay
-- (restore-path db push against an already-migrated DB) a no-op instead of
-- a 42710 abort. The assertion block below re-proves the constraint exists.
alter table public.documents
  drop constraint if exists documents_contact_kyc_admin_only;
alter table public.documents
  add constraint documents_contact_kyc_admin_only
  check (not (entity_type = 'contact'
              and doc_type in ('id_document', 'proof_of_address', 'source_of_funds')
              and visibility <> 'admin_only'));

do $$
declare
  n int;
begin
  select count(*) into n
    from public.documents
   where entity_type = 'contact'
     and doc_type in ('id_document', 'proof_of_address', 'source_of_funds')
     and visibility <> 'admin_only';
  if n <> 0 then
    raise exception '0072 aborted: % contact KYC document(s) still readable org-wide', n;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'documents_contact_kyc_admin_only'
       and conrelid = 'public.documents'::regclass
       and convalidated
  ) then
    raise exception '0072 aborted: the KYC visibility CHECK is missing or not validated';
  end if;

  -- prove the refusal with a live probe, in a subtransaction that either way
  -- writes nothing. SKIPPED on a database with no organizations — which is
  -- what CI and the shadow DB apply migrations to — and the NOTICE says so
  -- rather than claiming a pass (the 0050 lesson); RLS test 48 probes the
  -- refusal unconditionally on the seeded test org.
  if exists (select 1 from public.organizations) then
    begin
      insert into public.documents (org_id, entity_type, entity_id, doc_type, title, storage_path, visibility)
      values ((select id from public.organizations limit 1), 'contact', gen_random_uuid(),
              'id_document', '0072 probe', '0072/probe.pdf', 'internal');
      raise exception '0072 aborted: an internal KYC contact document was ACCEPTED';
    exception
      when check_violation then null; -- exactly the refusal the constraint exists for
    end;
    raise notice '0072: probe — internal KYC contact document refused, as designed';
  else
    raise notice '0072: probe SKIPPED — no organizations on this database (fresh apply); the CHECK is validated above and RLS test 48 covers the refusal';
  end if;

  raise notice '0072: contact KYC documents are admin-only — backfill clean, CHECK validated';
end $$;
