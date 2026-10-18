-- =============================================================================
-- 0152 — storage room has ONE value: 'storage_room' in properties.features;
-- properties.has_storage becomes its derived mirror
-- (F02, product review 2026-10-18).
--
-- THE DEFECT. Since 0001 one physical fact has two stores:
--   - properties.has_storage boolean (0001), the doc-03 column — the
--     Details tab's "Areas & rooms" box labelled "Storage room";
--   - the key 'storage_room' in properties.features text[] (0001), from
--     lib/constants/features.ts — the Details tab's Features box, ALSO
--     labelled "Storage room".
-- The form saved the two independently and nothing related them: no CHECK,
-- no trigger, no code. They drifted (hosted held rows with the column true
-- and the feature absent, and the reverse). Every reader but one reads the
-- FEATURE — buyer matching (lib/services/matching.ts), unit inheritance
-- (INHERITED_UNIT_FIELDS carries features, not has_storage), the portal
-- dialects, the share-link payloads — while the public feed (public_listings,
-- 0088) returns BOTH, so the site could print "storage room" for a listing no
-- buyer requiring one is ever matched to, or the other way round.
--
-- THE FIX. The feature is the one canonical value; the column stays, as a
-- mirror, because the feed's shape (RLS test 41's FEED_COLUMNS, gnk-web's
-- feed schema, the portal FeedRow) depends on it and a return-shape change
-- fails open on the site.
--   1. One invoker trigger body, trg_property_storage_from_features():
--        new.has_storage := coalesce('storage_room' = any(new.features), false)
--      (coalesce: a NULL element in features makes "= any" NULL; storage is
--      then absent, as it is for every other key).
--   2. Attached as properties_storage_from_features, BEFORE INSERT OR UPDATE
--      OF features, has_storage FOR EACH ROW: every insert, and every update
--      that names either column, gets the derived value — whatever the writer
--      sent for has_storage is replaced. That binds every writer: sessions,
--      service_role (the importer), postgres, definer bodies, the unit
--      generator and the project → unit features sync. (A restore's data
--      load in replica mode fires no trigger; the restore pack's 0152 row
--      counts the rows out of step.)
--   3. The column's comment says it is derived.
-- In the same change the application stops writing the column on its own:
-- the Details form's "Areas & rooms" box is removed, the details validator
-- drops has_storage, and updatePropertySection writes
-- has_storage = features ∋ STORAGE_FEATURE (lib/constants/features.ts) so its
-- `updated` event records the column moving with the feature.
--
-- EXISTING DATA — THE CONFLICT REPORT. A row whose has_storage is NOT NULL and
-- disagrees with the feature is a fact recorded two ways, and which one is
-- true is a person's call, not this file's: the preflight ABORTS THE WHOLE
-- FILE, before anything is written, naming the count and up to twenty
-- references. Nothing is overwritten. List them, with when each side was last
-- set, read-only:
--   select p.org_id, p.id, p.reference, p.kind, p.visibility, p.status,
--          p.has_storage, coalesce('storage_room' = any(p.features), false) as storage_feature,
--          (select max(e.occurred_at) from public.events e
--            where e.entity_type = 'property' and e.entity_id = p.id and e.event_type = 'updated'
--              and e.payload -> 'changed' ? 'has_storage') as has_storage_last_set,
--          (select max(e.occurred_at) from public.events e
--            where e.entity_type = 'property' and e.entity_id = p.id and e.event_type = 'updated'
--              and e.payload -> 'changed' ? 'features') as features_last_set
--     from public.properties p
--    where p.has_storage is not null
--      and p.has_storage is distinct from coalesce('storage_room' = any(p.features), false)
--    order by p.org_id, p.reference;
-- settle each on its Details tab IN THE RELEASE NOW SERVING, where both
-- "Storage room" boxes are still shown (a tick is deliberate; an unticked
-- box, stored false, is the form's default): tick or untick both alike, then
-- apply again. Every such save is evented. Do NOT leave them for the release
-- that carries this change — it shows the column nowhere and settles a row
-- on its next Details save without asking (DEPLOY ORDER).
-- A row whose has_storage is NULL (never set: the create wizard and the
-- importer write neither) is BACKFILLED to the derived value and counted.
-- No event is written for it: it is a projection of a fact the row already
-- records (its features), the 0073 published_at precedent. Its updated_at
-- moves (properties_updated) — correctly: the feed carries has_storage and
-- the feed's validator reads updated_at, so the site revalidates once; an
-- edit form open on such a row gets the A06 "changed since you opened it"
-- refusal once.
--
-- LOCKS. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on properties; the
-- preflight takes it FIRST, before the conflict count, so no write lands
-- between the count and the trigger and nothing is upgraded later (CREATE OR
-- REPLACE TRIGGER and COMMENT ON COLUMN need no stronger lock; the backfill's
-- ROW EXCLUSIVE is the file's own). While it is held every write to
-- properties waits — reads do not: the pages, the public feed and the portal
-- feed keep answering — for the milliseconds the file takes. lock_timeout
-- bounds the wait (5 s); a collision costs a clean 55P03 — apply again, and
-- do NOT write the ledger row. Run twice, the file replaces its own function
-- and trigger and changes nothing.
--
-- DEPLOY ORDER: SETTLE, THEN HOSTED, THEN THE MERGE STRAIGHT AFTER IT.
-- Neither side needs the other to run (the release's save writes the mirror
-- itself; this file binds whatever writes), but each order leaves a window:
--   - hosted first, the OLD release still serving: its "Areas & rooms" box
--     still posts has_storage, the trigger replaces it with the derived
--     value, and that save's `updated` event records a has_storage change
--     the row does not hold — kept short by merging straight after;
--   - the release first, this file not yet applied: the new Details save
--     writes has_storage = the feature on EVERY save and the column is shown
--     nowhere, so any unrelated Details save of a row still in conflict
--     settles it in the feature's favour with no one deciding — a column
--     tick with no feature is dropped (true -> false; evented, but chosen by
--     no person), against the conflict report's "decided by a person".
-- So the sequence is: (1) run the conflict report's read-only query above;
-- (2) settle every row it lists in the release now serving, both boxes
-- alike; (3) apply this file (its preflight refuses while any conflict is
-- left); (4) merge straight after. No function signature, return shape
-- or grant on any existing object changes — no release-compat entry;
-- lib/supabase/database.types.ts does not change (the column keeps its type
-- and nullability; trigger functions are not in the generated types).
-- public_listings(), the portal functions and RLS are untouched.
--
-- ROLLBACK (DECISIONS F02): a FORWARD migration dropping the trigger and the
-- function and clearing the column's comment under ACCESS EXCLUSIVE (DROP
-- TRIGGER's lock), bounded the same way (supabase/tests/revert-0152.ts holds
-- the text), moving the verify-restore migrations pin FORWARD and removing
-- its 0152 rows. No data moves back: the backfilled values are valid at 0151
-- (has_storage was free there), and which rows were NULL is not kept.
--
-- Pins that move with this file: the migrations count and one 0152
-- INTEGRITY row in scripts/backup/verify-restore.sql, plus a grants_expected
-- row for the trigger body (callable by nobody, like 0145's). NO EXPLICIT
-- begin/commit — the CLI wraps the file (HANDOFF §3), as does one
-- execute_sql call; applied hosted inside the md5-guarded DO (DECISIONS
-- T-unit-type-apply-atomic). The file's LAST result is a read-only summary
-- for the CLI.
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
    raise exception '0152 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — the table is what this file was written against, and no row
--    records a storage room two ways (the conflict report)
-- ---------------------------------------------------------------------------
do $$
declare
  n      int;
  v_refs text;
  v_trg  text;
  v_md5  text;
begin
  -- the lock CREATE TRIGGER needs, BEFORE the count (header, LOCKS)
  lock table public.properties in share row exclusive mode;

  -- 1. has_storage is an optional boolean and features a required text[]
  if (select count(*) from pg_attribute
       where attrelid = 'public.properties'::regclass and not attisdropped
         and ((attname = 'has_storage' and atttypid = 'boolean'::regtype and not attnotnull)
           or (attname = 'features' and atttypid = 'text[]'::regtype and attnotnull))) <> 2 then
    raise exception '0152 aborted: properties.has_storage (optional boolean) or properties.features (required text[]) is not what this file was written against — nothing was changed';
  end if;

  -- 2. the table's user triggers are the 0149 set — or that set and this
  --    file's own, on a replay. A BEFORE trigger sorting after this file's
  --    could rewrite has_storage behind it, so an unknown one stops the file.
  select string_agg(t.tgname, ', ' order by t.tgname) into v_trg
    from pg_trigger t where t.tgrelid = 'public.properties'::regclass and not t.tgisinternal;
  if v_trg is distinct from 'properties_id_without_history, properties_pk_immutable, properties_price_history, properties_reference_immutable, properties_updated'
     and v_trg is distinct from 'properties_id_without_history, properties_pk_immutable, properties_price_history, properties_reference_immutable, properties_storage_from_features, properties_updated' then
    raise exception '0152 aborted: the triggers on properties are not the expected set (%) — nothing was changed', coalesce(v_trg, 'none');
  end if;

  -- 3. the names this file creates are free, or are this file's own (replay):
  --    the body by digest of md5(replace(prosrc, chr(13), '')), and the
  --    trigger calling it
  if to_regprocedure('public.trg_property_storage_from_features()') is not null then
    select md5(replace(p.prosrc, chr(13), '')) into v_md5
      from pg_proc p where p.oid = 'public.trg_property_storage_from_features()'::regprocedure;
    if v_md5 is distinct from 'af2ecbb9e02c24657f620dcc6b792fd1' then
      raise exception '0152 aborted: public.trg_property_storage_from_features() exists with a body this file did not write (md5 %) — read it before replacing it; nothing was changed', v_md5;
    end if;
  end if;
  if exists (select 1 from pg_trigger t
              where t.tgrelid = 'public.properties'::regclass and t.tgname = 'properties_storage_from_features'
                and t.tgfoid is distinct from to_regprocedure('public.trg_property_storage_from_features()')) then
    raise exception '0152 aborted: a trigger properties_storage_from_features exists that does not call this file''s function — nothing was changed';
  end if;

  -- 4. THE CONFLICT REPORT: a has_storage that is set and disagrees with the
  --    feature is decided by a person, never here (header, EXISTING DATA)
  select count(*), string_agg(c.reference, ', ' order by c.reference) filter (where c.rn <= 20)
    into n, v_refs
    from (select p.reference, row_number() over (order by p.reference) as rn
            from public.properties p
           where p.has_storage is not null
             and p.has_storage is distinct from coalesce('storage_room' = any(p.features), false)) c;
  if n > 0 then
    raise exception '0152 aborted: % property row(s) record a storage room two ways — has_storage disagrees with the Storage room feature (references%: %) — nothing was changed. '
                    'Settle each on its Details tab (the read-only query in this file''s header lists them with when each side was last set), then apply again',
                    n, case when n > 20 then ', the first 20' else '' end, v_refs;
  end if;

  raise notice '0152: preflight passed — no property records a storage room two ways';
end $$;

-- ---------------------------------------------------------------------------
-- 1. Backfill — a has_storage never set takes the feature's value, counted
--    (no event: header, EXISTING DATA)
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  update public.properties
     set has_storage = coalesce('storage_room' = any(features), false)
   where has_storage is null;
  get diagnostics n = row_count;
  perform set_config('gnk.m0152_backfilled', n::text, true);
end $$;

-- ---------------------------------------------------------------------------
-- 2. The rule: has_storage is derived from features on every write
-- ---------------------------------------------------------------------------
create or replace function public.trg_property_storage_from_features()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_when <> 'BEFORE' or tg_level <> 'ROW' or tg_op not in ('INSERT', 'UPDATE')
     or tg_table_schema <> 'public' or tg_table_name <> 'properties' then
    raise exception 'trg_property_storage_from_features runs only as a BEFORE INSERT OR UPDATE row trigger on public.properties (% on %.%)',
      tg_name, tg_table_schema, tg_table_name;
  end if;

  -- storage room has one value, the 'storage_room' feature; has_storage is
  -- its mirror, whatever the writer sent
  new.has_storage := coalesce('storage_room' = any(new.features), false);
  return new;
end $$;

revoke execute on function public.trg_property_storage_from_features() from public, anon, authenticated, service_role;

comment on function public.trg_property_storage_from_features() is
  'Storage room has ONE value, the ''storage_room'' key in properties.features (0152, F02): sets has_storage to whether features holds it, '
  'replacing whatever the writer sent. Attached BEFORE INSERT OR UPDATE OF features, has_storage FOR EACH ROW as properties_storage_from_features.';

create or replace trigger properties_storage_from_features
  before insert or update of features, has_storage on public.properties
  for each row execute function public.trg_property_storage_from_features();

comment on column public.properties.has_storage is
  'Derived (0152, F02): true iff features holds ''storage_room'', the one storage-room value. Kept for the public_listings() shape; '
  'set by the trigger properties_storage_from_features on every insert and every update of features or has_storage — a value written for it is replaced.';

-- ---------------------------------------------------------------------------
-- 3. Postflight — the body, the trigger, the grants, no row out of step;
--    then the behaviour, inside a block that undoes what it writes
-- ---------------------------------------------------------------------------
do $$
declare
  sig    constant text := 'public.trg_property_storage_from_features()';
  v_trg  text;
  v_n    int;
  v_id   uuid;
  v_got  boolean;
  v_want boolean;
begin
  -- an invoker plpgsql body owned by postgres, pg_temp last, no arguments,
  -- this file's text
  if not exists (select 1 from pg_proc p
                  where p.oid = to_regprocedure(sig) and not p.prosecdef
                    and pg_get_userbyid(p.proowner) = 'postgres'
                    and p.prolang = (select l.oid from pg_language l where l.lanname = 'plpgsql')
                    and p.proconfig = array['search_path=public, pg_temp']
                    and p.prorettype = 'trigger'::regtype and p.pronargs = 0
                    and md5(replace(p.prosrc, chr(13), '')) = 'af2ecbb9e02c24657f620dcc6b792fd1') then
    raise exception '0152 postflight: % is not the invoker trigger function this file writes (owner postgres, search_path public, pg_temp, its body)', sig;
  end if;
  if has_function_privilege('public', sig, 'execute') or has_function_privilege('anon', sig, 'execute')
     or has_function_privilege('authenticated', sig, 'execute') or has_function_privilege('service_role', sig, 'execute') then
    raise exception '0152 postflight: % is executable by an API role', sig;
  end if;

  -- attached exactly once: enabled, no WHEN, no arguments, BEFORE, FOR EACH
  -- ROW, on INSERT and on UPDATE OF exactly (features, has_storage), never
  -- DELETE / TRUNCATE / INSTEAD OF (coalesce: a NULL anywhere is a failure)
  if (select count(*) from pg_trigger t where t.tgfoid = to_regprocedure(sig) and not t.tgisinternal) <> 1
     or not coalesce((select t.tgrelid = 'public.properties'::regclass
                             and t.tgname = 'properties_storage_from_features'
                             and t.tgenabled = 'O' and t.tgqual is null and t.tgnargs = 0
                             and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2            -- ROW, BEFORE
                             and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 16          -- INSERT, UPDATE
                             and (t.tgtype & (8 | 32 | 64)) = 0                       -- not DELETE / TRUNCATE / INSTEAD
                             and (select array_agg(a order by a) from unnest(t.tgattr::int2[]) a)
                                 = (select array_agg(c.attnum order by c.attnum) from pg_attribute c
                                     where c.attrelid = 'public.properties'::regclass
                                       and c.attname in ('features', 'has_storage') and not c.attisdropped)
                        from pg_trigger t where t.tgfoid = to_regprocedure(sig) and not t.tgisinternal), false) then
    raise exception '0152 postflight: properties_storage_from_features is not the one enabled BEFORE INSERT OR UPDATE OF features, has_storage row trigger on properties calling %', sig;
  end if;

  -- the table's user triggers are 0149's and this file's
  select string_agg(t.tgname, ', ' order by t.tgname) into v_trg
    from pg_trigger t where t.tgrelid = 'public.properties'::regclass and not t.tgisinternal;
  if v_trg is distinct from 'properties_id_without_history, properties_pk_immutable, properties_price_history, properties_reference_immutable, properties_storage_from_features, properties_updated' then
    raise exception '0152 postflight: the triggers on properties are %', coalesce(v_trg, 'none');
  end if;

  -- no row out of step — NULLs included (the backfill reached every one)
  select count(*) into v_n from public.properties p
   where p.has_storage is distinct from coalesce('storage_room' = any(p.features), false);
  if v_n <> 0 then
    raise exception '0152 postflight: % property row(s) hold a has_storage that is not their feature''s', v_n;
  end if;

  -- behaviour, on one row if the table holds any, undone: a has_storage
  -- written on its own is replaced; a features change carries it along
  select p.id into v_id from public.properties p order by p.id limit 1 for update skip locked;
  if v_id is not null then
    begin
      update public.properties
         set has_storage = not has_storage
       where id = v_id
      returning has_storage, coalesce('storage_room' = any(features), false) into v_got, v_want;
      if v_got is distinct from v_want then
        raise exception '0152 postflight: a has_storage written on its own was kept (property %)', v_id;
      end if;
      update public.properties
         set features = case when 'storage_room' = any(features) then array_remove(features, 'storage_room')
                             else array_append(features, 'storage_room') end
       where id = v_id
      returning has_storage, coalesce('storage_room' = any(features), false) into v_got, v_want;
      if v_got is distinct from v_want then
        raise exception '0152 postflight: has_storage did not follow a features change (property %)', v_id;
      end if;
      raise exception using errcode = 'P0001', message = '0152-postflight-undo';
    exception
      when raise_exception then
        if sqlerrm <> '0152-postflight-undo' then
          raise;
        end if;
    end;
  end if;

  raise notice '0152: postflight passed — has_storage is derived from the storage_room feature for every writer, and no row disagrees';
  raise notice '0152: never-set has_storage rows backfilled from their features — %', current_setting('gnk.m0152_backfilled', true);
end $$;

-- for the CLI: the last row carries the diagnostic (a guarded hosted apply
-- discards it; read the counts in the separate verification call)
select '0152' as migration,
       current_setting('gnk.m0152_backfilled', true)::int as null_rows_backfilled,
       (select count(*) from public.properties where has_storage) as with_storage_room,
       (select count(*) from public.properties) as properties_checked;
