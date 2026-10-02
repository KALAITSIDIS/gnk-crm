-- =============================================================================
-- 0132 — a session cannot change a record's primary key: a contact, a lead
--        or any other record keeps the identity its history is keyed by
--
-- THE GAP (external audit brief, 2026-10-02, re-verified independently the
-- same day against 58fb84d on the local stack at 0131 through PostgREST with
-- real aal2 sessions of throwaway organisations, then for every table in
-- rolled-back transactions; pinned RED first by
-- supabase/tests/primary-key-immutable.test.ts — see DECISIONS
-- T-primary-key-immutable for the count):
--
--   * contacts_update / leads_update (0100) restrict ROWS, not columns, and
--     `authenticated` holds UPDATE on every column, `id` included. An aal2
--     admin, the contact's assigned agent, the agent who CREATED it, and ANY
--     agent of the organisation on an UNASSIGNED lead (leads_update admits
--     assigned_agent_id is null) PATCHed `{id: <new uuid>}`: HTTP 200, the row
--     now lives at the new id (measured; return=minimal answered 204 the same
--     way). Refused already: a peer agent on another's contact, a listing
--     manager, another organisation's admin, aal1, anon (row filtered or
--     no privilege).
--   * What a re-key does (measured): the record's events, interaction notes
--     and documents are keyed by (entity_type, entity_id) with no foreign key,
--     so they STAY on the old id — the contact page's timeline and documents
--     read empty, and erasure's / redactLead's note scopes (org, entity,
--     entity_id = the new id) find nothing, so personal data survives a
--     redaction. And the mirror image: an agent re-keyed contact X away and
--     contact Y ONTO X's former id — Y's page then showed X's events
--     (hash-chained, written by a colleague), X's note and X's document, and
--     erasing Y would redact another person's note. The chain itself stays
--     valid (verify_events_chain true): nothing is rewritten, history is
--     simply re-attached by id.
--   * Only a foreign-key CHILD refuses (every foreign key onto these tables
--     is ON UPDATE NO ACTION, measured: 117 of 117 declared — 132
--     pg_constraint rows, counting events_org_id_fkey's 15 partition copies —
--     answering 23503, which names a table the caller may not be able to
--     read). A record whose only "children" are its history is never
--     protected.
--   * Not only contacts and leads: of the 26 public tables where an API role
--     holds UPDATE on a primary-key column, 24 accepted an admin's re-key of
--     a childless row (measured in rolled-back transactions) — deals refuse
--     (0131's guard) and organizations refuse (organizations_update's WITH
--     CHECK id = current_org_id(), then the caller's own profile FK).
--     Agents re-keyed buyer_requirements, contacts, leads, offers, properties,
--     reservation_installments, reservations, share_links, tasks, viewings;
--     listing managers buyer_requirements, payment_plans, price_list_items,
--     price_lists, properties, property_keys, property_media,
--     reservation_installments, reservations, unit_types — and, as a task's
--     assignee or a link's creator, tasks and share_links. An admin moved a
--     profile onto an auth user with no profile; renamed a GLOBAL
--     cyprus_config key (readers then fall back to defaults); moved a price
--     list line to another unit (price_list_items' key is (price_list_id,
--     unit_id)).
--   * Not only PATCH: a PostgREST UPSERT whose on_conflict names a non-key
--     unique key and whose payload carries a different id re-keys the
--     conflicting row (ON CONFLICT … DO UPDATE SET id = EXCLUDED.id) —
--     measured on districts (org_id, code) and property_keys (org_id,
--     key_code); properties (org_id, reference) and seven more have such a
--     key.
--   * Production (read-only, 2026-10-02): every live contact, lead, property
--     and deal still carries its own `created` event — no sign a re-key ever
--     happened. It DOES hold orphaned histories (events whose entity_id has
--     no row: 2 contacts, 25 leads, 22 properties, 1 deal, each beginning
--     with `created` — the deleted operator test data), which is exactly
--     what a re-key onto a former id would adopt. (They stay adoptable by an
--     INSERT that chooses that id — NOT DONE below.)
--
-- THE FIX — the key is the record's identity, and a session may not change
-- it:
--
--   A. public.trg_primary_key_immutable(): a SECURITY INVOKER trigger
--      function (owner postgres, search_path public, pg_temp, EXECUTE revoked
--      from every role). Its arguments name the table's primary-key columns;
--      for a session (current_user authenticated or anon — the statement's
--      role, as in 0118 / 0127 / 0131) it compares each OLD and NEW value and
--      raises 42501 "A record's primary key cannot be changed (<table>.<col>)"
--      when one differs. It refuses to run attached any other way (not
--      BEFORE / ROW / UPDATE, or no argument), and an argument that is not a
--      column of the row fails the statement (42703) — misconfiguration
--      fails closed, never open.
--   B. One trigger per table, `<table>_pk_immutable`, BEFORE UPDATE OF <its
--      primary-key columns> FOR EACH ROW, on the 25 tables of the gap other
--      than deals: areas, buyer_requirements, contacts, cyprus_config (key),
--      deal_stages, districts, documents, leads, mandates, offers,
--      organizations (refused already by its policy; guarded so the rule is
--      the table's, not the policy's), payment_plans, portal_connections,
--      price_list_items (price_list_id, unit_id), price_lists, profiles,
--      properties, property_keys, property_media, reservation_installments,
--      reservations, share_links, tasks, unit_types, viewings. UPDATE OF
--      fires exactly when a key column is a SET target — a PATCH naming it,
--      and every upsert, whose DO UPDATE SET lists every payload column — and
--      the VALUE comparison lets a restating write through: an upsert on the
--      key itself can only restate it (EXCLUDED.id is the conflicting row's
--      id by construction), so the tests' and fixtures' upserts that carry a
--      row's own id keep working.
--   C. deals keep 0131's refusal inside trg_deals_closed_guard ("A deal's id
--      cannot be changed", P0001); the preflight requires it, and 0131's own
--      preflight requires deals to carry exactly the triggers it was written
--      against, so 0132 adds none there.
--
-- Afterwards: every public table (not extension-owned) where an API role
-- holds UPDATE on a primary-key column carries the guard on exactly its key
-- — or is deals. The postflight asserts it (one shape predicate: enabled, no
-- WHEN, BEFORE / ROW / UPDATE OF exactly the key, exactly the key as its
-- arguments), the test file's catalogue test holds every FUTURE table to it
-- with the same predicate, and the restore pack's 0132 row re-checks it —
-- with the function's session binding — wherever the pack runs. Default
-- privileges differ by environment, which is why the pack matters: hosted
-- gives anon and authenticated arwdDxtm on every table postgres creates in
-- public (read 2026-10-02 — hence 0040's REVOKE-before-GRANT rule), while the
-- pinned CLI (2.115.0) revokes those defaults at `supabase start`, so CI and
-- the shared local stack give a new table Dxtm. CI's catalogue test catches
-- a new table whose migration GRANTs UPDATE on its key; one that skips 0040's
-- REVOKE is session-updatable on HOSTED only, and only the pack's row, run
-- against hosted, reads it (`1 25 true`).
--
-- WHY NOT COLUMN PRIVILEGES (revoke the table-level UPDATE, grant every
-- column but the key): a column privilege refuses any statement that merely
-- NAMES the column — every upsert carrying a row's own id would answer 42501
-- (the tenant tests UPSERT with the existing id and assert a 23503 by
-- constraint name), every column added later would be silently read-only
-- until someone granted it, and the rule would live in ACLs that a restore or
-- a `grant all` re-opens without a trace. A trigger compares values, stays
-- correct for new columns, and is visible to the restore pack.
--
-- TRUSTED PATHS, deliberately (parity with 0118 / 0127 / 0131): the service
-- role and postgres are not bound, nor is a SECURITY DEFINER body owned by
-- postgres (current_user is its owner inside). Measured: no writer in app/,
-- lib/, components/, scripts/ or any function body changes a primary-key
-- value — the app makes no `.upsert()` call on a table at all, and no
-- statement anywhere sets a key column — so binding the service role would
-- break nothing found; it is left out as a parity choice, not a need.
--
-- CONTRACT. No function the application calls changes, so no
-- release-compat entry; lib/supabase/database.types.ts lists no trigger
-- functions and regenerates identically. The deployed application never
-- sends a primary-key change (grep above), so this is NOT deploy-coupled.
--
-- VISIBLE CHANGES FOR A DIRECT POSTGREST CALLER (the application makes none
-- of these requests): a PATCH (or an upsert on a non-key unique key) that
-- changes a guarded table's primary key answers 403 / 42501 "A record's
-- primary key cannot be changed (<table>.<column>)" — including on a row a
-- foreign-key child pins, which used to answer 409 / 23503 naming the child
-- table; a non-admin's PATCH of their own profile id now gets this message
-- instead of protect_profile_columns' P0001 (profiles_pk_immutable sorts
-- before profiles_protect); an admin re-keying their organisation gets it
-- instead of the policy's 42501. A PATCH or upsert that restates the key
-- unchanged is accepted as before.
--
-- LOCKS. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on each of the 25 tables:
-- every INSERT / UPDATE / DELETE on them waits until this commits; plain
-- reads (ACCESS SHARE) and the row locks foreign-key checks take do not. All
-- 25 are taken FIRST, in ONE statement inside the preflight, parents before
-- children — organizations, profiles, cyprus_config, districts, areas,
-- deal_stages, contacts, buyer_requirements, properties, unit_types,
-- property_media, property_keys, price_lists, price_list_items,
-- payment_plans, documents, mandates, leads, viewings, offers, reservations,
-- reservation_installments, share_links, portal_connections, tasks LAST —
-- the order the multi-table writers take them (viewings / reservations /
-- mandates / leads before the tasks and jobs their triggers and sweeps
-- write; price_lists before their items), so a writer already running makes
-- the file wait rather than deadlock. No order avoids every cycle (a
-- transaction writing a later table and then an earlier one); such a
-- collision ends in a clean 40P01, as does a wait beyond lock_timeout
-- (55P03, 5 s PER TABLE — up to ~2 minutes of blocked writes in the worst
-- case): nothing is kept, apply again, and do NOT write the ledger row.
-- ONE transaction (checked below). The guard itself writes nothing and
-- takes no lock at run time. Apply as 0129 / 0131 did: outside 02:55–04:05
-- UTC, away from 06:00, at the middle of an odd minute that is not a
-- multiple of five (the desk-alert sweep runs every 2 minutes and the lead
-- escalation every 5, and both write leads-side rows).
--
-- DEPLOY ORDER. Not coupled (CONTRACT); the working agreement's order
-- stands: branch CI green → hosted 0132 → merge. Hosted was read READ-ONLY
-- on 2026-10-02: the same 26 tables with the same keys and triggers as the
-- local stack. The preflight refuses, changing nothing, unless (1) the
-- tables where an API role may update a primary-key column are exactly the
-- 26 below with exactly these keys, (2) deals' guard still refuses a
-- session's re-key, and (3) none of the names this file creates exists. It
-- ends with one SELECT naming the guarded tables, so the apply tool's output
-- carries them.
--
-- NOT CHANGED: who may update which rows (RLS); every other column; INSERT
-- and DELETE; deals (0131); the service role, postgres and definer bodies;
-- every foreign key; events, notes and documents (no row is written,
-- modified or moved — history already detached stays where it is; the
-- production read above found none).
--
-- NOT DONE HERE (BACKLOG — each its own decision):
--   * INSERT with a chosen id. `authenticated` holds INSERT on the key, under
--     a permissive insert policy, of every guarded table but organizations
--     (and of deals). So a session can still INSERT a NEW row at an id whose
--     history outlived its row — production's 50 orphaned histories above,
--     freed by trusted-path deletions — and adopt it (measured by the review
--     on contacts and properties: an admin reads every orphaned event, an
--     agent can adopt only an id it already knows); and on the 13 tables a
--     session may DELETE from (areas, buyer_requirements, deal_stages,
--     districts, documents, payment_plans, price_list_items, price_lists,
--     property_media, reservation_installments, reservations, tasks,
--     unit_types) it can delete a row and insert a new one at its id
--     (measured on tasks). What this file DOES end: freeing an id by
--     re-keying its holder away — on the other guarded tables, which have no
--     session DELETE, a session can no longer free an id at all. A blanket
--     column grant that omits the key is not available: two session writers
--     choose one — the lead convert's deal (lib/actions/leads.ts; deals is
--     not a 0132 table) and the user invite's profile (lib/actions/settings.ts,
--     the auth user's id); price_list_items and cyprus_config have natural
--     keys that must be sent, and organizations has no session INSERT — so
--     such a grant remains available per table for the other 21. An
--     overwrite trigger would break the two writers; refusing an id that
--     already has history in the organisation fits all of them. BACKLOG: the
--     existence-oracle entry ("A client-chosen primary key…"), which this
--     file closes on UPDATE only, now records the adoption harm with its own
--     VERIFY.
--   * The service role is not bound (TRUSTED PATHS).
--   * cyprus_config has no org_id and its UPDATE policy admits the admin of
--     ANY organisation (values, not just keys); price_list_items' unit_id
--     may name another organisation's property on INSERT (its policies check
--     only the list's organisation; this file refuses a session's UPDATE of
--     unit_id — the single-column-links entry); an erased contact's erased_at /
--     is_archived are refused by the app only; createShareLink's cleanup of
--     a link left with no properties is a session DELETE that no grant
--     admits. Found by this review; recorded in BACKLOG, not fixed.
--
-- ROLLBACK, a forward migration, ALL IN ONE TRANSACTION: drop the 25
-- `<table>_pk_immutable` triggers, then the function
-- (supabase/tests/revert-0132.ts builds exactly that text, and the test file
-- replays it). DROP TRIGGER takes ACCESS EXCLUSIVE — reads wait too — and no
-- drop order avoids every cycle with a session (the review measured both
-- orders deadlock, and the USER'S request was the one aborted), so the text
-- first takes all 25 locks at once, NOWAIT, retrying for ~5 s: it never waits
-- while holding a lock, sessions wait only for the milliseconds the drops
-- take, and when the tables are never free at once it refuses, nothing kept
-- — apply it again. In the same change: delete
-- supabase/tests/primary-key-immutable.test.ts and revert-0132.ts; remove
-- the restore pack's 0132 row and grants row and move its migrations pin
-- FORWARD; restore BACKLOG's entry and remove docs/04's Grant model
-- paragraph (0132). No data moves.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (132
-- migrations, a grants row, the 0132 SECURITY row); docs/04's Grant model
-- paragraph.
-- =============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0132 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the catalogue this file was written against, under its locks
-- ---------------------------------------------------------------------------
do $$
declare
  v_tables text;
  v_src    text;
  v_names  text;
begin
  -- every lock the DDL below needs, at its strongest, in one statement,
  -- parents before children (header, LOCKS)
  lock table public.organizations, public.profiles, public.cyprus_config, public.districts,
             public.areas, public.deal_stages, public.contacts, public.buyer_requirements,
             public.properties, public.unit_types, public.property_media, public.property_keys,
             public.price_lists, public.price_list_items, public.payment_plans, public.documents,
             public.mandates, public.leads, public.viewings, public.offers, public.reservations,
             public.reservation_installments, public.share_links, public.portal_connections,
             public.tasks
    in share row exclusive mode;

  -- 1. the tables where an API role may update a primary-key column, and
  --    their keys, are exactly the 26 this file was written against
  select string_agg(x.relname || ':' || x.pk, '; ' order by x.relname) into v_tables
    from (select c.relname,
                 (select string_agg(a.attname, ',' order by k.ord)
                    from unnest(con.conkey) with ordinality k(attnum, ord)
                    join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum) as pk
            from pg_class c
            join pg_constraint con on con.conrelid = c.oid and con.contype = 'p'
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition
             and not exists (select 1 from pg_depend d
                              where d.classid = 'pg_class'::regclass and d.objid = c.oid
                                and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e')
             and exists (select 1 from unnest(con.conkey) k(attnum)
                          where has_column_privilege('authenticated', c.oid, k.attnum, 'UPDATE')
                             or has_column_privilege('anon', c.oid, k.attnum, 'UPDATE'))) x;
  if v_tables is distinct from
     'areas:id; buyer_requirements:id; contacts:id; cyprus_config:key; deal_stages:id; deals:id; districts:id; '
     'documents:id; leads:id; mandates:id; offers:id; organizations:id; payment_plans:id; portal_connections:id; '
     'price_list_items:price_list_id,unit_id; price_lists:id; profiles:id; properties:id; property_keys:id; '
     'property_media:id; reservation_installments:id; reservations:id; share_links:id; tasks:id; unit_types:id; viewings:id' then
    raise exception '0132 aborted: the tables whose primary key an API role may update are not the 26 this file was written against (%) — nothing was changed',
      coalesce(v_tables, 'none');
  end if;

  -- 2. deals — the one table this file leaves to its own guard — still
  --    refuses a session's re-key (0131)
  select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_src
    from pg_proc p
    join pg_trigger t on t.tgfoid = p.oid
   where t.tgrelid = 'public.deals'::regclass and t.tgname = 'deals_closed_guard' and t.tgenabled = 'O'
     and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1 and (t.tgtype & 16) = 16
     and p.oid = to_regprocedure('public.trg_deals_closed_guard()') and not p.prosecdef;
  if v_src is null or v_src !~ 'new\.id is distinct from old\.id'
     or v_src !~ 'current_user not in \(''authenticated'', ''anon''\)' then
    raise exception '0132 aborted: deals_closed_guard does not refuse a session''s change of a deal''s id (0131) — nothing was changed';
  end if;

  -- 3. the names this file creates are free
  if to_regprocedure('public.trg_primary_key_immutable()') is not null then
    raise exception '0132 aborted: public.trg_primary_key_immutable() already exists — nothing was changed';
  end if;
  select string_agg(t.tgrelid::regclass::text || '.' || t.tgname, ', ' order by t.tgname) into v_names
    from pg_trigger t
   where not t.tgisinternal and t.tgname like '%\_pk\_immutable';
  if v_names is not null then
    raise exception '0132 aborted: a trigger named *_pk_immutable already exists (%) — nothing was changed', v_names;
  end if;

  raise notice '0132: preflight passed — 26 tables with a session-updatable primary key, deals'' own guard in place, the names free';
end $$;

-- ---------------------------------------------------------------------------
-- A. the guard
-- ---------------------------------------------------------------------------
create function public.trg_primary_key_immutable()
returns trigger
language plpgsql
security invoker
-- pg_temp LAST: unlisted, it is searched FIRST for relations and types
set search_path = public, pg_temp
as $$
declare
  v_col     text;
  v_changed boolean;
begin
  -- only as a BEFORE UPDATE row trigger whose arguments name the key: any
  -- other attachment is a mistake, and a mistake must refuse, not pass
  if tg_when <> 'BEFORE' or tg_level <> 'ROW' or tg_op <> 'UPDATE' or tg_nargs = 0 then
    raise exception 'trg_primary_key_immutable runs only as a BEFORE UPDATE row trigger naming the primary-key columns (% on %)',
      tg_name, tg_table_name;
  end if;

  -- user sessions only: current_user is the statement's role — authenticated
  -- for a PostgREST request, the owner inside a SECURITY DEFINER body,
  -- service_role / postgres for imports, maintenance and restores (header,
  -- TRUSTED PATHS)
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- a VALUE comparison: a write that restates the key (an upsert on it, a
  -- PATCH carrying the row's own id) passes. An argument that is not a
  -- column of the row fails the statement (42703) — closed, not open
  foreach v_col in array tg_argv loop
    execute format('select ($1).%1$I is distinct from ($2).%1$I', v_col) into v_changed using new, old;
    if v_changed then
      raise exception 'A record''s primary key cannot be changed (%.%)', tg_table_name, v_col
        using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;

-- a trigger body is called by the trigger, never by a role (hosted's default
-- privileges grant service_role EXECUTE on every new function: revoke all
-- four explicitly, as 0127 / 0131 do)
revoke execute on function public.trg_primary_key_immutable() from public, anon, authenticated, service_role;

comment on function public.trg_primary_key_immutable() is
  'Refuses a user session''s (authenticated / anon) change of a primary-key value with 42501 (0132). Attached BEFORE UPDATE OF <key> FOR EACH ROW as <table>_pk_immutable, with the key columns as arguments; the service role, postgres and definer bodies are not bound. deals: trg_deals_closed_guard (0131).';

-- ---------------------------------------------------------------------------
-- B. one trigger per table, in the lock order above
-- ---------------------------------------------------------------------------
create trigger organizations_pk_immutable before update of id on public.organizations
  for each row execute function public.trg_primary_key_immutable('id');
create trigger profiles_pk_immutable before update of id on public.profiles
  for each row execute function public.trg_primary_key_immutable('id');
create trigger cyprus_config_pk_immutable before update of key on public.cyprus_config
  for each row execute function public.trg_primary_key_immutable('key');
create trigger districts_pk_immutable before update of id on public.districts
  for each row execute function public.trg_primary_key_immutable('id');
create trigger areas_pk_immutable before update of id on public.areas
  for each row execute function public.trg_primary_key_immutable('id');
create trigger deal_stages_pk_immutable before update of id on public.deal_stages
  for each row execute function public.trg_primary_key_immutable('id');
create trigger contacts_pk_immutable before update of id on public.contacts
  for each row execute function public.trg_primary_key_immutable('id');
create trigger buyer_requirements_pk_immutable before update of id on public.buyer_requirements
  for each row execute function public.trg_primary_key_immutable('id');
create trigger properties_pk_immutable before update of id on public.properties
  for each row execute function public.trg_primary_key_immutable('id');
create trigger unit_types_pk_immutable before update of id on public.unit_types
  for each row execute function public.trg_primary_key_immutable('id');
create trigger property_media_pk_immutable before update of id on public.property_media
  for each row execute function public.trg_primary_key_immutable('id');
create trigger property_keys_pk_immutable before update of id on public.property_keys
  for each row execute function public.trg_primary_key_immutable('id');
create trigger price_lists_pk_immutable before update of id on public.price_lists
  for each row execute function public.trg_primary_key_immutable('id');
create trigger price_list_items_pk_immutable before update of price_list_id, unit_id on public.price_list_items
  for each row execute function public.trg_primary_key_immutable('price_list_id', 'unit_id');
create trigger payment_plans_pk_immutable before update of id on public.payment_plans
  for each row execute function public.trg_primary_key_immutable('id');
create trigger documents_pk_immutable before update of id on public.documents
  for each row execute function public.trg_primary_key_immutable('id');
create trigger mandates_pk_immutable before update of id on public.mandates
  for each row execute function public.trg_primary_key_immutable('id');
create trigger leads_pk_immutable before update of id on public.leads
  for each row execute function public.trg_primary_key_immutable('id');
create trigger viewings_pk_immutable before update of id on public.viewings
  for each row execute function public.trg_primary_key_immutable('id');
create trigger offers_pk_immutable before update of id on public.offers
  for each row execute function public.trg_primary_key_immutable('id');
create trigger reservations_pk_immutable before update of id on public.reservations
  for each row execute function public.trg_primary_key_immutable('id');
create trigger reservation_installments_pk_immutable before update of id on public.reservation_installments
  for each row execute function public.trg_primary_key_immutable('id');
create trigger share_links_pk_immutable before update of id on public.share_links
  for each row execute function public.trg_primary_key_immutable('id');
create trigger portal_connections_pk_immutable before update of id on public.portal_connections
  for each row execute function public.trg_primary_key_immutable('id');
create trigger tasks_pk_immutable before update of id on public.tasks
  for each row execute function public.trg_primary_key_immutable('id');

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------
do $$
declare
  sig_fn constant text := 'public.trg_primary_key_immutable()';
  v_n    int;
  v_bad  text;
begin
  -- A: an invoker, owned by postgres, pg_temp last, callable by nobody
  if not exists (select 1 from pg_proc p
                  where p.oid = sig_fn::regprocedure and not p.prosecdef
                    and pg_get_userbyid(p.proowner) = 'postgres'
                    and p.proconfig = array['search_path=public, pg_temp']
                    and p.prorettype = 'trigger'::regtype) then
    raise exception '0132 postflight: trg_primary_key_immutable is not the invoker trigger function owned by postgres with search_path public, pg_temp';
  end if;
  if has_function_privilege('public', sig_fn, 'execute') or has_function_privilege('anon', sig_fn, 'execute')
     or has_function_privilege('authenticated', sig_fn, 'execute') or has_function_privilege('service_role', sig_fn, 'execute') then
    raise exception '0132 postflight: trg_primary_key_immutable is executable by an API role';
  end if;

  -- B: 25 triggers, each named for its table, enabled, BEFORE UPDATE OF
  --    exactly its table's primary key FOR EACH ROW, with the key's columns
  --    as its arguments in key order
  select count(*) into v_n from pg_trigger t where t.tgfoid = sig_fn::regprocedure and not t.tgisinternal;
  if v_n <> 25 then
    raise exception '0132 postflight: % triggers call trg_primary_key_immutable, expected 25', v_n;
  end if;
  --    (coalesce: a NULL anywhere in the shape test is a failure, never a pass)
  select string_agg(t.tgrelid::regclass::text || '.' || t.tgname, ', ') into v_bad
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_constraint con on con.conrelid = t.tgrelid and con.contype = 'p'
   where t.tgfoid = sig_fn::regprocedure and not t.tgisinternal
     and not coalesce((
           t.tgname = c.relname || '_pk_immutable'
           and t.tgenabled = 'O'
           and t.tgqual is null                 -- no WHEN: a WHEN (false) guard guards nothing
           and (t.tgtype & 2) = 2               -- BEFORE
           and (t.tgtype & 1) = 1               -- FOR EACH ROW
           and (t.tgtype & 16) = 16             -- UPDATE
           and (t.tgtype & (4 | 8 | 32)) = 0    -- not INSERT / DELETE / TRUNCATE
           and coalesce((select array_agg(x order by x) from unnest(t.tgattr::int2[]) x), '{}')
               = (select array_agg(x order by x) from unnest(con.conkey) x)
           and t.tgnargs = cardinality(con.conkey)
           and (string_to_array(encode(t.tgargs, 'escape'), '\000'))[1:t.tgnargs]
               = array(select a.attname::text
                         from unnest(con.conkey) with ordinality k(attnum, ord)
                         join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = k.attnum
                        order by k.ord)), false);
  if v_bad is not null then
    raise exception '0132 postflight: not BEFORE UPDATE OF exactly the primary key, enabled, no WHEN, with the key as arguments: %', v_bad;
  end if;

  -- the invariant: every public table (not extension-owned) where an API
  -- role may update a primary-key column carries the guard on that key —
  -- except deals, whose own guard refuses (preflight 2)
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
    from pg_class c
    join pg_constraint con on con.conrelid = c.oid and con.contype = 'p'
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition
     and c.relname <> 'deals'
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_class'::regclass and d.objid = c.oid
                        and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e')
     and exists (select 1 from unnest(con.conkey) k(attnum)
                  where has_column_privilege('authenticated', c.oid, k.attnum, 'UPDATE')
                     or has_column_privilege('anon', c.oid, k.attnum, 'UPDATE'))
     and not exists (select 1 from pg_trigger t
                      where t.tgrelid = c.oid and t.tgfoid = sig_fn::regprocedure and t.tgenabled = 'O');
  if v_bad is not null then
    raise exception '0132 postflight: an API role may update the primary key of %, which carries no guard', v_bad;
  end if;

  raise notice '0132: postflight passed — 25 tables refuse a session''s change of their primary key; deals refuse through 0131''s guard';
end $$;

-- What was guarded, as this file's LAST result (execute_sql returns the last
-- statement's rows; a NOTICE may not reach the apply output).
select count(*) as guarded_tables,
       string_agg(t.tgrelid::regclass::text, ', ' order by t.tgrelid::regclass::text) as tables
  from pg_trigger t
 where t.tgfoid = 'public.trg_primary_key_immutable()'::regprocedure and not t.tgisinternal;
