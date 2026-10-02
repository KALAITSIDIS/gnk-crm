-- =============================================================================
-- 0133 — a session cannot create a record at an id that already has history:
--        a new row never adopts another record's events, notes or documents
--
-- THE GAP (BACKLOG "A client-chosen primary key is an existence oracle…",
-- the adoption paragraph 0132 added; reproduced 2026-10-02 against 0d43711 on
-- the local stack at 0132 through PostgREST with real aal2 sessions of
-- throwaway organisations, pinned RED first by
-- supabase/tests/insert-id-history.test.ts — DECISIONS
-- T-insert-id-without-history has the count):
--
--   * events, interaction_notes and documents are keyed by (entity_type,
--     entity_id) with no foreign key, so history outlives its row: a row a
--     trusted path deleted leaves its history behind (production held 50 such
--     ids on 2026-10-02 — 2 contacts, 25 leads, 22 properties, 1 deal; the
--     local stack thousands, from test clean-ups). `authenticated` holds
--     INSERT on the id of every history subject, so a session INSERTed a NEW
--     row at such an id and the app's own reads gave the new row the old
--     one's history (measured on contacts, leads, properties, deals,
--     viewings, offers, mandates, property_keys, tasks and share_links: the
--     timeline, the notes, the internal documents). An AGENT adopted an
--     admin's and a colleague's events it could not read itself — the
--     timeline reads through the service role, bounded by organisation only.
--   * And on the tables a session may DELETE from: a task's creator deleted
--     it and inserted a new task at its id — the old `created` / `completed`
--     lines became the new task's, labelled with the new title.
--   * 0132 closed the re-key route (UPDATE of the key); this closes INSERT.
--
-- THE FIX:
--
--   A. public.trg_insert_id_without_history(): SECURITY DEFINER, owner
--      postgres, search_path public, pg_temp, EXECUTE revoked from every
--      role (0131's trg_deals_stage_changed_event is the template). DEFINER
--      because the history it must find is not the session's to read:
--      events_select shows an agent / listing manager only the events they
--      wrote and documents_select hides admin_only rows — measured, an
--      INVOKER guard let the agent's adoption through. Its one argument is
--      the table's entity_type. For a session's inserted row it refuses, 42501
--      "A record cannot be created at an id that already has history
--      (<table>.id)", when the new id has, IN THE ROW'S OWN ORGANISATION, an
--      event of that entity_type, an interaction note or a document of it —
--      and, for profiles, any event that profile is the ACTOR of (an orphaned
--      actor's lines would be attributed to the new user) — the statement
--      fails and nothing is kept. It refuses to run attached any other way
--      (not AFTER / ROW / INSERT, or not exactly one argument).
--   B. One trigger per table, `<table>_id_without_history`, AFTER INSERT
--      FOR EACH ROW, on the 11 history subjects a session may insert:
--      profiles (user), contacts (contact), properties (property),
--      property_keys (key), mandates (mandate), leads (lead), deals (deal),
--      viewings (viewing), offers (offer), share_links (share_link), tasks
--      (task). organizations is a history subject but no API role may insert
--      one; documents' history is in event PAYLOADS only (NOT DONE).
--
-- WHY AFTER INSERT, not BEFORE: an AFTER row trigger runs only for a row that
-- was actually inserted — past RLS's WITH CHECK (the organisation, the role,
-- the second factor) and every constraint. A BEFORE guard answers first, so an
-- aal1 session, a role the policy refuses, or another organisation's org_id
-- would learn from its message that an id has history (an oracle ahead of
-- RLS — measured by the map's critic); it would also fire on an upsert's
-- proposed row before its conflict is resolved, so it had to skip ids a live
-- row holds (and race a concurrent delete). An upsert that conflicts inserts
-- nothing and fires no INSERT trigger; its UPDATE is 0132's. The deal-close
-- tests' upserts onto a closed deal (their own `lost` event) are untouched.
--
-- WHAT THE GUARD LETS THROUGH, deliberately:
--   * Not a session (the role GUC — 0127's rule — is not authenticated /
--     anon): the service role, postgres, imports, restores (which run with
--     session_replication_role = replica, where an ENABLE ORIGIN trigger does
--     not fire at all). Inside a SECURITY DEFINER body current_user is the
--     owner; the role GUC still names the API role, so an insert a
--     session-called definer RPC makes is checked too — measured: every such
--     insert takes a fresh default id and passes.
--   * A row of the caller's organisation at an id whose history belongs
--     only to ANOTHER organisation: every reader is bounded by organisation,
--     so nothing is adopted, and a refusal would be an oracle on that
--     organisation's history.
--   * A fresh id with no history — what both session writers that choose an
--     id send: the lead convert's deal (crypto.randomUUID) and the user
--     invite's profile (the new auth user's id).
--
-- CONTRACT. No function the application calls changes: no release-compat
-- entry; database.types.ts lists no trigger functions and regenerates
-- identically. The deployed application never inserts at an id with history
-- (only the two writers above choose an id), so this is NOT deploy-coupled.
--
-- VISIBLE CHANGES FOR A DIRECT POSTGREST CALLER (the application makes none
-- of these requests): an INSERT (or an upsert that inserts) on one of the 11
-- tables at an id with history in the caller's organisation answers 403 /
-- 42501 "A record cannot be created at an id that already has history
-- (<table>.id)".
--
-- COST. Per session INSERT on these tables: three index probes — events_entity_idx (org_id, entity_type, entity_id, …) on
-- every partition (a lookup by entity cannot prune by occurred_at),
-- interaction_notes_entity_idx, documents_entity_idx — and, for a profile,
-- a scan of the organisation's events by actor (no actor index; profiles
-- are inserted only by an admin's invite). The preflight requires the three
-- indexes.
--
-- LOCKS. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on each of the 11 tables:
-- their writes wait until this commits; reads and FK checks do not. All 11
-- are taken FIRST, in ONE statement, parents before children (profiles,
-- contacts, properties, property_keys, mandates, leads, deals, viewings,
-- offers, share_links, tasks LAST — the order the multi-table writers take
-- them). lock_timeout 5 s per table; a 55P03 / 40P01 keeps nothing — apply
-- again, no ledger row. ONE transaction (checked below). Apply in 0132's
-- window: outside 02:55–04:05 UTC, away from 06:00, mid odd minute, not a
-- multiple of five.
--
-- DEPLOY ORDER. Not coupled; branch CI green → hosted 0133 → merge. The
-- preflight refuses, changing nothing, unless the 11 tables exist with an
-- org_id and a uuid id, the three history indexes exist, and none of the
-- names this file creates exists. It ends with one SELECT naming the guarded
-- tables.
--
-- NOT CHANGED: who may insert which rows (RLS); UPDATE / DELETE (0132 guards
-- a key change); the service role, postgres, definer bodies' ids; every
-- existing row; events, notes and documents (no row is written, modified or
-- moved — orphaned histories stay where they are, now unadoptable).
--
-- NOT DONE HERE (BACKLOG):
--   * History keyed by an event PAYLOAD (no index): a document re-inserted at
--     a deleted document's id inherits `document_uploaded` lines (the timeline
--     shows its title); a deal stage re-inserted at a deleted stage's id
--     inherits `stage_changed` movements in report_stage_conversion; a
--     viewing's `viewing_feedback` lines; uuid[] / jsonb ids
--     (buyer_requirements.area_ids / district_ids, party defaults). Each
--     needs its own reader-side or payload-side decision.
--     documents, deal_stages, areas and districts are deleted only by an
--     admin, who can already rename them in place — except a document, whose
--     protect_document_columns freeze (visibility, entity) a delete and
--     re-insert at the same id gets round.
--   * The existence oracle itself (a 23505 on another organisation's id):
--     unchanged — this file neither closes nor widens it.
--   * redact_stale_enquiries matches notes by entity_id without an
--     organisation predicate (0094): another organisation may insert a
--     back-dated website lead at an id whose orphaned notes are ours, and
--     the nightly sweep blanks them — a separate entry (a function body to
--     replace, guarded by its md5).
--   * Natural keys an id guard cannot see: a deleted property's `reference`
--     can be inserted again (portals and the site key by it); a deleted
--     link's token_sha256 likewise; and `contacts.merged_into_id` may be set
--     by UPDATE to show one contact's history on another's page.
--
-- ROLLBACK, a forward migration, ALL IN ONE TRANSACTION: take the 11 tables'
-- locks at once, NOWAIT, retrying ~5 s (DROP TRIGGER takes ACCESS EXCLUSIVE
-- and no drop order avoids every cycle with a session — 0132's review), drop
-- the 11 `<table>_id_without_history` triggers, then the function
-- (supabase/tests/revert-0133.ts builds exactly that text, and the test file
-- replays it). In the same change: delete
-- supabase/tests/insert-id-history.test.ts and revert-0133.ts and the
-- REVERT_0133_SQL call in stage-movement-authentic.test.ts; remove the
-- restore pack's 0133 row and grants row and move its migrations pin
-- FORWARD; restore BACKLOG and docs/04's Grant model paragraph. No data
-- moves.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (133
-- migrations, a grants row, the 0133 SECURITY row); docs/04's Grant model
-- paragraph; stage-movement-authentic.test.ts (0131's replay first removes
-- 0133's deals trigger — its preflight requires exactly three on deals).
-- =============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0133 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad   text;
  v_names text;
begin
  -- every lock the DDL below needs, at its strongest, in one statement,
  -- parents before children (header, LOCKS)
  lock table public.profiles, public.contacts, public.properties, public.property_keys,
             public.mandates, public.leads, public.deals, public.viewings, public.offers,
             public.share_links, public.tasks
    in share row exclusive mode;

  -- 1. each guarded table has a uuid `id` primary key and an `org_id`
  select string_agg(t, ', ' order by t) into v_bad
    from unnest(array['profiles', 'contacts', 'properties', 'property_keys', 'mandates', 'leads', 'deals',
                      'viewings', 'offers', 'share_links', 'tasks']) t
   where not exists (
           select 1 from pg_constraint con
             join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
            where con.conrelid = to_regclass('public.' || t) and con.contype = 'p'
              and cardinality(con.conkey) = 1 and a.attname = 'id' and a.atttypid = 'uuid'::regtype)
      or not exists (
           select 1 from pg_attribute a
            where a.attrelid = to_regclass('public.' || t) and a.attname = 'org_id' and not a.attisdropped
              and a.atttypid = 'uuid'::regtype);
  if v_bad is not null then
    raise exception '0133 aborted: % lack a uuid id primary key or an org_id — nothing was changed', v_bad;
  end if;

  -- 2. the three history indexes the guard's lookups ride on
  select string_agg(i, ', ' order by i) into v_bad
    from unnest(array['events_entity_idx', 'interaction_notes_entity_idx', 'documents_entity_idx']) i
   where to_regclass('public.' || i) is null;
  if v_bad is not null then
    raise exception '0133 aborted: the history index % is missing — nothing was changed', v_bad;
  end if;

  -- 3. the names this file creates are free
  if to_regprocedure('public.trg_insert_id_without_history()') is not null then
    raise exception '0133 aborted: public.trg_insert_id_without_history() already exists — nothing was changed';
  end if;
  select string_agg(t.tgrelid::regclass::text || '.' || t.tgname, ', ' order by t.tgname) into v_names
    from pg_trigger t
   where not t.tgisinternal and t.tgname like '%\_id\_without\_history';
  if v_names is not null then
    raise exception '0133 aborted: a trigger named *_id_without_history already exists (%) — nothing was changed', v_names;
  end if;

  raise notice '0133: preflight passed — 11 history subjects with a uuid id and an org_id, the history indexes present, the names free';
end $$;

-- ---------------------------------------------------------------------------
-- A. the guard
-- ---------------------------------------------------------------------------
create function public.trg_insert_id_without_history()
returns trigger
language plpgsql
security definer
-- pg_temp LAST: unlisted, it is searched FIRST for relations and types
set search_path = public, pg_temp
as $$
declare
  v_type text;
begin
  -- only as an AFTER INSERT row trigger naming the table's entity_type: any
  -- other attachment is a mistake, and a definer that reads every
  -- organisation's history must not be attachable anywhere else
  if tg_when <> 'AFTER' or tg_level <> 'ROW' or tg_op <> 'INSERT' or tg_nargs <> 1 then
    raise exception 'trg_insert_id_without_history runs only as an AFTER INSERT row trigger naming the entity_type (% on %)',
      tg_name, tg_table_name;
  end if;
  v_type := tg_argv[0];

  -- user sessions only. Inside a definer current_user is the owner; the role
  -- GUC still names the API role (0127): authenticated / anon for a session,
  -- service_role for imports, none for postgres, cron and restores
  if coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon') then
    return null;
  end if;

  -- AFTER: this row passed RLS (its org_id is the caller's) and every
  -- constraint; only the history of its own organisation counts
  if exists (select 1 from public.events e
              where e.org_id = new.org_id and e.entity_type = v_type and e.entity_id = new.id)
     or exists (select 1 from public.interaction_notes n
                 where n.org_id = new.org_id and n.entity_type = v_type and n.entity_id = new.id)
     or exists (select 1 from public.documents d
                 where d.org_id = new.org_id and d.entity_type = v_type and d.entity_id = new.id)
     or (v_type = 'user' and exists (select 1 from public.events e
                                      where e.org_id = new.org_id and e.actor_id = new.id)) then
    raise exception 'A record cannot be created at an id that already has history (%.id)', tg_table_name
      using errcode = '42501';
  end if;
  return null;
end $$;

-- a trigger body is called by the trigger, never by a role (hosted's default
-- privileges grant service_role EXECUTE on every new function)
revoke execute on function public.trg_insert_id_without_history() from public, anon, authenticated, service_role;

comment on function public.trg_insert_id_without_history() is
  'Refuses a user session''s (role authenticated / anon) INSERT at an id that already has events, interaction notes or documents of the table''s entity_type in the row''s organisation (profiles: also events it is the actor of) — 42501 (0133). SECURITY DEFINER so it sees history the session cannot; AFTER so it answers only for a row RLS admitted. Attached AFTER INSERT FOR EACH ROW as <table>_id_without_history with the entity_type as its argument.';

-- ---------------------------------------------------------------------------
-- B. one trigger per history subject, in the lock order above
-- ---------------------------------------------------------------------------
create trigger profiles_id_without_history after insert on public.profiles
  for each row execute function public.trg_insert_id_without_history('user');
create trigger contacts_id_without_history after insert on public.contacts
  for each row execute function public.trg_insert_id_without_history('contact');
create trigger properties_id_without_history after insert on public.properties
  for each row execute function public.trg_insert_id_without_history('property');
create trigger property_keys_id_without_history after insert on public.property_keys
  for each row execute function public.trg_insert_id_without_history('key');
create trigger mandates_id_without_history after insert on public.mandates
  for each row execute function public.trg_insert_id_without_history('mandate');
create trigger leads_id_without_history after insert on public.leads
  for each row execute function public.trg_insert_id_without_history('lead');
create trigger deals_id_without_history after insert on public.deals
  for each row execute function public.trg_insert_id_without_history('deal');
create trigger viewings_id_without_history after insert on public.viewings
  for each row execute function public.trg_insert_id_without_history('viewing');
create trigger offers_id_without_history after insert on public.offers
  for each row execute function public.trg_insert_id_without_history('offer');
create trigger share_links_id_without_history after insert on public.share_links
  for each row execute function public.trg_insert_id_without_history('share_link');
create trigger tasks_id_without_history after insert on public.tasks
  for each row execute function public.trg_insert_id_without_history('task');

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------
do $$
declare
  sig_fn constant text := 'public.trg_insert_id_without_history()';
  v_bad  text;
  v_n    int;
  v_src  text;
begin
  -- A: a definer owned by postgres, pg_temp last, callable by nobody, binding
  --    sessions by the role GUC (current_user is the owner inside a definer:
  --    a current_user test here would never fire)
  select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_src
    from pg_proc p
   where p.oid = sig_fn::regprocedure and p.prosecdef
     and pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig = array['search_path=public, pg_temp']
     and p.prorettype = 'trigger'::regtype;
  if v_src is null then
    raise exception '0133 postflight: trg_insert_id_without_history is not the definer trigger function owned by postgres with search_path public, pg_temp';
  end if;
  if v_src !~ 'current_setting\(''role'', true\)' or v_src ~ 'current_user'
     or v_src !~ 'errcode = ''42501''' or v_src ~* '(update|insert\s+into|delete\s+from)\s' then
    raise exception '0133 postflight: trg_insert_id_without_history does not bind sessions by the role GUC, refuse with 42501 and only read';
  end if;
  if has_function_privilege('public', sig_fn, 'execute') or has_function_privilege('anon', sig_fn, 'execute')
     or has_function_privilege('authenticated', sig_fn, 'execute') or has_function_privilege('service_role', sig_fn, 'execute') then
    raise exception '0133 postflight: trg_insert_id_without_history is executable by an API role';
  end if;

  -- B: exactly the 11 triggers, each named for its table, enabled, no WHEN,
  --    AFTER INSERT FOR EACH ROW only, its one argument the table's entity_type
  select count(*) into v_n from pg_trigger t where t.tgfoid = sig_fn::regprocedure and not t.tgisinternal;
  if v_n <> 11 then
    raise exception '0133 postflight: % triggers call trg_insert_id_without_history, expected 11', v_n;
  end if;
  select string_agg(x.tbl, ', ' order by x.tbl) into v_bad
    from (values ('profiles', 'user'), ('contacts', 'contact'), ('properties', 'property'), ('property_keys', 'key'),
                 ('mandates', 'mandate'), ('leads', 'lead'), ('deals', 'deal'), ('viewings', 'viewing'),
                 ('offers', 'offer'), ('share_links', 'share_link'), ('tasks', 'task')) x(tbl, entity_type)
   where not exists (
           select 1 from pg_trigger t
            where t.tgrelid = to_regclass('public.' || x.tbl) and t.tgfoid = sig_fn::regprocedure
              and coalesce((
                    t.tgname = x.tbl || '_id_without_history'
                    and not t.tgisinternal and t.tgenabled = 'O' and t.tgqual is null
                    and (t.tgtype & (2 | 64)) = 0       -- AFTER (not BEFORE, not INSTEAD OF)
                    and (t.tgtype & 1) = 1              -- FOR EACH ROW
                    and (t.tgtype & 4) = 4              -- INSERT
                    and (t.tgtype & (8 | 16 | 32)) = 0  -- not DELETE / UPDATE / TRUNCATE
                    and t.tgnargs = 1
                    and (string_to_array(encode(t.tgargs, 'escape'), '\000'))[1] = x.entity_type), false));
  if v_bad is not null then
    raise exception '0133 postflight: not AFTER INSERT FOR EACH ROW with its entity_type, enabled, no WHEN: %', v_bad;
  end if;

  -- 0118's tripwire still holds: no SECURITY DEFINER function other than
  -- close_deal writes deals (this one only reads)
  select string_agg(ns.nspname || '.' || p.proname, ', ' order by ns.nspname, p.proname) into v_src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where p.prosecdef
     and ns.nspname not in ('pg_catalog', 'information_schema')
     and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '(update|insert\s+into)\s+(public\.)?deals\y'
     and not (ns.nspname = 'public' and p.proname = 'close_deal')
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                        and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e');
  if v_src is not null then
    raise exception '0133 postflight: a SECURITY DEFINER function other than close_deal writes deals: %', v_src;
  end if;

  raise notice '0133: postflight passed — 11 history subjects refuse a session''s INSERT at an id with history';
end $$;

-- What was guarded, as this file's LAST result (execute_sql returns the last
-- statement's rows; a NOTICE may not reach the apply output).
select count(*) as guarded_tables,
       string_agg(t.tgrelid::regclass::text || ':' || (string_to_array(encode(t.tgargs, 'escape'), '\000'))[1], ', '
                  order by t.tgrelid::regclass::text) as tables
  from pg_trigger t
 where t.tgfoid = 'public.trg_insert_id_without_history()'::regprocedure and not t.tgisinternal;
