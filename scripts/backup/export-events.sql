-- export-events.sql — chain-faithful export of the `events` table.
--
--   psql "$DB_URL" -At -f scripts/backup/export-events.sql -o events-backup.sql
--
-- WHY THIS EXISTS, and what it is NOT
-- ===================================
-- The C6 restore drill proved that a JSON/PostgREST export CANNOT back up
-- `events`: PostgREST hands `jsonb` to JavaScript, JavaScript numbers carry no
-- scale, so `{"to": 510000.00}` comes back as `{"to": 510000}`. The hash chain
-- is computed over `payload::text`, so that single lost zero breaks the row's
-- hash — and because the chain is sequential, EVERY event after it becomes
-- invalid too. In the rehearsal an org whose chain read `true` at source came
-- back `false` with identical row counts, which is the dangerous shape: nothing
-- in a row count tells you it happened. Production is exposed today — 1 of the
-- 62 hosted events carries a decimal payload (verified 2026-07-29).
--
-- `scripts/backup/export.mjs` goes through PostgREST and therefore has this
-- defect for `events`. This script does not: the payload never leaves Postgres
-- as a number. `payload::text` is emitted verbatim and re-parsed with `::jsonb`
-- on restore, which is precisely the fix the drill proved (re-applying the exact
-- payload text made every chain verify again).
--
-- THIS IS NOT A BACKUP ON ITS OWN. It covers ONE table. It does not cover the
-- business tables, `auth.users` (outside `public` — restore without it and
-- nobody can log in), or Storage objects (the KYC scans, signed slips and
-- property media are FILES, not rows, and no SQL export can reach them).
-- `supabase db dump --schema public,auth,storage` remains the primary backup,
-- as BACKUP_RESTORE §3 says — this is the belt to its braces for the one table
-- whose corruption is both silent and total.
--
-- RESTORING
-- =========
-- The output must be applied with the same three guards restore.mjs uses:
--   1. `set session_replication_role = replica;`  — otherwise trg_events_hash
--      RECOMPUTES prev_hash/hash on insert and the chain verifies against
--      freshly minted values instead of the originals, which proves nothing.
--   2. `overriding system value` — already emitted below; `events.id` is an
--      identity column and the chain walks in id order.
--   3. Afterwards: reset the sequence and re-enable triggers, then confirm
--      `select verify_events_chain(id) from organizations;` is true for every
--      org. If it is not, the export or the restore is wrong — do not "fix" it
--      by letting the trigger recompute.
--
-- Read-only. Safe to run against production.
--
-- `-At` in the invocation above is REQUIRED, and is why this file sets no
-- `\pset` itself: `\pset format unaligned` prints "Output format is unaligned."
-- on stdout, which lands in the dump and makes the first statement a syntax
-- error on restore. Caught by the round-trip test below, not by reading it.

select E'-- events export ' || now()::text || E'\n'
    || E'-- rows: ' || count(*)::text || E'\n'
    || E'-- apply with session_replication_role = replica (see header)\n'
  from events;

-- `hash_version` IS IN THE COLUMN LIST AND MUST STAY THERE (0061). It selects
-- which formula verify_events_chain recomputes with. Omit it and every restored
-- row takes the column default of 1, so v2 evidence would be checked against
-- the v1 formula and an intact restore would read `false` — the exact failure
-- 0061 exists to end, reintroduced through the back door.
--
-- THIS LIST IS HARDCODED, unlike restore.mjs which builds its column list from
-- the catalog at restore time. A future column added to `events` must be added
-- here BY HAND, and nothing will tell you if it is not.
select string_agg(
  format(
    'insert into events (id, org_id, occurred_at, actor_id, entity_type, entity_id, event_type, payload, prev_hash, hash, hash_version) overriding system value values (%s, %L, %L, %s, %L, %s, %L, %L::jsonb, %s, %L, %s);',
    id,
    org_id,
    occurred_at,
    coalesce(quote_literal(actor_id::text), 'null'),
    entity_type,
    coalesce(quote_literal(entity_id::text), 'null'),
    event_type,
    payload::text,                       -- exact text; never a JS number
    coalesce(quote_literal(prev_hash), 'null'),
    hash,
    hash_version
  ), E'\n' order by id)
from events;

-- identity sequence must continue past the restored ids, or the next insert
-- collides on the primary key
select E'\nselect setval(pg_get_serial_sequence(''events'',''id''), '
    || coalesce(max(id), 0)::text || E');\n'
  from events;
