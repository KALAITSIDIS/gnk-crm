-- =============================================================================
-- 0148 — a property_media row can only name objects under its own property
-- (T-media-path-bound, 2026-10-17; audit 2026-10-17 MEDIA-1 (HIGH) and RLS-3,
-- the media half of BACKLOG "Service-role storage removals trust a
-- session-written path"; verified first on a disposable stack).
--
-- THE DEFECT. property_media's five path columns — storage_path_original,
-- path_thumb, path_card, path_full (0001) and path_jpeg (0095) — are free
-- text with no CHECK and no trigger, and two service-role readers trust them
-- as "this listing's files":
--   - deleteMediaBulk (lib/actions/media.ts) removes whatever paths the
--     deleted rows hold, AS THE SERVICE ROLE, from the media and documents
--     buckets;
--   - the property page (app/(app)/properties/[id]/page.tsx) signs a
--     non-photograph's path_card out of the private documents bucket for one
--     hour, for every viewer of the listing.
-- And sessions write them: property_media_insert (0100) admits an admin, a
-- listing manager and the listing's assigned agent, checking only the
-- organisation and the property; property_media_update (0147) lets an admin
-- or a listing manager rewrite any column. So, measured at 0147
-- (supabase/tests/media-path-bound.test.ts):
--   - a listing manager PATCHes a photo's storage_path_original to a signed
--     mandate PDF (`<org>/mandates/…`) and deletes the photo: the mandate's
--     object is removed by the service role;
--   - a listing manager or the assigned agent points a floor plan's path_card
--     at a KYC scan, and everyone who opens the listing receives a one-hour
--     URL to it;
--   - the same with another listing's prefix, or with a `..` path.
--
-- THE FIX. One CHECK, property_media_paths_own_property: every non-null path
-- column
--   - starts with `properties/<property_id>/` — the shape every writer
--     already uses (the upload action, scripts/import/media.mts,
--     scripts/media/backfill-jpeg.mts; move-floor-plans moves objects between
--     buckets, never renames them);
--   - matches '^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$' — the
--     characters the writers generate (uuids, `_card`, `.webp`, `original/`)
--     and nothing else;
--   - holds no '..'.
-- WHY THE CHARACTER RULE, and not only '..' (the audit's drop-in): the signer
-- puts the path in a URL, and a URL parser resolves `%2e%2e`, `%2E%2E`, `.%2e`
-- and `%2e.` as `..` and `\` as `/`. Measured on this file's stack (storage-js
-- 2.110.2): `properties/<id>/%2e%2e/%2e%2e/<org>/mandates/x.pdf` — which
-- passes a prefix test and a '..' test — is signed as
-- `<org>/mandates/x.pdf` and the URL serves the mandate's bytes; so does
-- `properties/<id>/..\..\<org>/…`. Refusing `%` and `\` outright closes every
-- spelling at once. (remove() sends its names in a JSON body, where no
-- parser resolves anything: a removal reaches another object only by naming
-- it, which the prefix rule refuses.)
--
-- A CHECK, not a trigger: it binds every writer — sessions, service_role,
-- postgres, definer bodies, the importer, restores (replica mode switches off
-- triggers, never CHECKs) — and it is re-evaluated when property_id changes,
-- so a row cannot be moved to another listing with its old paths. The
-- application keeps its own copy of the rule (lib/services/media-path.ts) for
-- the two readers, in the same change: deleteMediaBulk removes only paths
-- that pass it AND that no surviving row of the property still names (the
-- one case a CHECK cannot see: two rows of one listing naming one object),
-- and removes nothing when it cannot read the survivors; the page signs only
-- a path that passes it.
--
-- NOT DONE HERE (BACKLOG): the documents half of the class — documents,
-- viewing_slips and mandates name their own objects in free text too
-- (RLS-2); deletes that report success over a failed removal (MEDIA-2).
--
-- EXISTING DATA. The preflight counts the rows naming any other path and
-- ABORTS THE WHOLE FILE, before any DDL, naming the count and up to twenty
-- row ids (ids only — never a path). Nothing is rewritten or deleted here:
-- what such a row should name is the operator's question. Hosted held 0
-- property_media rows on 2026-10-17. List them read-only with
--   select m.id, m.org_id, m.property_id, m.kind, m.created_at
--     from public.property_media m
--    where exists (select 1
--                    from unnest(array[m.storage_path_original, m.path_thumb, m.path_card,
--                                      m.path_full, m.path_jpeg]) p(path)
--                   where p.path is not null
--                     and not (starts_with(p.path, 'properties/' || m.property_id::text || '/')
--                              and p.path ~ '^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$'
--                              and strpos(p.path, '..') = 0))
--    order by m.id;
-- decide each one, then apply this file again.
--
-- NOT VALID, THEN VALIDATE, in this one transaction: the constraint is added
-- NOT VALID and validated by the next statement, under the preflight's
-- ACCESS EXCLUSIVE lock, so no row can arrive between them and the pair is
-- an immediate validation. The postflight refuses a constraint left NOT VALID.
--
-- LOCKS. ADD CONSTRAINT … CHECK takes ACCESS EXCLUSIVE on property_media; the
-- preflight takes it BEFORE its count, so no write lands between the count
-- and the constraint and nothing is upgraded later. While it is held the
-- table is unreadable — the property pages, the public feed (public_listings
-- reads property_media) and the portal feed wait, for the milliseconds the
-- validation of a small table takes. lock_timeout bounds the wait (5 s). No
-- cron job writes the table. A collision costs a clean 55P03 — apply again,
-- and do NOT write the ledger row. Run twice, the file drops and re-adds the
-- same constraint (0077 / 0144's replay idiom) and changes nothing.
--
-- DEPLOY ORDER: ADDITIVE — hosted FIRST, then the application release that
-- carries the app-side copy. The deployed application writes only
-- own-prefix paths, so no request it sends is refused. No function
-- signature, return shape or grant changes — no release-compat entry;
-- lib/supabase/database.types.ts does not change (a CHECK is not part of the
-- generated types). A backup holding a row that breaks the rule (one taken
-- before this file, if any such row existed) no longer restores into a
-- database at 0148: its load is refused whole — correct the row in the dump.
--
-- ROLLBACK (DECISIONS T-media-path-bound): a FORWARD migration dropping the
-- constraint under the same bounded lock (supabase/tests/revert-0148.ts holds
-- the text), moving the verify-restore migrations pin FORWARD and removing
-- its 0148 row. No data moves either way: every row valid at 0148 is valid
-- at 0147.
--
-- Pins that move with this file: the migrations count (147 -> 148) and one
-- 0148 SECURITY row in scripts/backup/verify-restore.sql; docs/04
-- (property_media). NO EXPLICIT begin/commit — the CLI wraps the file
-- (HANDOFF §3), as does one execute_sql call; applied hosted inside the
-- md5-guarded DO (DECISIONS T-unit-type-apply-atomic). The file's LAST
-- result is a read-only summary for the CLI.
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
    raise exception '0148 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — the table is what this file was written against, and no
--    stored row names a path outside its own property
-- ---------------------------------------------------------------------------
do $$
declare
  n     int;
  v_ids text;
begin
  -- the lock the DDL below needs, at its strongest, BEFORE the count
  lock table public.property_media in access exclusive mode;

  -- 1. the five path columns are optional text, and property_id is a
  --    required uuid (the postflight's predicate, word for word)
  if (select count(*) from pg_attribute
       where attrelid = 'public.property_media'::regclass and not attisdropped
         and ((attname in ('storage_path_original', 'path_thumb', 'path_card', 'path_full', 'path_jpeg')
               and atttypid = 'text'::regtype and not attnotnull)
           or (attname = 'property_id' and atttypid = 'uuid'::regtype and attnotnull))) <> 6 then
    raise exception '0148 aborted: property_media''s path columns or property_id are not what this file was written against — nothing was changed';
  end if;

  -- 2. every stored path is under its own property (the CHECK's rule, read
  --    with unnest — a CHECK cannot hold a subquery)
  select count(*), string_agg(id::text, ', ' order by id) filter (where rn <= 20)
    into n, v_ids
    from (select m.id, row_number() over (order by m.id) as rn
            from public.property_media m
           where exists (select 1
                           from unnest(array[m.storage_path_original, m.path_thumb, m.path_card,
                                             m.path_full, m.path_jpeg]) p(path)
                          where p.path is not null
                            and not (starts_with(p.path, 'properties/' || m.property_id::text || '/')
                                     and p.path ~ '^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$'
                                     and strpos(p.path, '..') = 0))) bad;
  if n > 0 then
    raise exception '0148 aborted: % property_media row(s) name a path outside properties/<their property>/ (ids%: %) — nothing was changed. '
                    'List them with the read-only query in this file''s header, decide each one, then apply again',
                    n, case when n > 20 then ', the first 20' else '' end, v_ids;
  end if;

  raise notice '0148: preflight passed — every stored property_media path is under its own property';
end $$;

-- ---------------------------------------------------------------------------
-- 1. The CHECK — added NOT VALID and validated by the next statement, under
--    the preflight's lock
-- ---------------------------------------------------------------------------
-- Replay guard (0077's idiom): drop-if-exists before the add, so a replay
-- against an already-migrated database re-validates instead of aborting 42710.
alter table public.property_media
  drop constraint if exists property_media_paths_own_property;
alter table public.property_media
  add constraint property_media_paths_own_property check (
        (storage_path_original is null
          or (starts_with(storage_path_original, 'properties/' || property_id::text || '/')
              and storage_path_original ~ '^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$'
              and strpos(storage_path_original, '..') = 0))
    and (path_thumb is null
          or (starts_with(path_thumb, 'properties/' || property_id::text || '/')
              and path_thumb ~ '^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$'
              and strpos(path_thumb, '..') = 0))
    and (path_card is null
          or (starts_with(path_card, 'properties/' || property_id::text || '/')
              and path_card ~ '^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$'
              and strpos(path_card, '..') = 0))
    and (path_full is null
          or (starts_with(path_full, 'properties/' || property_id::text || '/')
              and path_full ~ '^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$'
              and strpos(path_full, '..') = 0))
    and (path_jpeg is null
          or (starts_with(path_jpeg, 'properties/' || property_id::text || '/')
              and path_jpeg ~ '^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$'
              and strpos(path_jpeg, '..') = 0))
  ) not valid;
alter table public.property_media
  validate constraint property_media_paths_own_property;

comment on constraint property_media_paths_own_property on public.property_media is
  'Every stored path is under properties/<property_id>/, in the characters the writers generate, '
  'with no ".." (0148). deleteMediaBulk removes these paths as the service role and the property '
  'page signs path_card from the private bucket, so a row may not aim them at another record''s '
  'object; % and \ are refused because a URL parser reads %2e%2e as .. and \ as /.';

-- ---------------------------------------------------------------------------
-- 2. Postflight — the CHECK as written and validated; what this file leaves
--    alone is still as it was
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_chk text;
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.property_media'::regclass and c.conname = 'property_media_paths_own_property'
     and c.contype = 'c' and c.convalidated;
  if v_def is distinct from
     'CHECK ((((storage_path_original IS NULL) OR (starts_with(storage_path_original, ((''properties/''::text || (property_id)::text) || ''/''::text)) AND (storage_path_original ~ ''^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$''::text) AND (strpos(storage_path_original, ''..''::text) = 0))) AND ((path_thumb IS NULL) OR (starts_with(path_thumb, ((''properties/''::text || (property_id)::text) || ''/''::text)) AND (path_thumb ~ ''^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$''::text) AND (strpos(path_thumb, ''..''::text) = 0))) AND ((path_card IS NULL) OR (starts_with(path_card, ((''properties/''::text || (property_id)::text) || ''/''::text)) AND (path_card ~ ''^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$''::text) AND (strpos(path_card, ''..''::text) = 0))) AND ((path_full IS NULL) OR (starts_with(path_full, ((''properties/''::text || (property_id)::text) || ''/''::text)) AND (path_full ~ ''^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$''::text) AND (strpos(path_full, ''..''::text) = 0))) AND ((path_jpeg IS NULL) OR (starts_with(path_jpeg, ((''properties/''::text || (property_id)::text) || ''/''::text)) AND (path_jpeg ~ ''^properties/[A-Za-z0-9._-]+/[A-Za-z0-9._/-]+$''::text) AND (strpos(path_jpeg, ''..''::text) = 0)))))' then
    raise exception '0148 postflight: property_media_paths_own_property is not the validated CHECK this file writes (%) — nothing was changed',
      coalesce(v_def, 'missing or NOT VALID');
  end if;

  -- the table's CHECKs are 0088's digest shape and this one
  select string_agg(c.conname, ', ' order by c.conname) into v_chk
    from pg_constraint c where c.conrelid = 'public.property_media'::regclass and c.contype = 'c';
  if v_chk is distinct from 'property_media_content_sha256_check, property_media_paths_own_property' then
    raise exception '0148 postflight: the CHECKs on property_media are % — nothing was changed', coalesce(v_chk, 'none');
  end if;

  -- the columns keep their type and nullability
  if (select count(*) from pg_attribute
       where attrelid = 'public.property_media'::regclass and not attisdropped
         and ((attname in ('storage_path_original', 'path_thumb', 'path_card', 'path_full', 'path_jpeg')
               and atttypid = 'text'::regtype and not attnotnull)
           or (attname = 'property_id' and atttypid = 'uuid'::regtype and attnotnull))) <> 6 then
    raise exception '0148 postflight: property_media''s path columns or property_id changed — nothing was changed';
  end if;

  raise notice '0148: postflight passed — every property_media path is bound under its own property, for every writer';
end $$;

-- diagnostic: how many rows the validation read. The CLI and a raw
-- execute_sql return it; the md5-guarded apply EXECUTEs the file inside a DO
-- block, which discards it — read the count in the separate verification call.
select '0148' as migration,
       (select count(*) from public.property_media) as property_media_checked;
