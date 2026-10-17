-- =============================================================================
-- 0149 — the anonymous rate counters take only the application's key
-- (ANON-2, six-phase audit 2026-10-17, DECISIONS T-anon-counter-key-shape).
--
-- THE DEFECT. note_share_link_miss (0023) and note_public_listing_hit (0066)
-- are SECURITY DEFINER and EXECUTE-granted to anon (pinned anon = true in
-- scripts/backup/verify-restore.sql: the share-link page and the listing feed
-- call them with the publishable key). Both stored whatever p_ip_hash the
-- caller sent as a counter row's key — any text, up to the btree row limit —
-- and none of the three counter tables (+ public_enquiry_attempts, 0084)
-- checked a key's shape. Each call also pruned rows older than two hours
-- with a DELETE filtered on window_start, while the only index is the
-- primary key (ip_hash, window_start), so every call scanned the table.
-- The application only ever sends lib/services/ip-hash.ts's hashIp(): the
-- first 32 lowercase hex characters of a salted sha256.
--
-- THE FIX.
--   1. Both anon-callable functions answer TRUE ("over budget") for a NULL key
--      or one that is not exactly 32 lowercase hex characters, BEFORE their
--      insert: nothing is stored. Signatures, defaults, return type, owner,
--      SECURITY DEFINER, search_path, comments and grants are unchanged
--      (CREATE OR REPLACE keeps the OID, so its ACL and comment).
--      note_public_enquiry_hit (service_role only since 0087) is unchanged:
--      its two callers, the enquiry door and the proposal-interest door, send
--      hashIp() (and fail open on an error).
--   2. One CHECK per counter table: ip_hash ~ '^[0-9a-f]{32}$', added NOT
--      VALID and then VALIDATEd in this same transaction, so each ends
--      validated (the postflight asserts convalidated). Every writer is bound
--      — service_role, postgres, a definer body, a restore.
--   3. An index on window_start per table, which the prune's range filter
--      uses instead of scanning.
--
-- EXISTING ROWS. A counter row whose key fails the CHECK is DELETED before the
-- VALIDATE, and counted: these are 15-minute rate counters the application
-- can never have written (a deleted row only forgets that key's count), not
-- records. Hosted held 0 such rows on 2026-10-17 (1 / 2 / 5 rows, all 32-hex,
-- read with a SELECT). The guarded single execute_sql discards the final row
-- and the notices, so the hosted preflight reads the counts itself.
--
-- LOCKS. ADD CONSTRAINT takes ACCESS EXCLUSIVE; the preflight takes it on the
-- three tables in ONE statement BEFORE anything else, so no counter write
-- lands between the delete and the VALIDATE and no lock is upgraded later.
-- While this file runs (milliseconds; the tables hold a handful of rows) the
-- share-link page, the feed and the enquiry door wait on their counter call.
-- lock_timeout bounds the wait (5 s): a collision costs a clean 55P03 —
-- apply again, and do NOT write the ledger row.
--
-- DEPLOY ORDER: ADDITIVE — hosted whenever the operator approves, before or
-- after any application release; no application change rides with it. No
-- request the deployed application sends is refused (it sends hashIp()). No
-- function signature, return shape or grant changes — no release-compat
-- entry; lib/supabase/database.types.ts does not change (regenerated and
-- diffed). A backup holding a malformed counter key (one taken before this
-- file, if any such row existed — hosted held none) no longer restores into a
-- database at 0149: its load is refused by these CHECKs (restore.mjs stops on
-- the first error) — delete those counter rows from the export.
--
-- ROLLBACK (DECISIONS T-anon-counter-key-shape): a FORWARD migration that
-- restores 0023's and 0066's bodies and drops the three CHECKs and the three
-- indexes under the same bounded lock (supabase/tests/revert-0149.ts holds
-- the text), moves the verify-restore migrations pin FORWARD and removes its
-- 0149 row. No data moves back: every row valid at 0149 is valid before it.
--
-- NUMBERING: 0148 is left for the MEDIA-1 fix (the six-phase audit's drop-in
-- names it); the ledger tolerates the gap (0141's header).
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count and one 0149 SECURITY row); the counter keys in
-- supabase/tests/rls.test.ts and backup-export-keys.test.ts (now 32-hex).
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3), as does one
-- execute_sql call; applied hosted inside the md5-guarded DO (DECISIONS
-- T-unit-type-apply-atomic), where a clean return with no rows is the success
-- signal. The file's LAST result is a read-only summary for the CLI.
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
    raise exception '0149 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — the tables and the two bodies are what this file was written
--    against; then the malformed rows go, counted
-- ---------------------------------------------------------------------------
do $$
declare
  t      record;
  f      record;
  v_md5  text;
  n_share   int;
  n_listing int;
  n_enquiry int;
begin
  -- the lock the DDL below needs, at its strongest, BEFORE anything is read
  lock table public.share_link_attempts, public.public_listing_attempts, public.public_enquiry_attempts
    in access exclusive mode;

  -- 1. each table is the 0023 shape: ip_hash text NOT NULL, window_start
  --    timestamptz NOT NULL, attempts int NOT NULL, PRIMARY KEY (ip_hash, window_start)
  for t in select unnest(array['share_link_attempts', 'public_listing_attempts', 'public_enquiry_attempts']) as name loop
    if (select count(*) from pg_attribute a
         where a.attrelid = ('public.' || t.name)::regclass and a.attnum > 0 and not a.attisdropped
           and a.attnotnull
           and ((a.attname = 'ip_hash' and a.atttypid = 'text'::regtype)
             or (a.attname = 'window_start' and a.atttypid = 'timestamptz'::regtype)
             or (a.attname = 'attempts' and a.atttypid = 'int4'::regtype))) <> 3
       or (select count(*) from pg_attribute a
            where a.attrelid = ('public.' || t.name)::regclass and a.attnum > 0 and not a.attisdropped) <> 3 then
      raise exception '0149 aborted: public.% is not (ip_hash text, window_start timestamptz, attempts int), all NOT NULL — nothing was changed', t.name;
    end if;
    if (select pg_get_constraintdef(c.oid) from pg_constraint c
         where c.conrelid = ('public.' || t.name)::regclass and c.contype = 'p') is distinct from 'PRIMARY KEY (ip_hash, window_start)' then
      raise exception '0149 aborted: public.% does not have PRIMARY KEY (ip_hash, window_start) — nothing was changed', t.name;
    end if;
    -- the names this file creates are free (a replay drops and re-adds its own; see 1 and 3)
    if exists (select 1 from pg_constraint c
                where c.conrelid = ('public.' || t.name)::regclass and c.contype = 'c'
                  and c.conname <> t.name || '_ip_hash_shape') then
      raise exception '0149 aborted: public.% already carries a CHECK this file does not know — nothing was changed', t.name;
    end if;
  end loop;

  -- 2. the two anon-callable bodies are 0023's / 0066's — or this file's own,
  --    on a replay. Digests of md5(replace(prosrc, chr(13), '')), read
  --    2026-10-17. HOSTED'S note_share_link_miss IS 0023's CODE WITHOUT ITS
  --    ONE COMMENT LINE ("-- opportunistic prune …"): the same statements, a
  --    different digest (b6364a70…); a database built from the files reads
  --    607eeade…. Both are accepted, nothing else is.
  for f in
    select * from (values
      ('public.note_share_link_miss(text, integer)',
       array['607eeadee42bd274b3d6d1723a9493be', 'b6364a709b93d4aa3ed331cc4725ba21'],
       'f64695308c34f5de8a78989858a25b87', 'p_ip_hash text, p_limit integer DEFAULT 20'),
      ('public.note_public_listing_hit(text, integer)',
       array['ec4f1019ea58c9ded3b40b36c6ac5992'],
       '0668fb401dd5522e9593a22226433340', 'p_ip_hash text, p_limit integer DEFAULT 120')
    ) as x(sig, before_md5, after_md5, args)
  loop
    select md5(replace(p.prosrc, chr(13), '')) into v_md5
      from pg_proc p
     where p.oid = to_regprocedure(f.sig) and p.prosecdef
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.prorettype = 'boolean'::regtype
       and p.proconfig = array['search_path=public']
       and pg_get_function_arguments(p.oid) = f.args;
    if v_md5 is null then
      raise exception '0149 aborted: % is not the boolean SECURITY DEFINER owned by postgres with search_path=public and (%) this file replaces — nothing was changed', f.sig, f.args;
    end if;
    if not (v_md5 = any (f.before_md5) or v_md5 = f.after_md5) then
      raise exception '0149 aborted: the body of % is not 0023''s / 0066''s (md5 %) — read it before replacing it; nothing was changed', f.sig, v_md5;
    end if;
    -- the grants this file keeps: anon, authenticated and service_role may call it; PUBLIC may not
    if not (has_function_privilege('anon', f.sig, 'execute')
            and has_function_privilege('authenticated', f.sig, 'execute')
            and has_function_privilege('service_role', f.sig, 'execute'))
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = to_regprocedure(f.sig) and a.grantee = 0) then
      raise exception '0149 aborted: the grants on % are not anon + authenticated + service_role without PUBLIC — nothing was changed', f.sig;
    end if;
  end loop;

  -- EXISTING ROWS: a key the CHECK would refuse is a counter the application
  -- never wrote — deleted, and counted (header, EXISTING ROWS)
  delete from public.share_link_attempts     where ip_hash !~ '^[0-9a-f]{32}$';
  get diagnostics n_share = row_count;
  delete from public.public_listing_attempts where ip_hash !~ '^[0-9a-f]{32}$';
  get diagnostics n_listing = row_count;
  delete from public.public_enquiry_attempts where ip_hash !~ '^[0-9a-f]{32}$';
  get diagnostics n_enquiry = row_count;
  perform set_config('gnk.m0149_removed',
    format('share_link_attempts=%s public_listing_attempts=%s public_enquiry_attempts=%s', n_share, n_listing, n_enquiry),
    true);
end $$;

-- ---------------------------------------------------------------------------
-- 1. The two anon-callable counters refuse a key that is not the application's
-- ---------------------------------------------------------------------------
create or replace function public.note_share_link_miss(p_ip_hash text, p_limit int default 20)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_window timestamptz := date_trunc('hour', now())
                        + (floor(extract(minute from now()) / 15) * interval '15 minutes');
  v_attempts int;
begin
  -- 0149 (ANON-2): the key is the application's salted 32-hex hash
  -- (lib/services/ip-hash.ts) or nothing. This function is anon-callable, so
  -- any other key is caller-written text: answered as over budget, never stored.
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{32}$' then
    return true;
  end if;

  insert into share_link_attempts (ip_hash, window_start, attempts)
  values (p_ip_hash, v_window, 1)
  on conflict (ip_hash, window_start)
  do update set attempts = share_link_attempts.attempts + 1
  returning attempts into v_attempts;

  -- opportunistic prune so the table cannot grow forever (0149: indexed)
  delete from share_link_attempts where window_start < now() - interval '2 hours';

  return v_attempts > p_limit;
end $fn$;

create or replace function public.note_public_listing_hit(p_ip_hash text, p_limit int default 120)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_window timestamptz := date_trunc('hour', now())
                        + (floor(extract(minute from now()) / 15) * interval '15 minutes');
  v_attempts int;
begin
  -- 0149 (ANON-2): the key is the application's salted 32-hex hash
  -- (lib/services/ip-hash.ts) or nothing. This function is anon-callable, so
  -- any other key is caller-written text: answered as over budget, never stored.
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{32}$' then
    return true;
  end if;

  insert into public_listing_attempts (ip_hash, window_start, attempts)
  values (p_ip_hash, v_window, 1)
  on conflict (ip_hash, window_start)
  do update set attempts = public_listing_attempts.attempts + 1
  returning attempts into v_attempts;

  -- opportunistic prune so the table cannot grow forever (0023; 0149: indexed)
  delete from public_listing_attempts where window_start < now() - interval '2 hours';

  return v_attempts > p_limit;
end $fn$;

-- ---------------------------------------------------------------------------
-- 2. One CHECK per counter table — NOT VALID, then VALIDATE, in this
--    transaction (so each ends validated; the postflight asserts it)
-- ---------------------------------------------------------------------------
-- Replay guard (0077's idiom): drop-if-exists before each add.
alter table public.share_link_attempts     drop constraint if exists share_link_attempts_ip_hash_shape;
alter table public.public_listing_attempts drop constraint if exists public_listing_attempts_ip_hash_shape;
alter table public.public_enquiry_attempts drop constraint if exists public_enquiry_attempts_ip_hash_shape;

alter table public.share_link_attempts
  add constraint share_link_attempts_ip_hash_shape check (ip_hash ~ '^[0-9a-f]{32}$') not valid;
alter table public.public_listing_attempts
  add constraint public_listing_attempts_ip_hash_shape check (ip_hash ~ '^[0-9a-f]{32}$') not valid;
alter table public.public_enquiry_attempts
  add constraint public_enquiry_attempts_ip_hash_shape check (ip_hash ~ '^[0-9a-f]{32}$') not valid;

alter table public.share_link_attempts     validate constraint share_link_attempts_ip_hash_shape;
alter table public.public_listing_attempts validate constraint public_listing_attempts_ip_hash_shape;
alter table public.public_enquiry_attempts validate constraint public_enquiry_attempts_ip_hash_shape;

comment on constraint share_link_attempts_ip_hash_shape on public.share_link_attempts is
  'A counter key is the application''s salted 32-hex IP hash (lib/services/ip-hash.ts), for every writer (0149, ANON-2).';
comment on constraint public_listing_attempts_ip_hash_shape on public.public_listing_attempts is
  'A counter key is the application''s salted 32-hex IP hash (lib/services/ip-hash.ts), for every writer (0149, ANON-2).';
comment on constraint public_enquiry_attempts_ip_hash_shape on public.public_enquiry_attempts is
  'A counter key is the application''s salted 32-hex IP hash (lib/services/ip-hash.ts), for every writer (0149, ANON-2).';

-- ---------------------------------------------------------------------------
-- 3. The prune's range filter gets an index
-- ---------------------------------------------------------------------------
create index if not exists share_link_attempts_window_start_idx     on public.share_link_attempts (window_start);
create index if not exists public_listing_attempts_window_start_idx on public.public_listing_attempts (window_start);
create index if not exists public_enquiry_attempts_window_start_idx on public.public_enquiry_attempts (window_start);

-- ---------------------------------------------------------------------------
-- 4. Postflight — the shape, then the behaviour, inside a block that undoes
--    what it writes
-- ---------------------------------------------------------------------------
do $$
declare
  t      record;
  f      record;
  v_over boolean;
  v_rows int;
  probe  constant text := md5('0149-postflight-' || clock_timestamp()::text);
begin
  for t in select unnest(array['share_link_attempts', 'public_listing_attempts', 'public_enquiry_attempts']) as name loop
    if (select count(*) from pg_constraint c
         where c.conrelid = ('public.' || t.name)::regclass and c.conname = t.name || '_ip_hash_shape'
           and c.contype = 'c' and c.convalidated
           and pg_get_constraintdef(c.oid) = 'CHECK ((ip_hash ~ ''^[0-9a-f]{32}$''::text))') <> 1 then
      raise exception '0149 postflight: public.% does not carry the validated CHECK %_ip_hash_shape', t.name, t.name;
    end if;
    if (select pg_get_indexdef(i.indexrelid) from pg_index i
         where i.indexrelid = to_regclass('public.' || t.name || '_window_start_idx') and i.indisvalid) is distinct from
       format('CREATE INDEX %s_window_start_idx ON public.%s USING btree (window_start)', t.name, t.name) then
      raise exception '0149 postflight: public.%_window_start_idx is not a valid plain btree on (window_start)', t.name;
    end if;
  end loop;

  for f in
    select * from (values
      ('public.note_share_link_miss(text, integer)',    'public.note_share_link_miss',    'f64695308c34f5de8a78989858a25b87', 'share_link_attempts'),
      ('public.note_public_listing_hit(text, integer)', 'public.note_public_listing_hit', '0668fb401dd5522e9593a22226433340', 'public_listing_attempts')
    ) as x(sig, fn, after_md5, tbl)
  loop
    -- behaviour FIRST, undone: a malformed key is over budget and stored
    -- nowhere; a 32-hex key is counted as before. A body without its guard
    -- meets the table's CHECK, which is said in words here.
    begin
      begin
        execute format('select %s($1, 5)', f.fn) into v_over using probe || 'x';
      exception
        when check_violation then
          raise exception '0149 postflight: % has no key guard — a malformed key reached the table''s CHECK', f.sig;
      end;
      execute format('select count(*) from public.%I where ip_hash = $1', f.tbl) into v_rows using probe || 'x';
      if v_over is distinct from true or v_rows <> 0 then
        raise exception '0149 postflight: % stored or admitted a malformed key (over=%, rows=%)', f.sig, v_over, v_rows;
      end if;
      execute format('select %s($1, 5)', f.fn) into v_over using probe;
      execute format('select count(*) from public.%I where ip_hash = $1', f.tbl) into v_rows using probe;
      if v_over is distinct from false or v_rows <> 1 then
        raise exception '0149 postflight: % did not count a well-formed key (over=%, rows=%)', f.sig, v_over, v_rows;
      end if;
      raise exception using errcode = 'P0001', message = '0149-postflight-undo';
    exception
      when raise_exception then
        if sqlerrm <> '0149-postflight-undo' then
          raise;
        end if;
    end;

    -- then the exact definer: its body by digest, owner, search_path, grants
    if not exists (select 1 from pg_proc p
                    where p.oid = to_regprocedure(f.sig) and p.prosecdef
                      and pg_get_userbyid(p.proowner) = 'postgres'
                      and p.proconfig = array['search_path=public']
                      and md5(replace(p.prosrc, chr(13), '')) = f.after_md5) then
      raise exception '0149 postflight: % is not the definer this file wrote (owner postgres, search_path=public, its body)', f.sig;
    end if;
    if not (has_function_privilege('anon', f.sig, 'execute')
            and has_function_privilege('authenticated', f.sig, 'execute')
            and has_function_privilege('service_role', f.sig, 'execute'))
       or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where p.oid = to_regprocedure(f.sig) and a.grantee = 0) then
      raise exception '0149 postflight: the grants on % changed', f.sig;
    end if;
  end loop;

  raise notice '0149: postflight passed — three validated key-shape CHECKs, three window_start indexes, two anon counters that store only a 32-hex key';
  raise notice '0149: malformed counter rows removed — %', current_setting('gnk.m0149_removed', true);
end $$;

-- for the CLI: the last row carries the diagnostic (a guarded hosted apply
-- discards it; its preflight reads the same counts)
select '0149 applied — malformed counter rows removed: ' || current_setting('gnk.m0149_removed', true) as removed_rows;
