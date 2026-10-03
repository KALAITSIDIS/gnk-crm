-- =============================================================================
-- 0134 — an erased contact stays erased: a session can neither write a
--        contact's erasure record nor bring an erased contact back, the
--        records its retention keeps are destroyed only by the retention
--        purge, and the record the erasure trusts is the system's
--
-- THE GAP (external audit brief, 2026-10-02; reproduced independently the
-- same day against 0d43711 through PostgREST with real aal2 sessions of
-- throwaway organisations AND through the real server actions of 0d43711 —
-- a throwaway demonstration on the shared stack at 0133 printed each chained
-- step below; supabase/tests/erasure-lifecycle.test.ts pins the database
-- half RED on the 0132 schema — see DECISIONS T-erasure-lifecycle-guard for
-- the counts and which test fails for which reason):
--
--   * contacts_update (0100) restricts ROWS (an admin of the organisation,
--     or the contact's assigned or creating agent), never columns, and
--     `authenticated` holds UPDATE on every column; no trigger bound the
--     erasure state (0017 added the columns with none). So an aal2 admin and
--     the assigned agent could each PATCH an ERASED contact's `erased_at` to
--     null and then pass `unarchiveContact`'s own conditions (it filters
--     `erased_at is null`), or PATCH `is_archived` false directly — the
--     retained identity then re-took its phone's and e-mail's slots under
--     contacts_phone_unique / contacts_email_unique (partial on
--     `is_archived = false`: a new contact with that phone got 23505), and
--     with `temperature = 'hot'` matched the agent dashboard's hot-buyer
--     card; `consent_marketing` could be re-enabled against the
--     hash-chained consent trail; `erased_by` re-attributed; any field the
--     erasure cleared written back.
--   * `retention_until` likewise: an admin PATCHed a retained contact's date
--     into the past and the real purgeExpiredRetention then destroyed the
--     KYC file Cyprus AML still required (measured: a 2031 duty, file gone
--     the same day); an agent PATCHed it to null, which takes the contact
--     off /settings/retention and closes create_followup_nudges' retention
--     task (0126 arm 4c) — the files are kept for ever.
--   * The retained files themselves: documents_delete (0002) admits any
--     admin of the organisation, and deleteContactDocument offered Delete on
--     an erased contact's documents — so the KYC records the erasure kept
--     under the AML duty could be destroyed years before `retention_until`,
--     through the ordinary Documents tab (measured: row and file gone), and a
--     direct DELETE of the row alone left the file where the purge would
--     never find it. The purge is meant to be the only destroyer
--     (DECISIONS T-retention-expiry; 0078).
--   * contacts_insert (0030) checks organisation and role only: an admin,
--     agent or listing manager could INSERT a contact already "erased" or
--     "retained".
--   * The erasure trusts both halves of its record, and a session could
--     forge either. `erased_at` set with no `erased` event is the
--     half-finished case its re-run exists for (lib/services/erasure-run.ts),
--     which SKIPS the contact patch — so a session's forged marker on a LIVE
--     contact made the real erasure report success, leave notes, profile,
--     consent and temperature as they were, and write an `erased` event
--     whose `fields_cleared` claims them cleared (measured). And
--     events_insert (0131) admits a session's contact `erased` event: with
--     the marker forged too, the real erasure answered "already erased" and
--     redacted nothing (measured).
--   * Unchanged by any of it (measured): existing events and their hashes,
--     verify_events_chain. Refused already: a peer agent, a listing
--     manager, a deactivated assignee, another organisation's admin, aal1
--     (RLS filters the row — zero rows, no error), and anon (no grant on
--     contacts at all — 42501 permission denied).
--   * Production was NOT probed (the brief: no production data). Hosted held
--     1 erased contact and 0 erased-but-active on 2026-09-23 (DECISIONS
--     T-refuse-unarchive-erased); the diagnostic below counts what is there
--     when this file is applied.
--
-- THE CONTRACT ENFORCED (the repository's own, not a new policy): erasure is
-- irreversible (spec docs/superpowers/specs/2026-07-21-gdpr-contact-erasure-
-- design.md; DECISIONS T-contact-erasure); the erased contact "becomes
-- read-only, like an archived contact" and "is frozen for everyone:
-- re-editing it would re-create the personal data the erasure request
-- removed" (spec; the contact page); it stays archived, and an erased
-- contact left active may be archived — "the way back to the state erasure
-- left it in" (T-refuse-unarchive-erased); `erased_at` / `erased_by` are the
-- audit record and outlive the purge (T-retention-expiry); `retention_until`
-- is written by the erasure and cleared by the purge, on or after that date,
-- and "purgeExpiredRetention stays the only destroyer" of what it keeps.
--
-- THE FIX:
--   A. public.trg_contacts_erasure_lifecycle(): a SECURITY INVOKER trigger
--      function (owner postgres, search_path public, pg_temp, EXECUTE revoked
--      from every role), attached as `contacts_retain_erasure` BEFORE INSERT
--      OR UPDATE ON contacts FOR EACH ROW. For a session (current_user
--      authenticated or anon — the statement's role, as in 0118 / 0127 /
--      0131 / 0132) it refuses with 42501:
--        - an INSERT carrying `erased_at`, `erased_by` or `retention_until`
--          ("A contact's erasure record is written only by its erasure");
--        - an UPDATE that changes any of the three — on any contact; a write
--          restating them passes ("… only by its erasure and the retention
--          purge");
--        - any change to a contact whose `erased_at` was set, but archiving
--          it ("An erased contact stays as its erasure left it — archiving
--          it is the one change allowed"). The comparison is the whole row
--          as jsonb less `updated_at` (contacts_updated stamps it) and
--          `display_name` (generated; a BEFORE trigger cannot read its new
--          value), so a column added later is covered without an edit here.
--      The refusal names the columns. A PATCH, a bulk PATCH (the whole
--      statement fails — no partial change), an upsert's insert arm and its
--      update arm all reach it. It fires only on rows RLS has admitted
--      (UPDATE) — a caller RLS filters out learns nothing — and, on INSERT,
--      it judges the proposed row's own values, nothing stored.
--   B. public.trg_documents_kept_for_retention(): the same posture, attached
--      as `documents_kept_for_retention` BEFORE DELETE ON documents FOR EACH
--      ROW: a session may not delete a document of an erased contact whose
--      retention date is set — the records the retention keeps ("An erased
--      contact's retained documents are kept until the retention purge
--      destroys them"). An erasure deletes a contact's documents BEFORE its
--      marker is set, and the purge after its date — both now as the system.
--      A document on an erased contact WITHOUT a retention date is under no
--      duty (it can only have been attached since — e.g. a commission
--      evidence report, which generateEvidenceReport may still add for an
--      erased contact) and stays deletable. INSERT is not refused, for that
--      reason.
--   C. events_insert gains `event_type not in ('erased', 'retention_purged')`
--      under any entity_type, as 0131 did for stage_changed: the erasure's
--      record and the purge's are written only by those actions, now as the
--      system — so the `erased` event a re-run reads as "already complete" is
--      one no session can forge from here on. 0131's clauses are kept
--      verbatim, `stage_changed` as its own clause (0131's restore-pack row
--      reads it).
--   D. The application (deploy-coupled — DEPLOY ORDER): eraseContactPersonalData
--      writes its document-row delete, its contact patch and its `erased`
--      event, and purgeExpiredRetention its document-row delete, its marker
--      update and its `retention_purged` event, through the service role —
--      after the actions' own checks (an aal2, active admin; the contact read
--      through RLS in the caller's organisation; the typed name / the expired
--      date on an erased contact), bounded by that organisation and contact,
--      conditional as before (`erased_at is null`; the purge on the date it
--      decided on and on the contact being erased). A re-run no longer
--      records an erasure the row does not show, takes the first run's AML
--      decision from the row and refuses when today's basis reads otherwise;
--      the erasure deletes exactly the document rows whose files it removed.
--      mergeContacts refuses an erased contact on either side, and holds that
--      at its archive of the duplicate and its backfill of the primary;
--      deleteContactDocument refuses an erased contact's retained documents,
--      uploadContactDocument, updateContactSection and savePartyDefaults an
--      erased contact; the contact page offers no Terms edit, no upload and
--      no Delete of a retained document on one; /settings/retention lists
--      erased contacts only. removeObjectsOrFail (lib/services/storage.ts)
--      now reads storage-js's answer for an ABSENT object (`{ data: false,
--      error: <its 400> }`, measured) as absent — it read it as "could not
--      confirm", so a purge or erasure re-run after files were already
--      removed failed for good, and with B a session could no longer clear
--      such a row by hand.
--
-- TRUSTED PATHS, deliberately (parity with 0118 / 0127 / 0131 / 0132): the
-- service role, postgres and SECURITY DEFINER bodies owned by postgres are
-- not bound — the two actions above, the merge, the CSV importer, fixtures,
-- maintenance and restores (both restore paths run in replica mode, where
-- user triggers do not fire). No SQL function, trigger or cron job writes
-- contacts or deletes documents (measured: the only write statements on
-- contacts in any migration are rolled-back probes), so no definer body is a
-- second door — and the preflight refuses to apply over one (0118's
-- tripwire), as the test file's catalogue test holds every later migration
-- to. The merge's re-parenting of contacts merged into its duplicate
-- (`merged_into_id`) also reaches an erased one: bookkeeping by the trusted
-- path, deliberately left as it is.
--
-- WHY NOT the alternatives:
--   * Definer RPCs for the writes: the retention date is computed in
--     TypeScript from the AML basis (resolveRetentionAnchor, Cyprus day keys);
--     an RPC either takes it as an argument — a setter any admin can call
--     with a past date, the very bypass — or re-implements the anchor in SQL.
--     And the storage removal cannot move into SQL, so the workflow would be
--     split across two trust models.
--   * Column privileges: a statement merely NAMING a column is refused, and
--     every column added later would be silently read-only (0132's WHY NOT);
--     they also cannot express "frozen once erased" or "restating passes".
--   * A CHECK (erased_at is null or is_archived): binds every writer,
--     including the fixtures that create the legacy state on purpose, and
--     says nothing about the record, the retention date or the documents
--     (T-refuse-unarchive-erased considered and declined it).
--
-- CONTRACT. No function the application calls changes, so no release-compat
-- entry; lib/supabase/database.types.ts lists no trigger functions and
-- regenerates identically (measured).
--
-- DEPLOY ORDER — INVERTED (HANDOFF's destructive-change rule: the deployed
-- application must not lose a write it still makes). The application
-- deployed at 0d43711 sends, through the SESSION, writes this file refuses:
-- the erasure's contact patch, its `erased` event and (on a re-run) its
-- document-row delete; the purge's document-row delete, marker update and
-- `retention_purged` event; deleteContactDocument on an erased contact's
-- retained document; savePartyDefaults (the old page offers an admin the
-- Terms form) and updateContactSection (on an erased contact left active)
-- on an erased contact. Each step of the erasure and the purge is its own
-- request and commits on its own, so the refusal lands AFTER irreversible
-- work: an old-app erasure on 0134 redacts lead messages and notes, deletes
-- saved searches and (with no AML basis) the files and rows, and then fails
-- at the contact patch ("Erasure stopped while redacting the contact …") —
-- the contact stays active and unredacted until the new app erases it, and
-- that later run's append-only `erased` event counts 0 for what the old run
-- destroyed; an old-app purge removes the retained FILES, then is refused at
-- the row delete ("The files are gone but their records were not
-- deleted"): the rows survive pointing at removed objects and the marker
-- stays, until the new app's purge deletes those rows (it reads the absent
-- objects as absent) and records them. The new application works against
-- 0132 and against 0134 (the service role is bound by neither; measured: on
-- the 0132 schema every real-action path of the test file passes). So:
-- merge, deploy, CONFIRM THE DEPLOYED SHA, then apply this file — NOT the
-- usual "apply to hosted and merge". Before merging, read hosted READ-ONLY
-- what the preflight expects (events_insert's check under the fixed
-- search_path, the triggers on contacts and documents, contacts' generated
-- columns, no definer writer of contacts / documents) and run the
-- diagnostic's SELECTs, so a refusal is known before the app ships.
-- ROLLBACK FLOOR: with hosted at 0134, never roll the application back past
-- the merge that ships this change; roll 0134 back first.
--
-- VISIBLE CHANGES FOR A DIRECT POSTGREST CALLER (the application sends none
-- of these after the deploy): a session's write named above answers 403 /
-- 42501 with the sentence naming the columns; a session's DELETE of an
-- erased contact's retained document answers 403 / 42501; a session's POST of an
-- `erased` or `retention_purged` event answers 403 / 42501 (RLS). Ordinary
-- edits, archiving and unarchiving of contacts that were never erased, their
-- documents, and restating writes are accepted as before.
--
-- LOCKS. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on contacts and on
-- documents — every write to them waits until this commits; reads do not —
-- both taken FIRST, in the preflight, contacts before documents (0132's
-- order); ALTER POLICY takes ACCESS EXCLUSIVE on events, LAST — reads of
-- events wait too, for the milliseconds between it and the commit, which is
-- also why the event-based diagnostic and the boundary are read there:
-- exact. The writers take them in this order (a document or contact write,
-- then its event). A wait beyond lock_timeout (5 s per table) ends in a
-- clean 55P03: nothing is kept, apply again, and do NOT write the ledger
-- row. ONE transaction (checked below). Apply as 0129 / 0131 / 0132 did:
-- outside 02:55–04:05 UTC, away from 06:00, at the middle of an odd minute
-- that is not a multiple of five.
--
-- PREFLIGHT. Refuses, changing nothing, unless (1) events_insert's check is
-- exactly 0131's, (2) the triggers on contacts are 0132's two — or those and
-- 0133's `contacts_id_without_history`, which may land before or after this
-- file — and those on documents 0132's two, (3) `display_name` is contacts'
-- only generated column, (4) the names this file creates are free, and (5)
-- no SECURITY DEFINER function writes contacts or deletes documents.
--
-- EXISTING ROWS — READ-ONLY DIAGNOSTIC, NO REPAIR. The guards bind future
-- session writes; they do not judge rows already stored, and this file
-- rewrites none. Counted and returned in the file's last row:
--   erased_but_active      erased, is_archived false (the legacy state);
--   erased_unredacted      erased, yet a field the erasure clears holds data
--                          or consent / temperature / languages are not as
--                          it left them, or kyc is not cleared where nothing
--                          was retained — the shape the erasure's re-run now
--                          checks (its is_archived check is reported as
--                          erased_but_active); a marker that may have been
--                          forged before 0134;
--   erased_without_eraser  erased_at set, erased_by null;
--   retained_not_erased    retention_until set on a contact never erased;
--   erased_documents_unretained  documents on erased contacts with no
--                          retention date (attached since the erasure —
--                          still deletable, see B);
--   erased_without_record  erased, no `erased` event in its organisation;
--   record_without_erasure contacts with an `erased` event in their
--                          organisation that are not erased (or are gone);
--   boundary               the largest event id when sessions lost the
--                          right to write `erased` / `retention_purged`:
--                          such events at or below it are not proven
--                          system-written (also kept as the comment on
--                          contacts_retain_erasure, as 0131 did).
-- RESOLUTION REQUIREMENT before the operator relies on these guarantees for
-- a counted row: erased_but_active → Archive on the contact page (the one
-- change a session may still make); erased_unredacted /
-- erased_without_eraser / retained_not_erased / record_without_erasure /
-- erased_documents_unretained → an operator decision per row, recorded in
-- DECISIONS and applied through the trusted path (service role / postgres)
-- — the erasure's re-run refuses an erased_unredacted row (and any row whose
-- retention basis reads otherwise than its stored decision) rather than
-- record it, but it would write the record of an erased_without_eraser row
-- attributed to the re-running admin, so decide that one first;
-- erased_without_record (and nothing else counted for it) → the erasure's
-- own re-run writes the missing record (the page offers no button once
-- erased: an operator runs the action). The local stack holds test residue
-- in several of these on purpose (fixtures write the legacy state as the
-- service role; rls.test.ts #54 adds one per run).
--
-- NOT CHANGED: who may read or update which rows (RLS); every other column
-- of a contact that was never erased; every other document, and INSERT of
-- documents (an evidence report may name an erased contact); DELETE of
-- contacts (no session may); the service role, postgres and definer bodies;
-- every other event type; existing events, notes and documents (nothing is
-- written, modified or moved); the 0132 primary-key guard
-- (contacts_pk_immutable sorts first and still answers a re-key with its
-- own sentence).
--
-- NOT DONE HERE (BACKLOG — each its own decision): the erasure, the purge,
-- deleteContactDocument, deletePropertyDocument and deleteMediaBulk pass a
-- session-written path to the service-role removal as stored (a session can
-- insert a row naming another object — a retained KYC file included; merges
-- re-point a document without moving its object, so a per-contact path
-- bound needs its own design); two concurrent re-runs of a half-finished
-- erasure can each write an `erased` event (pre-existing); sessions can
-- still link new records to an erased contact (documents, saved searches,
-- notes through log_conversation, deals, viewings, tasks …) and change the
-- links the AML basis is read from before an erasure runs; look-alike event
-- types (`Erased`, `retention purged`); the page offers no "finish erasure"
-- control for a run whose record failed to write.
--
-- ROLLBACK, a forward migration, ALL IN ONE TRANSACTION: restore
-- events_insert's 0131 check (the preflight quotes it), then drop the
-- triggers `contacts_retain_erasure` and `documents_kept_for_retention` and
-- their functions (supabase/tests/revert-0134.ts builds exactly that text —
-- every lock at once, NOWAIT, retried — and the test file replays it). The
-- application keeps working (the service role is bound by neither state).
-- First record the boundary comment. In the same change: delete
-- supabase/tests/erasure-lifecycle.test.ts and revert-0134.ts; remove
-- verify-restore.sql's 0134 SECURITY row and its two grants rows and move its
-- migrations pin FORWARD; restore BACKLOG's entry and docs/04's contacts /
-- documents / events notes. No data moves.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count, two grants rows, the 0134 SECURITY row); docs/04's
-- contacts, events and grant-model notes.
-- =============================================================================

set local lock_timeout = '5s';
-- pg_get_expr's output depends on the session's search_path (it qualifies
-- what is not on the path), so the policy text below is read under a FIXED
-- path — the one local and hosted both use (0127's idiom)
set local search_path = "$user", public, extensions;

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0134 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: what this file changes must be what it was written against
-- ---------------------------------------------------------------------------
do $$
declare
  v_check text;
  v_trg   text;
  v_doc   text;
  v_gen   text;
  v_diag  text;
begin
  -- contacts' and documents' locks first, in one statement, parent before
  -- child (header, LOCKS); events' is taken by ALTER POLICY, last
  lock table public.contacts, public.documents in share row exclusive mode;

  -- 1. events_insert is 0131's
  select pg_get_expr(p.polwithcheck, p.polrelid) into v_check
    from pg_policy p
   where p.polrelid = 'public.events'::regclass and p.polname = 'events_insert' and p.polcmd = 'a';
  if v_check is distinct from
     '((org_id = ( SELECT current_org_id() AS current_org_id)) AND (actor_id = ( SELECT auth.uid() AS uid)) AND (NOT ((entity_type = ''deal''::text) AND (event_type = ANY (ARRAY[''won''::text, ''lost''::text, ''won_override''::text])))) AND (event_type <> ''stage_changed''::text) AND (occurred_at = now()))' then
    raise exception '0134 aborted: events_insert''s check is not 0131''s (%) — nothing was changed', coalesce(v_check, 'missing');
  end if;

  -- 2. the triggers on contacts are 0132's two, with or without 0133's; on
  --    documents 0132's two
  select string_agg(t.tgname, ', ' order by t.tgname) into v_trg
    from pg_trigger t where t.tgrelid = 'public.contacts'::regclass and not t.tgisinternal;
  if v_trg is distinct from 'contacts_pk_immutable, contacts_updated'
     and v_trg is distinct from 'contacts_id_without_history, contacts_pk_immutable, contacts_updated' then
    raise exception '0134 aborted: the triggers on contacts are not the expected set (%) — nothing was changed', coalesce(v_trg, 'none');
  end if;
  select string_agg(t.tgname, ', ' order by t.tgname) into v_doc
    from pg_trigger t where t.tgrelid = 'public.documents'::regclass and not t.tgisinternal;
  if v_doc is distinct from 'documents_pk_immutable, documents_protect' then
    raise exception '0134 aborted: the triggers on documents are not the expected set (%) — nothing was changed', coalesce(v_doc, 'none');
  end if;

  -- 3. display_name is the only generated column (the guard compares the
  --    rest of the row; a BEFORE trigger cannot read a generated value)
  select string_agg(a.attname, ', ' order by a.attname) into v_gen
    from pg_attribute a
   where a.attrelid = 'public.contacts'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated <> '';
  if v_gen is distinct from 'display_name' then
    raise exception '0134 aborted: contacts'' generated columns are not exactly display_name (%) — nothing was changed', coalesce(v_gen, 'none');
  end if;

  -- 4. the names this file creates are free
  if to_regprocedure('public.trg_contacts_erasure_lifecycle()') is not null
     or to_regprocedure('public.trg_documents_kept_for_retention()') is not null then
    raise exception '0134 aborted: a function this file creates already exists — nothing was changed';
  end if;

  -- 5. the guards exempt every role but authenticated / anon, so a SECURITY
  --    DEFINER body that writes contacts or deletes documents would be a
  --    second door: there is none (0118's tripwire; extension-owned
  --    functions are out of scope)
  select string_agg(ns.nspname || '.' || p.proname, ', ' order by ns.nspname, p.proname) into v_diag
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where p.prosecdef
     and ns.nspname not in ('pg_catalog', 'information_schema')
     and regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
         ~* '(update\s+(only\s+)?(public\.)?contacts\y|insert\s+into\s+(public\.)?contacts\y|delete\s+from\s+(only\s+)?(public\.)?documents\y)'
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                        and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e');
  if v_diag is not null then
    raise exception '0134 aborted: a SECURITY DEFINER function writes contacts or deletes documents (%) — nothing was changed', v_diag;
  end if;

  -- the hoisted-policy count the postflight must find unchanged (0030)
  perform set_config('gnk.m0134_hoisted', public.rls_hoisted_policy_count()::text, true);

  -- EXISTING ROWS (header), the contacts half — under contacts' lock, never
  -- repaired. The event-based half is read in the postflight, under events'.
  -- erased_unredacted mirrors the erasure re-run's check (unredactedColumns
  -- in lib/services/erasure-run.ts): every column the patch writes but the
  -- record's own and gdpr_notes; kyc only where nothing was retained.
  select format('erased_but_active=%s erased_unredacted=%s erased_without_eraser=%s retained_not_erased=%s erased_documents_unretained=%s',
           count(*) filter (where c.erased_at is not null and not c.is_archived),
           count(*) filter (where c.erased_at is not null
                              and (c.consent_marketing or c.consent_at is not null or c.temperature <> 'inactive'
                                   or c.has_whatsapp or c.notes is not null or c.psychology is not null
                                   or c.source_detail is not null or c.telegram_username is not null
                                   or c.nationality is not null or coalesce(cardinality(c.additional_phones), 0) > 0
                                   or c.languages is distinct from array['en']::text[]
                                   or coalesce(c.banking_readiness, '{}'::jsonb) <> '{}'::jsonb
                                   or (c.retention_until is null and coalesce(c.kyc, '{}'::jsonb) <> '{}'::jsonb))),
           count(*) filter (where c.erased_at is not null and c.erased_by is null),
           count(*) filter (where c.retention_until is not null and c.erased_at is null),
           (select count(*) from public.documents d
              join public.contacts x on x.org_id = d.org_id and x.id = d.entity_id
             where d.entity_type = 'contact' and x.erased_at is not null and x.retention_until is null))
    into v_diag
    from public.contacts c;
  perform set_config('gnk.m0134_existing', v_diag, true);

  raise notice '0134: preflight passed — events_insert is 0131''s, the triggers on contacts (%) and documents the expected sets, display_name the only generated column, the names free', v_trg;
end $$;

-- ---------------------------------------------------------------------------
-- A. the contacts guard
-- ---------------------------------------------------------------------------
create function public.trg_contacts_erasure_lifecycle()
returns trigger
language plpgsql
security invoker
-- pg_temp LAST: unlisted, it is searched FIRST for relations and types
set search_path = public, pg_temp
as $$
declare
  v_cols text;
begin
  -- only as the BEFORE INSERT OR UPDATE row trigger on public.contacts: any
  -- other attachment is a mistake, and a mistake must refuse, not pass
  if tg_when <> 'BEFORE' or tg_level <> 'ROW' or tg_op not in ('INSERT', 'UPDATE')
     or tg_table_schema <> 'public' or tg_table_name <> 'contacts' then
    raise exception 'trg_contacts_erasure_lifecycle runs only as a BEFORE INSERT OR UPDATE row trigger on public.contacts (% on %.%)',
      tg_name, tg_table_schema, tg_table_name;
  end if;

  -- user sessions only: current_user is the statement's role — authenticated
  -- for a PostgREST request, the owner inside a SECURITY DEFINER body,
  -- service_role / postgres for the erasure, the purge, the merge, imports,
  -- maintenance and restores (header, TRUSTED PATHS)
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- a session's new contact carries no erasure record
  if tg_op = 'INSERT' then
    select string_agg(x.col, ', ' order by x.col) into v_cols
      from (values ('erased_at', new.erased_at is not null),
                   ('erased_by', new.erased_by is not null),
                   ('retention_until', new.retention_until is not null)) x(col, present)
     where x.present;
    if v_cols is not null then
      raise exception 'A contact''s erasure record is written only by its erasure (contacts.%)', v_cols
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- …and never changes it: a VALUE comparison, so a restating write passes
  select string_agg(x.col, ', ' order by x.col) into v_cols
    from (values ('erased_at', new.erased_at is distinct from old.erased_at),
                 ('erased_by', new.erased_by is distinct from old.erased_by),
                 ('retention_until', new.retention_until is distinct from old.retention_until)) x(col, changed)
   where x.changed;
  if v_cols is not null then
    raise exception 'A contact''s erasure record is written only by its erasure and the retention purge (contacts.%)', v_cols
      using errcode = '42501';
  end if;

  -- an erased contact stays as its erasure left it; archiving it (an erased
  -- contact left active before T-refuse-unarchive-erased) is the one change.
  -- The whole row, so a column added later is covered too; updated_at is
  -- contacts_updated's, display_name is generated (not readable here)
  if old.erased_at is not null then
    select string_agg(n.key, ', ' order by n.key) into v_cols
      from jsonb_each(to_jsonb(new) - 'updated_at' - 'display_name') n
     where n.value is distinct from (to_jsonb(old) -> n.key)
       and not (n.key = 'is_archived' and n.value = 'true'::jsonb);
    if v_cols is not null then
      raise exception 'An erased contact stays as its erasure left it — archiving it is the one change allowed (contacts.%)', v_cols
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- a trigger body is called by the trigger, never by a role (hosted's default
-- privileges grant service_role EXECUTE on every new function: revoke all
-- four explicitly, as 0127 / 0131 / 0132 do)
revoke execute on function public.trg_contacts_erasure_lifecycle() from public, anon, authenticated, service_role;

comment on function public.trg_contacts_erasure_lifecycle() is
  'Contacts'' erasure lifecycle, for user sessions (authenticated / anon) only, with 42501 (0134): an INSERT carries no erased_at / erased_by / retention_until; an UPDATE changes none of them; an erased contact admits no change but archiving. The erasure and the retention purge write them as the service role; postgres and definer bodies are not bound. Attached BEFORE INSERT OR UPDATE FOR EACH ROW as contacts_retain_erasure.';

create trigger contacts_retain_erasure
  before insert or update on public.contacts
  for each row execute function public.trg_contacts_erasure_lifecycle();

-- ---------------------------------------------------------------------------
-- B. the documents an erased contact's retention keeps
-- ---------------------------------------------------------------------------
create function public.trg_documents_kept_for_retention()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_when <> 'BEFORE' or tg_level <> 'ROW' or tg_op <> 'DELETE'
     or tg_table_schema <> 'public' or tg_table_name <> 'documents' then
    raise exception 'trg_documents_kept_for_retention runs only as a BEFORE DELETE row trigger on public.documents (% on %.%)',
      tg_name, tg_table_schema, tg_table_name;
  end if;

  -- user sessions only (header, TRUSTED PATHS): the erasure deletes a
  -- contact's documents before its marker is set, the purge after its
  -- date, both as the system
  if current_user not in ('authenticated', 'anon') then
    return old;
  end if;

  -- documents_delete admits the document's own organisation only, whose
  -- contacts the session reads (contacts_select). Only what the retention
  -- keeps: an erased contact's documents while its retention date is set
  if old.entity_type = 'contact'
     and exists (select 1 from public.contacts c
                  where c.id = old.entity_id and c.erased_at is not null and c.retention_until is not null) then
    raise exception 'An erased contact''s retained documents are kept until the retention purge destroys them (documents.%)', old.id
      using errcode = '42501';
  end if;
  return old;
end $$;

revoke execute on function public.trg_documents_kept_for_retention() from public, anon, authenticated, service_role;

comment on function public.trg_documents_kept_for_retention() is
  'An erased contact''s retained documents (its retention date set) are destroyed only by the retention purge, as the service role: refuses a user session''s (authenticated / anon) DELETE of one with 42501 (0134). Attached BEFORE DELETE FOR EACH ROW as documents_kept_for_retention.';

create trigger documents_kept_for_retention
  before delete on public.documents
  for each row execute function public.trg_documents_kept_for_retention();

-- ---------------------------------------------------------------------------
-- C. a session may not write the erasure's or the purge's record — LAST, so
--    this file takes contacts' and documents' locks (above) before events'
--    (here), the order the writers take them
-- ---------------------------------------------------------------------------
alter policy events_insert on public.events
  with check (
    -- 0071's two clauses, written as 0071 wrote them so the hoisted form
    -- renders identically (rls_hoisted_policy_count)
    org_id = (select current_org_id())
    and actor_id = (select auth.uid())
    -- 0128: won / lost / won_override are close_deal's, a definer; a session
    -- may not write them for any deal
    and not (entity_type = 'deal' and event_type in ('won', 'lost', 'won_override'))
    -- 0131: stage_changed is the deals_stage_changed_event trigger's, a
    -- definer; a session may not write it at all (its own clause: 0131's
    -- restore-pack row reads it)
    and event_type <> 'stage_changed'
    -- 0134: erased / retention_purged are the erasure's and the purge's,
    -- written as the system; a session may not write them under any
    -- entity_type — the erasure reads its own as "already complete"
    and event_type not in ('erased', 'retention_purged')
    -- 0128: a session's event occurs at its own insert (the column's default)
    and occurred_at = now()
  );

-- ---------------------------------------------------------------------------
-- Postflight. The behaviour needs sessions and is proven by
-- supabase/tests/erasure-lifecycle.test.ts; here the shape.
-- ---------------------------------------------------------------------------
do $$
declare
  sig_c   constant text := 'public.trg_contacts_erasure_lifecycle()';
  sig_d   constant text := 'public.trg_documents_kept_for_retention()';
  v_sig   text;
  v_check text;
  v_max   bigint;
  v_diag  text;
begin
  -- A / B: invokers, owned by postgres, pg_temp last, callable by nobody
  foreach v_sig in array array[sig_c, sig_d] loop
    if not exists (select 1 from pg_proc p
                    where p.oid = v_sig::regprocedure and not p.prosecdef
                      and pg_get_userbyid(p.proowner) = 'postgres'
                      and p.proconfig = array['search_path=public, pg_temp']
                      and p.prorettype = 'trigger'::regtype) then
      raise exception '0134 postflight: % is not an invoker trigger function owned by postgres with search_path public, pg_temp', v_sig;
    end if;
    if has_function_privilege('public', v_sig, 'execute') or has_function_privilege('anon', v_sig, 'execute')
       or has_function_privilege('authenticated', v_sig, 'execute') or has_function_privilege('service_role', v_sig, 'execute') then
      raise exception '0134 postflight: % is executable by an API role', v_sig;
    end if;
  end loop;

  -- …each attached exactly once, enabled, no WHEN, no column list, no
  --    arguments, FOR EACH ROW BEFORE: the contacts guard on INSERT OR
  --    UPDATE, the documents guard on DELETE (coalesce: a NULL anywhere in
  --    the shape test is a failure, never a pass)
  if (select count(*) from pg_trigger t where t.tgfoid = sig_c::regprocedure and not t.tgisinternal) <> 1
     or not coalesce((select t.tgrelid = 'public.contacts'::regclass and t.tgname = 'contacts_retain_erasure'
                             and t.tgenabled = 'O' and t.tgqual is null
                             and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1          -- BEFORE, ROW
                             and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 16        -- INSERT, UPDATE
                             and (t.tgtype & (8 | 32)) = 0                          -- not DELETE / TRUNCATE
                             and cardinality(t.tgattr::int2[]) = 0 and t.tgnargs = 0
                        from pg_trigger t where t.tgfoid = sig_c::regprocedure and not t.tgisinternal), false) then
    raise exception '0134 postflight: contacts_retain_erasure is not the one enabled BEFORE INSERT OR UPDATE row trigger on contacts calling the guard';
  end if;
  if (select count(*) from pg_trigger t where t.tgfoid = sig_d::regprocedure and not t.tgisinternal) <> 1
     or not coalesce((select t.tgrelid = 'public.documents'::regclass and t.tgname = 'documents_kept_for_retention'
                             and t.tgenabled = 'O' and t.tgqual is null
                             and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1          -- BEFORE, ROW
                             and (t.tgtype & 8) = 8                                 -- DELETE
                             and (t.tgtype & (4 | 16 | 32)) = 0                     -- not INSERT / UPDATE / TRUNCATE
                             and cardinality(t.tgattr::int2[]) = 0 and t.tgnargs = 0
                        from pg_trigger t where t.tgfoid = sig_d::regprocedure and not t.tgisinternal), false) then
    raise exception '0134 postflight: documents_kept_for_retention is not the one enabled BEFORE DELETE row trigger on documents calling the guard';
  end if;

  -- C: events_insert is 0131's check and this file's clause
  select pg_get_expr(p.polwithcheck, p.polrelid) into v_check
    from pg_policy p where p.polrelid = 'public.events'::regclass and p.polname = 'events_insert';
  if v_check is distinct from
     '((org_id = ( SELECT current_org_id() AS current_org_id)) AND (actor_id = ( SELECT auth.uid() AS uid)) AND (NOT ((entity_type = ''deal''::text) AND (event_type = ANY (ARRAY[''won''::text, ''lost''::text, ''won_override''::text])))) AND (event_type <> ''stage_changed''::text) AND (event_type <> ALL (ARRAY[''erased''::text, ''retention_purged''::text])) AND (occurred_at = now()))' then
    raise exception '0134 postflight: events_insert is not the 0134 check: %', v_check;
  end if;
  -- …still in its hoisted form: the count unchanged, no bare helper call
  if public.rls_hoisted_policy_count()::text is distinct from current_setting('gnk.m0134_hoisted', true) then
    raise exception '0134 postflight: rls_hoisted_policy_count moved (% → %)',
      current_setting('gnk.m0134_hoisted', true), public.rls_hoisted_policy_count();
  end if;
  if exists (select 1 from public.rls_bare_helper_calls() where policyname = 'events_insert')
     or exists (select 1 from public.rls_bare_auth_calls() where policyname = 'events_insert') then
    raise exception '0134 postflight: events_insert calls a helper or auth function bare';
  end if;

  -- EXISTING ROWS, the events half, and the boundary — read while ALTER
  -- POLICY holds events' lock, so no event can be inserted until this
  -- transaction ends and max(id) is exact. Organisation-scoped: an event of
  -- one organisation says nothing about another's contact (and it uses the
  -- index that leads with org_id).
  select coalesce(max(e.id), 0) into v_max from public.events e;
  select format('erased_without_record=%s record_without_erasure=%s boundary=%s',
           (select count(*) from public.contacts c
             where c.erased_at is not null
               and not exists (select 1 from public.events e
                                where e.org_id = c.org_id and e.entity_type = 'contact'
                                  and e.entity_id = c.id and e.event_type = 'erased')),
           (select count(distinct (e.org_id, e.entity_id)) from public.events e
             where e.entity_type = 'contact' and e.event_type = 'erased'
               and not exists (select 1 from public.contacts c
                                where c.org_id = e.org_id and c.id = e.entity_id and c.erased_at is not null)),
           v_max)
    into v_diag;
  perform set_config('gnk.m0134_existing', current_setting('gnk.m0134_existing', true) || ' ' || v_diag, true);
  execute format('comment on trigger contacts_retain_erasure on public.contacts is %L',
    format('0134 enforcement boundary: from event id > %s no session may write an erased / retention_purged event; the %s such events at or below it are not proven system-written.',
           v_max, (select count(*) from public.events e where e.event_type in ('erased', 'retention_purged') and e.id <= v_max)));

  raise notice '0134: postflight passed — the two guards are the invoker triggers they should be, events_insert refuses a session''s erased / retention_purged';
  raise notice '0134: existing rows (read-only, nothing repaired) — %', current_setting('gnk.m0134_existing', true);
end $$;

-- the apply tool may drop NOTICEs: the last row carries the diagnostic and
-- the boundary as the catalogue holds it
select '0134 applied — existing rows (read-only, nothing repaired): ' || current_setting('gnk.m0134_existing', true) as existing_rows,
       (select obj_description(t.oid, 'pg_trigger') from pg_trigger t
         where t.tgrelid = 'public.contacts'::regclass and t.tgname = 'contacts_retain_erasure') as enforcement_boundary;
