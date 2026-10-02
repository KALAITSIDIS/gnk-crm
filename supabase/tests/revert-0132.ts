import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0132 to 0131's catalogue — 0132's documented ROLLBACK:
 * the 25 `<table>_pk_immutable` triggers dropped, then their function. 0132
 * replaced nothing, so nothing is restored; every drop is `if exists`, so the
 * text is a no-op on a database still at 0131 and a later migration's replay
 * test may run it unconditionally (inside a transaction: it uses `set local`).
 *
 * DROP TRIGGER takes ACCESS EXCLUSIVE, which waits for readers too, and no
 * drop order avoids every cycle (child-first cycles with a parent-then-child
 * read or writer, parent-first with a policy subquery; measured both ways by
 * the 0132 review, and in each the USER'S request was the one aborted). So the
 * text takes all 25 locks at once, NOWAIT, retrying for about 5 s: it never
 * waits while holding a lock, so it cannot deadlock with a session, and
 * sessions wait only for the milliseconds the drops take.
 *
 * Used by primary-key-immutable.test.ts to replay 0132 over 0131 (its
 * preflight and postflight) and to prove the rollback restores 0131's
 * behaviour — always inside a rolled-back transaction. Not a test file: it
 * registers no tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0132 = "0132_primary_key_immutable.sql";
export const readMigration0132 = () => readFileSync(join(MIGRATIONS, MIGRATION_0132), "utf-8").replace(/\r\n/g, "\n");

/**
 * The tables 0132 guards and each one's primary key, in key order — the
 * single list the tests read. deals is not here: 0131's
 * trg_deals_closed_guard refuses a session's change of a deal's id.
 */
export const GUARDED: ReadonlyArray<readonly [table: string, key: readonly string[]]> = [
  ["areas", ["id"]],
  ["buyer_requirements", ["id"]],
  ["contacts", ["id"]],
  ["cyprus_config", ["key"]],
  ["deal_stages", ["id"]],
  ["districts", ["id"]],
  ["documents", ["id"]],
  ["leads", ["id"]],
  ["mandates", ["id"]],
  ["offers", ["id"]],
  ["organizations", ["id"]],
  ["payment_plans", ["id"]],
  ["portal_connections", ["id"]],
  ["price_list_items", ["price_list_id", "unit_id"]],
  ["price_lists", ["id"]],
  ["profiles", ["id"]],
  ["properties", ["id"]],
  ["property_keys", ["id"]],
  ["property_media", ["id"]],
  ["reservation_installments", ["id"]],
  ["reservations", ["id"]],
  ["share_links", ["id"]],
  ["tasks", ["id"]],
  ["unit_types", ["id"]],
  ["viewings", ["id"]],
];

/** 0132's lock order (its one LOCK statement), parents first, tasks last. */
export const LOCK_ORDER_0132 = [
  "organizations", "profiles", "cyprus_config", "districts", "areas", "deal_stages", "contacts", "buyer_requirements",
  "properties", "unit_types", "property_media", "property_keys", "price_lists", "price_list_items", "payment_plans",
  "documents", "mandates", "leads", "viewings", "offers", "reservations", "reservation_installments", "share_links",
  "portal_connections", "tasks",
] as const;

export const REVERT_0132_SQL = [
  "set local lock_timeout = '5s';",
  `do $$
declare
  v_try int := 0;
begin
  loop
    begin
      lock table ${LOCK_ORDER_0132.map((t) => `public.${t}`).join(", ")} in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      v_try := v_try + 1;
      if v_try >= 100 then
        raise exception '0132 rollback: the 25 tables were never free at once (~5 s) — nothing was changed, apply it again';
      end if;
      perform pg_sleep(0.05);
    end;
  end loop;
end $$;`,
  ...[...LOCK_ORDER_0132].reverse().map((table) => `drop trigger if exists ${table}_pk_immutable on public.${table};`),
  "drop function if exists public.trg_primary_key_immutable();",
].join("\n");

/**
 * The shape a guard must have, over `pg_trigger t` and the table's primary key
 * `pg_constraint con` — the predicate 0132's postflight, this file's
 * UNGUARDED_SQL and the restore pack's 0132 row share: calls the function,
 * enabled, no WHEN, BEFORE / ROW / UPDATE only, UPDATE OF exactly the key,
 * and exactly the key's columns, in key order, as its arguments.
 */
export const GUARD_SHAPE_SQL = `
        t.tgfoid = to_regprocedure('public.trg_primary_key_immutable()')
        and not t.tgisinternal and t.tgenabled = 'O' and t.tgqual is null
        and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1 and (t.tgtype & 16) = 16 and (t.tgtype & (4 | 8 | 32)) = 0
        and coalesce((select array_agg(x order by x) from unnest(t.tgattr::int2[]) x), '{}')
            = (select array_agg(x order by x) from unnest(con.conkey) x)
        and t.tgnargs = cardinality(con.conkey)
        and (string_to_array(encode(t.tgargs, 'escape'), '\\000'))[1:t.tgnargs]
            = array(select a.attname::text from unnest(con.conkey) with ordinality k(attnum, ord)
                     join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = k.attnum order by k.ord)`;

/**
 * The invariant, as a query: every public table (not extension-owned) where
 * an API role holds UPDATE on a primary-key column and no trigger of
 * GUARD_SHAPE_SQL's shape guards it. deals is reported too — its guard is
 * 0131's, and the tests check that one by its own text. One row per table.
 */
export const UNGUARDED_SQL = `
select c.relname::text as table,
       (select string_agg(a.attname, ',' order by k.ord)
          from unnest(con.conkey) with ordinality k(attnum, ord)
          join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum) as key
  from pg_class c
  join pg_constraint con on con.conrelid = c.oid and con.contype = 'p'
 where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition
   and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_class'::regclass and d.objid = c.oid
                      and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e')
   and exists (select 1 from unnest(con.conkey) k(attnum)
                where has_column_privilege('authenticated', c.oid, k.attnum, 'UPDATE')
                   or has_column_privilege('anon', c.oid, k.attnum, 'UPDATE'))
   and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and ${GUARD_SHAPE_SQL})
 order by 1`;
