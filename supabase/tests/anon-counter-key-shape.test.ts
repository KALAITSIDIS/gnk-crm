import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, serviceClient } from "./helpers";
import {
  BODY_MD5_0149,
  COUNTER_TABLES_0149,
  HOSTED_SHARE_LINK_MISS_0023,
  REVERT_0149_SQL,
  readMigration0149,
} from "./revert-0149";

/**
 * 0149 (ANON-2, six-phase audit 2026-10-17): the anonymous rate counters take
 * only the application's key.
 *
 * note_share_link_miss (0023) and note_public_listing_hit (0066) are
 * anon-callable SECURITY DEFINERs. Until 0149 each stored whatever p_ip_hash
 * it was sent as a counter row's key, none of the three counter tables
 * checked a key, and every call's prune scanned its table.
 *
 *   1. anon through PostgREST: a NULL key, or any key that is not exactly 32
 *      lowercase hex characters, answers "over budget" and stores nothing; a
 *      32-hex key is counted exactly as before;
 *   2. every writer — postgres, service_role through note_public_enquiry_hit —
 *      is refused a malformed key by the tables' validated CHECKs (23514
 *      naming the constraint); a 32-hex key is accepted;
 *   3. the prune's range filter reads a window_start index;
 *   4. what 0149 leaves alone: both signatures and defaults, the return type,
 *      SECURITY DEFINER, search_path, owner, grants and comments;
 *      note_public_enquiry_hit and share_link_over_budget untouched; the
 *      tables' columns, keys, RLS and (absent) table grants;
 *   5. the migration: replay over the state before it, its shape, the
 *      one-transaction guard, malformed rows removed and counted, the
 *      preflight refusing what it was not written against (and accepting
 *      hosted's comment-less body), a bounded lock wait, replay safety,
 *      postflight mutants, the rollback, the restore pack's row.
 *
 * At 0147 this file is RED where the defect lives: section 1's malformed keys
 * were stored and answered "under budget", section 2's writes were accepted,
 * section 3 had no index, and section 5 had no 0149 to find. The controls
 * (a well-formed key counted, the grants and bodies left alone) passed.
 * Counter rows it writes use keys derived from this run and are deleted at
 * the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
/** A 32-hex key nobody else will use: the application's own shape. */
const key = (label: string) => createHash("md5").update(`0149-${RUN}-${label}`).digest("hex");

let o: Client; // postgres: observation, the migration replays, cleanup
let a: Client; // a second session holding a lock
let anon: SupabaseClient;
let svc: SupabaseClient;
const written = new Set<string>();

type PgError = Error & { code?: string; constraint?: string };
const failure = (q: Promise<unknown>) =>
  q.then(
    () => null,
    (e: PgError) => e,
  );

const FUNCTIONS = [
  { fn: "note_share_link_miss", table: "share_link_attempts", defaultLimit: 20 },
  { fn: "note_public_listing_hit", table: "public_listing_attempts", defaultLimit: 120 },
] as const;

/**
 * Wait out the last two seconds of a 15-minute counter window, so a test that
 * plants a row and then calls a counter (or calls one four times) never
 * straddles a window boundary.
 */
async function awayFromWindowEdge(): Promise<void> {
  const left = 15 * 60_000 - (Date.now() % (15 * 60_000));
  if (left < 2_000) await new Promise((r) => setTimeout(r, left + 250));
}

async function rowsFor(table: string, ipHash: string): Promise<number> {
  const { rows } = await o.query<{ c: number }>(`select count(*)::int as c from public.${table} where ip_hash = $1`, [ipHash]);
  return rows[0]!.c;
}

beforeAll(async () => {
  o = new Client({ connectionString: DB_URL });
  a = new Client({ connectionString: DB_URL });
  await o.connect();
  await a.connect();
  anon = anonClient();
  svc = serviceClient();
});

afterAll(async () => {
  for (const t of COUNTER_TABLES_0149) {
    await o.query(`delete from public.${t} where ip_hash = any($1::text[])`, [[...written]]);
  }
  await a.end();
  await o.end();
});

describe("1. anon, through PostgREST: only a 32-hex key is counted", () => {
  const malformed: Array<[string, () => string]> = [
    ["an empty key", () => ""],
    ["a word", () => "probe"],
    ["31 hex characters", () => key("short").slice(0, 31)],
    ["33 hex characters", () => key("long") + "0"],
    ["32 UPPERCASE hex characters", () => "ABCDEF0123456789ABCDEF0123456789"],
    ["32 characters with one that is not hex", () => key("g").slice(0, 31) + "g"],
    ["a two-thousand-character key", () => "f".repeat(2000)],
    ["a 32-hex key with a trailing newline", () => key("newline") + "\n"],
    ["a 32-hex key with a leading space", () => " " + key("space").slice(1)],
    ["32 full-width letters", () => "ａ".repeat(32)],
  ];

  for (const { fn, table } of FUNCTIONS) {
    describe(fn, () => {
      it.each(malformed)("%s answers over budget and stores nothing", async (_label, make) => {
        const k = make();
        const res = await anon.rpc(fn, { p_ip_hash: k, p_limit: 5 });
        expect(res.error).toBeNull();
        expect(res.data, "a key the application never sends is refused").toBe(true);
        expect(await rowsFor(table, k), "and never becomes a row").toBe(0);
      });

      it("a NULL key answers over budget, not an error", async () => {
        // ip_hash is NOT NULL, so nothing could be stored either way: before
        // 0149 the insert failed and the caller got the error (23502)
        const res = await anon.rpc(fn, { p_ip_hash: null, p_limit: 5 });
        expect(res.error).toBeNull();
        expect(res.data).toBe(true);
      });

      it("a 32-hex key is counted exactly as before: under the limit, then over it", async () => {
        const k = key(`${fn}-counted`);
        written.add(k);
        await awayFromWindowEdge();
        for (let i = 1; i <= 3; i++) {
          const res = await anon.rpc(fn, { p_ip_hash: k, p_limit: 3 });
          expect(res.error).toBeNull();
          expect(res.data, `hit ${i} of a limit of 3`).toBe(false);
        }
        expect((await anon.rpc(fn, { p_ip_hash: k, p_limit: 3 })).data, "the fourth is over").toBe(true);
        const { rows } = await o.query<{ attempts: number }>(`select attempts from public.${table} where ip_hash = $1`, [k]);
        expect(rows.map((r) => r.attempts)).toEqual([4]);
      });

      it("the default limit is unchanged", async () => {
        const { defaultLimit } = FUNCTIONS.find((f) => f.fn === fn)!;
        const k = key(`${fn}-default`);
        written.add(k);
        await awayFromWindowEdge();
        await o.query(
          `insert into public.${table} (ip_hash, window_start, attempts)
           values ($1, date_trunc('hour', now()) + (floor(extract(minute from now()) / 15) * interval '15 minutes'), $2)`,
          [k, defaultLimit - 1],
        );
        expect((await anon.rpc(fn, { p_ip_hash: k })).data, `hit ${defaultLimit} is at the limit`).toBe(false);
        expect((await anon.rpc(fn, { p_ip_hash: k })).data, `hit ${defaultLimit + 1} is over it`).toBe(true);
      });
    });
  }
});

describe("2. every writer is held to the key's shape", () => {
  it.each(COUNTER_TABLES_0149)("postgres inserting a malformed key into %s is refused by its CHECK", async (table) => {
    const e = await failure(
      o.query(`insert into public.${table} (ip_hash, window_start, attempts) values ($1, now(), 1)`, [`not-a-hash-${RUN}`]),
    );
    expect(e, "the insert must be refused").not.toBeNull();
    expect(e!.code, e!.message).toBe("23514");
    expect(e!.constraint).toBe(`${table}_ip_hash_shape`);
  });

  it.each(COUNTER_TABLES_0149)("postgres inserting a 32-hex key into %s is accepted", async (table) => {
    const k = key(`${table}-pg`);
    written.add(k);
    await o.query(`insert into public.${table} (ip_hash, window_start, attempts) values ($1, now(), 1)`, [k]);
    expect(await rowsFor(table, k)).toBe(1);
  });

  it("service_role's note_public_enquiry_hit is refused a malformed key by the CHECK — its two routes send hashIp() and fail open on an error", async () => {
    const res = await svc.rpc("note_public_enquiry_hit", { p_ip_hash: `enquiry-${RUN}`, p_limit: 5 });
    expect(res.error?.code, res.error?.message).toBe("23514");
    expect(res.error?.message).toContain("public_enquiry_attempts_ip_hash_shape");
  });

  it("service_role's note_public_enquiry_hit counts a 32-hex key as before", async () => {
    const k = key("enquiry-ok");
    written.add(k);
    await awayFromWindowEdge();
    expect((await svc.rpc("note_public_enquiry_hit", { p_ip_hash: k, p_limit: 1 })).data).toBe(false);
    expect((await svc.rpc("note_public_enquiry_hit", { p_ip_hash: k, p_limit: 1 })).data).toBe(true);
  });
});

describe("3. the prune reads an index", () => {
  it.each(COUNTER_TABLES_0149)("%s: the two-hour prune is planned on its window_start index", async (table) => {
    await o.query("begin");
    try {
      await o.query("set local enable_seqscan = off");
      const { rows } = await o.query(`explain delete from public.${table} where window_start < now() - interval '2 hours'`);
      const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan).toContain(`${table}_window_start_idx`);
    } finally {
      await o.query("rollback");
    }
  });
});

describe("4. what 0149 leaves alone", () => {
  it.each([
    ["note_share_link_miss", "p_ip_hash text, p_limit integer DEFAULT 20"],
    ["note_public_listing_hit", "p_ip_hash text, p_limit integer DEFAULT 120"],
  ])("%s keeps its signature, default, return type, owner, SECURITY DEFINER, search_path and grants", async (fn, args) => {
    const sig = `public.${fn}(text, integer)`;
    const { rows } = await o.query(
      `select pg_get_function_arguments(p.oid) as args, p.prorettype::regtype::text as ret, p.prosecdef,
              p.proconfig, pg_get_userbyid(p.proowner) as owner,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service_role,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) as public
         from pg_proc p where p.oid = to_regprocedure($1)`,
      [sig],
    );
    expect(rows[0]).toEqual({
      args,
      ret: "boolean",
      prosecdef: true,
      proconfig: ["search_path=public"],
      owner: "postgres",
      anon: true,
      authenticated: true,
      service_role: true,
      public: false,
    });
  });

  it("note_public_listing_hit keeps its comment", async () => {
    const { rows } = await o.query(`select obj_description(to_regprocedure('public.note_public_listing_hit(text, integer)'), 'pg_proc') as c`);
    expect(rows[0]!.c).toMatch(/^Records one public-API hit for an IP hash in a 15-minute window/);
  });

  it("note_public_enquiry_hit (service_role only) and share_link_over_budget (the read-only peek) are untouched", async () => {
    const { rows } = await o.query<{ proname: string; md5: string; anon: boolean; service_role: boolean }>(
      `select p.proname, md5(replace(p.prosrc, chr(13), '')) as md5,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('service_role', p.oid, 'execute') as service_role
         from pg_proc p where p.oid in (to_regprocedure('public.note_public_enquiry_hit(text, integer)'),
                                        to_regprocedure('public.share_link_over_budget(text, integer)'))
        order by p.proname`,
    );
    expect(rows).toEqual([
      { proname: "note_public_enquiry_hit", md5: "ec6290c8f0cbef59b65b1c18e4647e05", anon: false, service_role: true },
      { proname: "share_link_over_budget", md5: "29c2baf6488f9e38c4577a2e2ac544a7", anon: true, service_role: true },
    ]);
  });

  it.each(COUNTER_TABLES_0149)("%s keeps its columns, its key, RLS, and no grant to anon or authenticated", async (table) => {
    const { rows } = await o.query(
      `select (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull, ',' order by a.attnum)
                 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as cols,
              (select pg_get_constraintdef(k.oid) from pg_constraint k where k.conrelid = c.oid and k.contype = 'p') as pk,
              c.relrowsecurity as rls,
              has_table_privilege('anon', c.oid, 'select, insert, update, delete') as anon,
              has_table_privilege('authenticated', c.oid, 'select, insert, update, delete') as authenticated
         from pg_class c where c.oid = to_regclass('public.' || $1)`,
      [table],
    );
    expect(rows[0]).toEqual({
      cols: "ip_hash:text:true,window_start:timestamp with time zone:true,attempts:integer:true",
      pk: "PRIMARY KEY (ip_hash, window_start)",
      rls: true,
      anon: false,
      authenticated: false,
    });
  });
});

describe("5. the migration", () => {
  /** Run `body` in a transaction on `o` that is always ROLLED BACK; collects the NOTICEs it raises. */
  async function rolledBack(body: (notices: string[]) => Promise<void>) {
    const notices: string[] = [];
    const onNotice = (m: { message?: string }) => {
      if (m.message) notices.push(m.message);
    };
    o.on("notice", onNotice);
    await o.query("begin");
    try {
      await body(notices);
    } finally {
      await o.query("rollback");
      o.off("notice", onNotice);
    }
  }
  const lastRow = (res: unknown) => {
    const results = (Array.isArray(res) ? res : [res]) as { rows: Record<string, unknown>[] }[];
    return results[results.length - 1]!.rows[0]!;
  };
  const shapeChecks = async () =>
    (
      await o.query<{ c: number }>(
        `select count(*)::int as c from pg_constraint where conname = any($1::text[]) and convalidated`,
        [COUNTER_TABLES_0149.map((t) => `${t}_ip_hash_shape`)],
      )
    ).rows[0]!.c;
  const windowIndexes = async () =>
    (
      await o.query<{ c: number }>(`select count(*)::int as c from pg_class where relname = any($1::text[]) and relkind = 'i'`, [
        COUNTER_TABLES_0149.map((t) => `${t}_window_start_idx`),
      ])
    ).rows[0]!.c;
  const bodyMd5 = async (fn: string) =>
    (
      await o.query<{ md5: string }>(`select md5(replace(prosrc, chr(13), '')) as md5 from pg_proc where oid = to_regprocedure($1)`, [
        `public.${fn}(text, integer)`,
      ])
    ).rows[0]!.md5;

  it("replays over the state before it: preflight and postflight pass, the bodies are 0149's, three validated CHECKs and three indexes, the diagnostic as its last row", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0149_SQL);
      expect(await shapeChecks()).toBe(0);
      expect(await windowIndexes()).toBe(0);
      const row = lastRow(await o.query(readMigration0149()));
      expect(row).toEqual({
        removed_rows:
          "0149 applied — malformed counter rows removed: share_link_attempts=0 public_listing_attempts=0 public_enquiry_attempts=0",
      });
      expect(await shapeChecks()).toBe(3);
      expect(await windowIndexes()).toBe(3);
      expect(await bodyMd5("note_share_link_miss")).toBe(BODY_MD5_0149.note_share_link_miss.after);
      expect(await bodyMd5("note_public_listing_hit")).toBe(BODY_MD5_0149.note_public_listing_hit.after);
      expect(notices.some((m) => m.startsWith("0149: postflight passed"))).toBe(true);
    });
  });

  it("its shape: every abort and the lock precede the first DDL, every NOT VALID is VALIDATEd, the only data it touches is malformed keys, no begin/commit", () => {
    const code = readMigration0149().replace(/--[^\n]*/g, "");
    const firstDdl = code.search(/\bcreate or replace function\b/i);
    expect(firstDdl).toBeGreaterThan(0);
    const aborts = [...code.matchAll(/raise exception '0149 aborted/g)].map((m) => m.index!);
    expect(aborts.length).toBeGreaterThanOrEqual(6);
    for (const at of aborts) expect(at).toBeLessThan(firstDdl);
    const lock = code.indexOf("lock table public.share_link_attempts, public.public_listing_attempts, public.public_enquiry_attempts");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(code.search(/delete from public\./));
    for (const t of COUNTER_TABLES_0149) {
      const added = code.indexOf(`add constraint ${t}_ip_hash_shape check (ip_hash ~ '^[0-9a-f]{32}$') not valid;`);
      const validated = code.indexOf(`validate constraint ${t}_ip_hash_shape;`);
      expect(added, `${t}'s CHECK is added`).toBeGreaterThan(firstDdl);
      expect(validated, `${t}'s CHECK is validated after it is added`).toBeGreaterThan(added);
    }
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im);
    // outside the two bodies' own prune, the only rows it deletes are keys of the wrong shape, and it updates or truncates none
    const deletes = [...code.matchAll(/delete from ([^\n;]+)/gi)].map((m) => m[1]!.trim());
    expect(deletes).toEqual([
      "public.share_link_attempts     where ip_hash !~ '^[0-9a-f]{32}$'",
      "public.public_listing_attempts where ip_hash !~ '^[0-9a-f]{32}$'",
      "public.public_enquiry_attempts where ip_hash !~ '^[0-9a-f]{32}$'",
      "share_link_attempts where window_start < now() - interval '2 hours'",
      "public_listing_attempts where window_start < now() - interval '2 hours'",
    ]);
    expect(code).not.toMatch(/\b(update\s+public\.|truncate)\b/i);
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0149();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/^0149 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  it("removes exactly the malformed counter rows, counts them per table, and keeps every well-formed one", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0149_SQL);
      const keep = key("kept");
      const plant = (table: string, ipHash: string) =>
        o.query(`insert into public.${table} (ip_hash, window_start, attempts) values ($1, now(), 1)`, [ipHash]);
      // distinct counts per table (2 / 1 / 3), so a count that reads the wrong table cannot pass
      await plant("share_link_attempts", "junk-a");
      await plant("share_link_attempts", "x".repeat(500));
      await plant("public_listing_attempts", keep.toUpperCase());
      await plant("public_enquiry_attempts", "");
      await plant("public_enquiry_attempts", keep + "0");
      await plant("public_enquiry_attempts", "junk-c");
      for (const t of COUNTER_TABLES_0149) await plant(t, keep);
      const row = lastRow(await o.query(readMigration0149()));
      expect(row.removed_rows).toBe(
        "0149 applied — malformed counter rows removed: share_link_attempts=2 public_listing_attempts=1 public_enquiry_attempts=3",
      );
      for (const t of COUNTER_TABLES_0149) {
        const { rows } = await o.query<{ ip_hash: string }>(`select ip_hash from public.${t} where ip_hash !~ '^[0-9a-f]{32}$'`);
        expect(rows, `${t} holds no malformed key`).toEqual([]);
        expect(await rowsFor(t, keep), `${t} keeps the well-formed row`).toBe(1);
      }
    });
  });

  const refusals: Array<[string, string, RegExp]> = [
    [
      "a note_public_listing_hit body it was not written against",
      `create or replace function public.note_public_listing_hit(p_ip_hash text, p_limit int default 120)
       returns boolean language plpgsql security definer set search_path = public as $fn$
       begin return false; end $fn$;`,
      /^0149 aborted: the body of public\.note_public_listing_hit\(text, integer\) is not 0023's \/ 0066's \(md5 [0-9a-f]{32}\) — read it before replacing it; nothing was changed$/,
    ],
    [
      "a note_share_link_miss that is no longer SECURITY DEFINER",
      "alter function public.note_share_link_miss(text, integer) security invoker",
      /^0149 aborted: public\.note_share_link_miss\(text, integer\) is not the boolean SECURITY DEFINER owned by postgres with search_path=public/,
    ],
    [
      "a counter owned by someone other than postgres",
      // a throwaway role, created and dropped with the rolled-back transaction
      `create role zz_owner_0149; grant create on schema public to zz_owner_0149; grant zz_owner_0149 to postgres;
       alter function public.note_public_listing_hit(text, integer) owner to zz_owner_0149`,
      /^0149 aborted: public\.note_public_listing_hit\(text, integer\) is not the boolean SECURITY DEFINER owned by postgres/,
    ],
    [
      "a changed default limit",
      `create or replace function public.note_public_listing_hit(p_ip_hash text, p_limit int default 121)
       returns boolean language plpgsql security definer set search_path = public as $fn$
       begin return false; end $fn$;`,
      /^0149 aborted: public\.note_public_listing_hit\(text, integer\) is not the boolean SECURITY DEFINER owned by postgres with search_path=public and \(p_ip_hash text, p_limit integer DEFAULT 120\)/,
    ],
    [
      "a counter anon may no longer call",
      "revoke execute on function public.note_share_link_miss(text, integer) from anon",
      /^0149 aborted: the grants on public\.note_share_link_miss\(text, integer\) are not anon \+ authenticated \+ service_role without PUBLIC/,
    ],
    [
      "a counter PUBLIC may call",
      "grant execute on function public.note_public_listing_hit(text, integer) to public",
      /^0149 aborted: the grants on public\.note_public_listing_hit\(text, integer\) are not anon \+ authenticated \+ service_role without PUBLIC/,
    ],
    [
      "a counter table with a column it does not know",
      "alter table public.public_enquiry_attempts add column note text",
      /^0149 aborted: public\.public_enquiry_attempts is not \(ip_hash text, window_start timestamptz, attempts int\), all NOT NULL/,
    ],
    [
      "a counter table with a CHECK it does not know",
      "alter table public.share_link_attempts add constraint share_link_attempts_other check (attempts >= 0)",
      /^0149 aborted: public\.share_link_attempts already carries a CHECK this file does not know/,
    ],
    [
      "a counter table keyed differently",
      `alter table public.public_listing_attempts drop constraint public_listing_attempts_pkey,
         add primary key (window_start, ip_hash)`,
      /^0149 aborted: public\.public_listing_attempts does not have PRIMARY KEY \(ip_hash, window_start\)/,
    ],
  ];
  for (const [label, setup, refusal] of refusals) {
    it(`the preflight refuses ${label}, changing nothing`, async () => {
      await rolledBack(async () => {
        await o.query(REVERT_0149_SQL);
        await o.query(setup);
        await o.query("savepoint before_0149");
        const e = await failure(o.query(readMigration0149()));
        expect(e?.message ?? "(it applied)").toMatch(refusal);
        await o.query("rollback to savepoint before_0149");
        expect(await shapeChecks()).toBe(0);
        expect(await windowIndexes()).toBe(0);
      });
    });
  }

  it("accepts hosted's note_share_link_miss — 0023's statements without the file's comment line", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0149_SQL);
      await o.query(HOSTED_SHARE_LINK_MISS_0023);
      expect(await bodyMd5("note_share_link_miss")).toBe(BODY_MD5_0149.note_share_link_miss.beforeHosted);
      await o.query(readMigration0149());
      expect(await bodyMd5("note_share_link_miss")).toBe(BODY_MD5_0149.note_share_link_miss.after);
      expect(notices.some((m) => m.startsWith("0149: postflight passed"))).toBe(true);
    });
  });

  it("a counter write in flight makes it wait at most lock_timeout, then abort (55P03), changing nothing", async () => {
    const k = key("lock");
    written.add(k);
    await a.query("begin");
    await a.query(`insert into public.share_link_attempts (ip_hash, window_start, attempts) values ($1, now(), 1)`, [k]);
    try {
      await rolledBack(async () => {
        const t0 = Date.now();
        const e = await failure(o.query(readMigration0149()));
        const waited = Date.now() - t0;
        expect(e?.code, e?.message).toBe("55P03");
        expect(waited).toBeGreaterThanOrEqual(4_500);
        expect(waited).toBeLessThan(15_000);
      });
    } finally {
      await a.query("rollback");
    }
    expect(await shapeChecks()).toBe(3);
  });

  it("is replay-safe: run twice in one transaction, one validated copy of each CHECK and one index each", async () => {
    await rolledBack(async () => {
      await o.query(readMigration0149());
      await o.query(readMigration0149());
      const { rows } = await o.query<{ conname: string; c: number }>(
        `select conname, count(*)::int as c from pg_constraint where conname like '%\\_ip\\_hash\\_shape' and convalidated group by conname order by conname`,
      );
      expect(rows).toEqual([
        { conname: "public_enquiry_attempts_ip_hash_shape", c: 1 },
        { conname: "public_listing_attempts_ip_hash_shape", c: 1 },
        { conname: "share_link_attempts_ip_hash_shape", c: 1 },
      ]);
      expect(await windowIndexes()).toBe(3);
    });
  });

  const mutants: Array<[string, (sql: string) => string, RegExp]> = [
    [
      "a share-link body without its guard",
      (s) =>
        s.replace(
          "  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{32}$' then\n    return true;\n  end if;\n\n  insert into share_link_attempts",
          "  insert into share_link_attempts",
        ),
      /^0149 postflight: public\.note_share_link_miss\(text, integer\) has no key guard — a malformed key reached the table's CHECK$/,
    ],
    [
      "a listing body whose guard admits the key",
      (s) =>
        s.replace(
          "  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{32}$' then\n    return true;\n  end if;\n\n  insert into public_listing_attempts",
          // a replacer, not a string: "$'" in a replacement string is the text after the match
          () => "  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{32}$' then\n    return false;\n  end if;\n\n  insert into public_listing_attempts",
        ),
      /^0149 postflight: public\.note_public_listing_hit\(text, integer\) stored or admitted a malformed key \(over=f, rows=0\)$/,
    ],
    [
      "a body that behaves but is not the text this file pins",
      (s) =>
        s.replace(
          "  -- opportunistic prune so the table cannot grow forever (0023; 0149: indexed)",
          () => "  -- prune",
        ),
      /^0149 postflight: public\.note_public_listing_hit\(text, integer\) is not the definer this file wrote/,
    ],
    [
      "a looser CHECK",
      (s) =>
        s.replace(
          "add constraint public_enquiry_attempts_ip_hash_shape check (ip_hash ~ '^[0-9a-f]{32}$') not valid;",
          () => "add constraint public_enquiry_attempts_ip_hash_shape check (ip_hash ~ '^[0-9a-fA-F]{32}$') not valid;",
        ),
      /^0149 postflight: public\.public_enquiry_attempts does not carry the validated CHECK public_enquiry_attempts_ip_hash_shape/,
    ],
    [
      "a CHECK left NOT VALID",
      (s) => s.replace("alter table public.share_link_attempts     validate constraint share_link_attempts_ip_hash_shape;\n", ""),
      /^0149 postflight: public\.share_link_attempts does not carry the validated CHECK share_link_attempts_ip_hash_shape/,
    ],
    [
      "an index on the wrong column",
      (s) =>
        s.replace(
          "create index if not exists public_listing_attempts_window_start_idx on public.public_listing_attempts (window_start);",
          "create index if not exists public_listing_attempts_window_start_idx on public.public_listing_attempts (ip_hash);",
        ),
      /^0149 postflight: public\.public_listing_attempts_window_start_idx is not a valid plain btree on \(window_start\)/,
    ],
    [
      "an index that is missing",
      (s) => s.replace("create index if not exists public_enquiry_attempts_window_start_idx on public.public_enquiry_attempts (window_start);\n", ""),
      /^0149 postflight: public\.public_enquiry_attempts_window_start_idx is not a valid plain btree on \(window_start\)/,
    ],
  ];
  for (const [label, mutate, refusal] of mutants) {
    it(`the postflight refuses ${label}`, async () => {
      const sql = readMigration0149();
      const bad = mutate(sql);
      expect(bad, "the mutation installed").not.toBe(sql);
      await rolledBack(async () => {
        await o.query(REVERT_0149_SQL);
        await o.query("savepoint before_0149");
        const e = await failure(o.query(bad));
        expect(e?.message ?? "(it applied)").toMatch(refusal);
        await o.query("rollback to savepoint before_0149");
        expect(await shapeChecks()).toBe(0);
      });
    });
  }

  it("the rollback recipe leaves 0147's state: the bodies back, the CHECKs and indexes gone — and a malformed key stored again", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0149_SQL);
      expect(await bodyMd5("note_share_link_miss")).toBe(BODY_MD5_0149.note_share_link_miss.before);
      expect(await bodyMd5("note_public_listing_hit")).toBe(BODY_MD5_0149.note_public_listing_hit.before);
      expect(await shapeChecks()).toBe(0);
      expect(await windowIndexes()).toBe(0);
      const { rows } = await o.query("select public.note_public_listing_hit($1, 5) as over", [`rollback-${RUN}`]);
      expect(rows[0]!.over).toBe(false);
      expect(await rowsFor("public_listing_attempts", `rollback-${RUN}`)).toBe(1);
    });
  });

  it("the restore pack's 0149 row passes now, and reads a lost guard, CHECK, validation or index as drift", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const start = "  select 'SECURITY: the anon rate counters store only a 32-hex key";
    const from = pack.indexOf(start);
    expect(from, "the pack carries the 0149 row").toBeGreaterThan(0);
    const row = `select * from (${pack.slice(from, pack.indexOf("\n  union all\n", from))}) r(check_name, expected, actual)`;
    const now = (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
    expect(now.expected).toBe("3 3 2");
    expect(now.actual).toBe(now.expected);
    const actual = async () => (await o.query<{ actual: string }>(row)).rows[0]!.actual;
    await rolledBack(async () => {
      await o.query(REVERT_0149_SQL);
      expect(await actual()).toBe("0 0 0");
    });
    await rolledBack(async () => {
      await o.query(HOSTED_SHARE_LINK_MISS_0023);
      expect(await actual()).toBe("3 3 1");
    });
    await rolledBack(async () => {
      await o.query("alter table public.public_listing_attempts drop constraint public_listing_attempts_ip_hash_shape");
      await o.query(
        "alter table public.public_listing_attempts add constraint public_listing_attempts_ip_hash_shape check (ip_hash ~ '^[0-9a-f]{32}$') not valid",
      );
      expect(await actual()).toBe("2 3 2");
    });
    await rolledBack(async () => {
      await o.query("drop index public.share_link_attempts_window_start_idx");
      expect(await actual()).toBe("3 2 2");
    });
  });
});
