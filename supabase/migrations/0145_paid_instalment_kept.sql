-- =============================================================================
-- 0145 — a PAID instalment line is never deleted by a user session
-- (T-schedule-paid-guard, 2026-10-12; found by T-keys-header-counts's sweep,
-- verified first through the real actions on a disposable stack).
--
-- THE DEFECT. lib/actions/reservation-schedule.ts refuses to replace
-- (applyPaymentPlan) or remove (clearSchedule) a reservation's payment
-- schedule "once anything is paid", by counting the paid lines first, and
-- then DELETES EVERY LINE of the reservation (applyPaymentPlan then inserts a
-- fresh, unpaid schedule). Measured at 217fbee through the real actions:
--   - the count's failure read as "nothing paid" (`count ?? 0`; postgrest-js
--     answers a failed HEAD count with count null, a HEAD 404 with no error
--     at all), so the paid line was deleted with the rest and the action
--     reported success and wrote its event;
--   - a line paid BETWEEN the count and the delete (two requests) was
--     deleted too;
--   - an admin's or listing manager's own DELETE of a paid line, straight
--     through PostgREST, was accepted: reservation_installments_delete (0050)
--     checks only the organisation and the role;
--   - so was the CASCADE from their DELETE of the reservation itself
--     (reservations_delete, 0044; reservation_installments_org_reservation_
--     fkey is ON DELETE CASCADE, 0124). No screen sends that delete; nothing
--     refused it.
-- The installment_paid events keep the payment facts; the live schedule
-- (which line is paid, how much, Received / Outstanding) was gone.
--
-- THE FIX. One BEFORE DELETE row trigger, reservation_installments_keep_paid
-- calling public.trg_installment_paid_kept(), refuses — 42501, "A paid
-- instalment cannot be deleted — un-mark it first" — the deletion of a line
-- whose paid_at is set, by a USER SESSION. A BEFORE ROW trigger sees the row
-- as the DELETE locked it, so a mark-paid that committed first is seen: the
-- race is closed, not narrowed. A bulk DELETE holding one paid line is
-- refused WHOLE (an error aborts the statement), never thinned. The trigger
-- returns OLD (a NULL would silently SKIP the row, and applyPaymentPlan would
-- then insert over survivors). The application's own check stays and now
-- refuses when it cannot read the count (same change); this file is what
-- binds every other path.
--
-- WHO IS BOUND. A caller is a user session when current_user OR the role GUC
-- is authenticated / anon. current_user alone (0127 / 0134's trigger idiom)
-- is NOT enough here: PostgreSQL runs a foreign-key cascade's child DELETE as
-- the child table's owner, so inside the cascade from a session's
-- reservations DELETE current_user is postgres — while the role GUC still
-- names the session's API role (0127 measured it: authenticated / anon for a
-- session, service_role for the service role, none for postgres, cron and
-- restores; 0133 binds on it). Measured by schedule-paid-guard.test.ts: a
-- session's reservation DELETE over a paid line is refused, reservation and
-- lines intact. The same binding covers any future SECURITY DEFINER or
-- invoker function a SESSION calls that would delete a paid line — such a
-- function must refuse or un-mark first (the preflight's apply-time tripwire
-- finds none today; it is a check when this file runs, not a guard after).
--
-- TRUSTED PATHS (not bound): service_role (imports, e2e fixtures, the
-- application's admin client), postgres (maintenance, test fixtures, cron —
-- none deletes lines today), and restores (session_replication_role =
-- replica fires no trigger). UN-MARK, THEN DELETE stays allowed by design:
-- markInstallment (any org member; it writes installment_unpaid) clears
-- paid_at, after which an admin / listing manager may remove the line — the
-- path the screen's "un-mark them first" names.
--
-- WHY A TRIGGER. `paid_at is null` in reservation_installments_delete's USING
-- would FILTER silently: a partial schedule delete, then applyPaymentPlan's
-- insert colliding at (org_id, reservation_id, sort_order) or interleaving two
-- schedules. A CHECK cannot see a DELETE. Column privileges cannot express
-- "this row".
--
-- NOT DONE (BACKLOG "Payment schedule — 2026-10-12"): an UPDATE can still
-- move a paid line to another hold of the same organisation (reservation_id,
-- any org member), an upsert can restate a paid line, a direct PATCH can
-- un-mark one without its installment_unpaid event — none deletes a paid
-- line; applyPaymentPlan's delete → insert → link is still not atomic.
--
-- EXISTING ROWS. Nothing is changed or repaired. The final row (and a NOTICE)
-- reports the paid lines and the reservations holding one, read-only — but
-- the guarded single execute_sql the house applies hosted migrations with
-- discards both, so the hosted preflight reads those counts itself.
--
-- LOCKS. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on reservation_installments
-- (taken first, by the preflight's LOCK, so nothing is upgraded later): reads
-- go on; writes to the lines wait for this transaction (milliseconds). No
-- cron job writes the table. lock_timeout bounds the wait (5 s): a collision
-- costs a clean 55P03 — apply again, and do NOT write the ledger row.
--
-- DEPLOY ORDER: ADDITIVE — hosted whenever the operator approves, before or
-- after the application release that maps the refusal to the screen's words.
-- The deployed application deletes a paid line only on a failed count or in
-- the race; until its release lands, those two refusals show the trigger's
-- sentence (written to be read on its own) instead of the old silent
-- deletion. No function signature, return shape or grant changes — no
-- release-compat entry; lib/supabase/database.types.ts does not change (a
-- trigger is not part of the generated types — regenerated and diffed).
--
-- ROLLBACK (DECISIONS T-schedule-paid-guard): a FORWARD migration dropping
-- the trigger and its function under the same bounded lock
-- (supabase/tests/revert-0145.ts holds the text), moving the verify-restore
-- migrations pin FORWARD and removing its 0145 row and grants row. No data
-- moves either way.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count 144 -> 145, a grants row, the 0145 SECURITY row); docs/04
-- (reservation_installments). NO EXPLICIT begin/commit — the CLI wraps the
-- file (HANDOFF §3), as does one execute_sql call; applied hosted inside the
-- md5-guarded DO (DECISIONS T-unit-type-apply-atomic), where a clean return
-- with no rows is the success signal. The file's LAST result is a read-only
-- summary for the CLI.
-- =============================================================================

-- Bounded lock waits (0113's lesson); see LOCKS above.
set local lock_timeout = '5s';

-- The file must run as ONE transaction (the CLI's wrapper, or one
-- execute_sql call): otherwise SET LOCAL is a no-op, the preflight's LOCK is
-- released as soon as its statement ends, and a failed assertion would not
-- undo the DDL before it.
do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0145 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the table is what this file was written against
-- ---------------------------------------------------------------------------
do $$
declare
  v_trg  text;
  v_def  text;
  v_diag text;
begin
  -- the lock CREATE TRIGGER needs, first (header, LOCKS)
  lock table public.reservation_installments in share row exclusive mode;

  -- 1. the only user trigger is 0132's
  select string_agg(t.tgname, ', ' order by t.tgname) into v_trg
    from pg_trigger t where t.tgrelid = 'public.reservation_installments'::regclass and not t.tgisinternal;
  if v_trg is distinct from 'reservation_installments_pk_immutable' then
    raise exception '0145 aborted: the triggers on reservation_installments are not the expected set (%) — nothing was changed', coalesce(v_trg, 'none');
  end if;

  -- 2. the names this file creates are free
  if to_regprocedure('public.trg_installment_paid_kept()') is not null then
    raise exception '0145 aborted: public.trg_installment_paid_kept() already exists — nothing was changed';
  end if;

  -- 3. "paid" means paid_at set, and a paid line always carries its amount
  --    (0050's installment_paid_coherent, validated)
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.reservation_installments'::regclass and c.conname = 'installment_paid_coherent'
     and c.contype = 'c' and c.convalidated;
  if v_def is distinct from
     'CHECK ((((paid_at IS NULL) AND (paid_amount IS NULL)) OR ((paid_at IS NOT NULL) AND (paid_amount IS NOT NULL))))' then
    raise exception '0145 aborted: installment_paid_coherent is not 0050''s validated check (%) — nothing was changed', coalesce(v_def, 'missing');
  end if;

  -- 4. TRUNCATE fires no row trigger: no API role may truncate the lines or
  --    their reservations
  if has_table_privilege('authenticated', 'public.reservation_installments', 'truncate')
     or has_table_privilege('anon', 'public.reservation_installments', 'truncate')
     or has_table_privilege('authenticated', 'public.reservations', 'truncate')
     or has_table_privilege('anon', 'public.reservations', 'truncate') then
    raise exception '0145 aborted: an API role holds TRUNCATE on reservation_installments or reservations — nothing was changed';
  end if;

  -- 5. no SECURITY DEFINER body deletes lines or reservations: a session
  --    calling one would be bound by the role GUC (header, WHO IS BOUND) —
  --    say so before it ships (0118's tripwire; extension-owned excluded).
  --    An APPLY-TIME check, not a durable guard: it reads plpgsql/sql
  --    bodies and SQL-standard (BEGIN ATOMIC) ones, quoted identifiers
  --    included; dynamic SQL is beyond any text scan
  select string_agg(ns.nspname || '.' || p.proname, ', ' order by ns.nspname, p.proname) into v_diag
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where p.prosecdef
     and ns.nspname not in ('pg_catalog', 'information_schema')
     and regexp_replace(coalesce(p.prosrc, '') || ' ' || coalesce(pg_get_function_sqlbody(p.oid), ''), '--[^\n]*', '', 'g')
         ~* 'delete\s+from\s+(only\s+)?("?public"?\s*\.\s*)?"?(reservation_installments|reservations)"?\y'
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                        and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e');
  if v_diag is not null then
    raise exception '0145 aborted: a SECURITY DEFINER function deletes instalment lines or reservations (%) — nothing was changed', v_diag;
  end if;

  -- EXISTING ROWS (read-only)
  perform set_config('gnk.m0145_existing',
    format('paid_lines=%s reservations_with_a_paid_line=%s',
           (select count(*) from public.reservation_installments where paid_at is not null),
           (select count(distinct reservation_id) from public.reservation_installments where paid_at is not null)),
    true);
end $$;

-- ---------------------------------------------------------------------------
-- The guard
-- ---------------------------------------------------------------------------
create function public.trg_installment_paid_kept()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_when <> 'BEFORE' or tg_level <> 'ROW' or tg_op <> 'DELETE'
     or tg_table_schema <> 'public' or tg_table_name <> 'reservation_installments' then
    raise exception 'trg_installment_paid_kept runs only as a BEFORE DELETE row trigger on public.reservation_installments (% on %.%)',
      tg_name, tg_table_schema, tg_table_name;
  end if;

  -- user sessions only (header, WHO IS BOUND): current_user for a session's
  -- own DELETE, the role GUC for the cascade from its reservations DELETE
  -- (run as the table's owner)
  if current_user not in ('authenticated', 'anon')
     and coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon') then
    return old;
  end if;

  if old.paid_at is not null then
    raise exception 'A paid instalment cannot be deleted — un-mark it first (reservation_installments.%)', old.id
      using errcode = '42501';
  end if;
  return old;
end $$;

revoke execute on function public.trg_installment_paid_kept() from public, anon, authenticated, service_role;

comment on function public.trg_installment_paid_kept() is
  'A paid instalment line (paid_at set) is never deleted by a user session — its own DELETE or the cascade from its reservations DELETE: refuses with 42501 (0145). Un-mark it first (markInstallment). service_role, postgres and restores are not bound. Attached BEFORE DELETE FOR EACH ROW as reservation_installments_keep_paid.';

create trigger reservation_installments_keep_paid
  before delete on public.reservation_installments
  for each row execute function public.trg_installment_paid_kept();

-- ---------------------------------------------------------------------------
-- Postflight. The behaviour needs sessions and is proven by
-- supabase/tests/schedule-paid-guard.test.ts; here the shape.
-- ---------------------------------------------------------------------------
do $$
declare
  sig   constant text := 'public.trg_installment_paid_kept()';
  v_trg text;
begin
  -- an invoker, owned by postgres, pg_temp last, callable by nobody
  if not exists (select 1 from pg_proc p
                  where p.oid = sig::regprocedure and not p.prosecdef
                    and pg_get_userbyid(p.proowner) = 'postgres'
                    and p.proconfig = array['search_path=public, pg_temp']
                    and p.prorettype = 'trigger'::regtype) then
    raise exception '0145 postflight: % is not an invoker trigger function owned by postgres with search_path public, pg_temp', sig;
  end if;
  if has_function_privilege('public', sig, 'execute') or has_function_privilege('anon', sig, 'execute')
     or has_function_privilege('authenticated', sig, 'execute') or has_function_privilege('service_role', sig, 'execute') then
    raise exception '0145 postflight: % is executable by an API role', sig;
  end if;

  -- attached exactly once, enabled, no WHEN, no column list, no arguments,
  -- BEFORE DELETE FOR EACH ROW (coalesce: a NULL anywhere is a failure)
  if (select count(*) from pg_trigger t where t.tgfoid = sig::regprocedure and not t.tgisinternal) <> 1
     or not coalesce((select t.tgrelid = 'public.reservation_installments'::regclass
                             and t.tgname = 'reservation_installments_keep_paid'
                             and t.tgenabled = 'O' and t.tgqual is null
                             and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1          -- BEFORE, ROW
                             and (t.tgtype & 8) = 8                                 -- DELETE
                             and (t.tgtype & (4 | 16 | 32)) = 0                     -- not INSERT / UPDATE / TRUNCATE
                             and cardinality(t.tgattr::int2[]) = 0 and t.tgnargs = 0
                        from pg_trigger t where t.tgfoid = sig::regprocedure and not t.tgisinternal), false) then
    raise exception '0145 postflight: reservation_installments_keep_paid is not the one enabled BEFORE DELETE row trigger on reservation_installments calling the guard';
  end if;

  -- the table's user triggers are 0132's and this file's
  select string_agg(t.tgname, ', ' order by t.tgname) into v_trg
    from pg_trigger t where t.tgrelid = 'public.reservation_installments'::regclass and not t.tgisinternal;
  if v_trg is distinct from 'reservation_installments_keep_paid, reservation_installments_pk_immutable' then
    raise exception '0145 postflight: the triggers on reservation_installments are %', coalesce(v_trg, 'none');
  end if;

  raise notice '0145: postflight passed — a paid instalment line is kept from user sessions';
  raise notice '0145: existing rows (read-only, nothing changed) — %', current_setting('gnk.m0145_existing', true);
end $$;

-- for the CLI: the last row carries the diagnostic (a guarded hosted apply
-- discards it; its preflight reads the same counts)
select '0145 applied — existing rows (read-only, nothing changed): ' || current_setting('gnk.m0145_existing', true) as existing_rows;
