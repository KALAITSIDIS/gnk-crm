import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { BODY_0041_MD5, FORBIDDEN_0041, REVERT_0137_SQL, SIG_0137 as SIG, readMigration0137 } from "./revert-0137";

/**
 * A share link's once-a-day `opened` line is throttled only by its own
 * organisation's system line (T-share-link-opened-own-org, migration 0137).
 *
 * THE GAP (reproduced at 0136 by this file): resolve_share_link() — every
 * public share page, anon included — writes one `opened` event per link per
 * Cyprus day, and skipped the write when ANY `opened` share_link event for the
 * link's id existed today: no organisation, no actor. Three routes: another
 * organisation's session writes such an event first; another organisation's
 * SYSTEM line is left at the id (a deleted link's history, the id re-taken —
 * 0133 lets it); a staff session of ours writes one first. Our system line was
 * not recorded that day. NOT closed (BACKLOG): a staff session calling this
 * function itself with the hash it can read.
 *
 * THE FIX PINNED HERE: both throttle blocks (availability and proposal) carry
 * `org_id = v_link.org_id and actor_id is null`; the function is otherwise
 * 0041's, and 0041's exposure guard still holds.
 *
 * Every behavioural test runs in a transaction that is always rolled back:
 * the link is made there as postgres; a session's event is written there as
 * that session (role authenticated, its JWT claims at aal2 — events_insert
 * applies), the other organisation's system line as postgres with a null
 * actor; and the page is resolved there as postgres (the function is a
 * definer; who calls it does not change what it writes).
 *
 * Requires the local Supabase stack. Run: npm run test:rls
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID(); // ours: the link
const OTHER_ORG = randomUUID(); // theirs: the suppressing event
const RUN = Date.now().toString(36);
const KINDS = ["proposal", "availability"] as const;
type Kind = (typeof KINDS)[number];

let o: Client;
let svc: SupabaseClient;
let staff: TestUser; // ours
let theirAgent: TestUser;
const userIds: string[] = [];
let n = 0;

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

async function bodyMd5() {
  const { rows } = await o.query<{ md5: string }>(`select md5(replace(prosrc, E'\\r', '')) as md5 from pg_proc where oid = '${SIG}'::regprocedure`);
  return rows[0]!.md5;
}
async function rolledBack(body: (notices: string[]) => Promise<void>) {
  const notices: string[] = [];
  const onNotice = (m: { message?: string }) => notices.push(m.message ?? "");
  o.on("notice", onNotice);
  await o.query("begin");
  await o.query("set local lock_timeout = '5s'");
  try {
    await body(notices);
  } finally {
    await o.query("rollback");
    o.off("notice", onNotice);
  }
}
/** Inside a transaction: one live link of ours, of the kind given (an availability link names one property). */
async function link(kind: Kind) {
  const token = randomBytes(24).toString("hex");
  const { rows } = await o.query<{ id: string }>(
    `insert into share_links (org_id, token_sha256, expires_at, created_by, kind)
     values ($1, $2, now() + interval '7 days', $3, $4) returning id`,
    [ORG, sha(token), staff.id, kind],
  );
  const id = rows[0]!.id;
  const prop = await o.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id",
    [ORG, `ZZSLO-${RUN}-${++n}`],
  );
  await o.query("insert into share_link_properties (share_link_id, property_id) values ($1, $2)", [id, prop.rows[0]!.id]);
  return { id, tokenSha: sha(token) };
}
/** Inside a transaction: the public page, resolved. */
async function resolve(tokenSha: string) {
  const { rows } = await o.query<{ p: Record<string, unknown> | null }>("select resolve_share_link($1) as p", [tokenSha]);
  return rows[0]!.p;
}
/** Inside a transaction: today's system `opened` lines for the link, in its own organisation. */
async function systemLinesToday(linkId: string) {
  const { rows } = await o.query<{ n: number }>(
    `select count(*)::int as n from events
      where entity_type = 'share_link' and entity_id = $1 and event_type = 'opened'
        and org_id = $2 and actor_id is null
        and (occurred_at at time zone 'Asia/Nicosia')::date = (now() at time zone 'Asia/Nicosia')::date`,
    [linkId, ORG],
  );
  return rows[0]!.n;
}
/**
 * Inside a transaction: an `opened` share_link event at the link's id with `who` as its actor in `org` — the line a
 * session could write before 0138 (since 0138 events_insert refuses a session's `opened`, so it is planted as
 * postgres: rows written before 0138 still exist, and the throttle must still ignore them).
 */
async function sessionOpened(who: TestUser, org: string, linkId: string) {
  await o.query(
    `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
     values ($1, $2, 'share_link', $3, 'opened', '{}'::jsonb)`,
    [org, who.id, linkId],
  );
}
/** Inside a transaction: another organisation's SYSTEM `opened` line at the link's id (as a deleted link of theirs leaves it). */
async function theirSystemLine(linkId: string) {
  await o.query(
    `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
     values ($1, null, 'share_link', $2, 'opened', '{}'::jsonb)`,
    [OTHER_ORG, linkId],
  );
}
const PLANTS = [
  ["their session's event", (id: string) => sessionOpened(theirAgent, OTHER_ORG, id)],
  ["their system line", (id: string) => theirSystemLine(id)],
  ["our staff session's event", (id: string) => sessionOpened(staff, ORG, id)],
] as const;

async function diagnostic() {
  await o.query(REVERT_0137_SQL);
  const res = await o.query(readMigration0137());
  const results = Array.isArray(res) ? res : [res];
  const m = /^opened_events_across_orgs=(\d+) opened_events_by_a_session=(\d+)$/.exec(results[results.length - 1]!.rows[0].existing_rows);
  expect(m, "the last row's shape").not.toBeNull();
  return { across: Number(m![1]), session: Number(m![2]) };
}
/** 0137's function statement (and grants), optionally edited — for the single-block checks. */
function fn0137(edit: (s: string) => string) {
  const sql = readMigration0137();
  const a = sql.indexOf("create or replace function resolve_share_link(");
  const endMark = "grant  execute on function resolve_share_link(text) to anon, authenticated, service_role;";
  const b = sql.indexOf(endMark, a) + endMark.length;
  const text = sql.slice(a, b);
  const edited = edit(text);
  expect(edited, "the edit really went in").not.toBe(text);
  return edited;
}
const A_PRED = "         -- 0137: only this organisation's own system line (a null actor) counts\n         and org_id      = v_link.org_id\n         and actor_id    is null\n";
const B_PRED = "       -- 0137: only this organisation's own system line (a null actor) counts\n       and org_id      = v_link.org_id\n       and actor_id    is null\n";

// ---------------------------------------------------------------------------
beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `share opened ${RUN}`, `share-opened-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `share opened other ${RUN}`, `share-opened-other-${RUN}`);
  const user = async (who: string, org: string) => {
    const email = `slo-${who}-${RUN}@test.local`;
    try {
      const u = await createTestUser(svc, email, "agent", org);
      userIds.push(u.id);
      return u;
    } catch (e) {
      const { rows } = await o.query<{ id: string }>("select id from auth.users where email = $1", [email]);
      for (const r of rows) if (!userIds.includes(r.id)) userIds.push(r.id);
      throw e;
    }
  };
  staff = await user("staff", ORG);
  theirAgent = await user("their-agent", OTHER_ORG);
});

afterAll(async () => {
  for (const id of userIds) {
    const { error } = await svc.auth.admin.deleteUser(id);
    if (error) console.warn(`afterAll: auth user ${id} not deleted: ${error.message}`);
  }
  for (const org of [ORG, OTHER_ORG]) {
    await o.query("delete from profiles where org_id = $1", [org]);
    await o.query("delete from events where org_id = $1", [org]);
    await o.query("delete from events_chain_checkpoint where org_id = $1", [org]);
    await o.query("delete from chain_checks where org_id = $1", [org]);
    await o.query("delete from deal_stages where org_id = $1", [org]);
    await o.query("delete from districts where org_id = $1", [org]);
    await o.query("delete from organizations where id = $1", [org]);
  }
  await o.end();
});

// ---------------------------------------------------------------------------
describe("1. another organisation's (or our own staff's) `opened` event no longer suppresses our system line", () => {
  for (const kind of KINDS) {
    it(`${kind}: another organisation's session wrote an \`opened\` event at our link's id today — our view is still recorded`, async () => {
      await rolledBack(async () => {
        const l = await link(kind);
        await sessionOpened(theirAgent, OTHER_ORG, l.id);
        expect(await resolve(l.tokenSha)).not.toBeNull();
        expect(await systemLinesToday(l.id)).toBe(1);
      });
    });

    it(`${kind}: another organisation's SYSTEM line at the same id (a deleted link's history; 0133 lets the id be taken) — our view is still recorded`, async () => {
      await rolledBack(async () => {
        const l = await link(kind);
        // as the function writes its own line — a null actor — but in the OTHER organisation
        await o.query(
          `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
           values ($1, null, 'share_link', $2, 'opened', '{}'::jsonb)`,
          [OTHER_ORG, l.id],
        );
        expect(await resolve(l.tokenSha)).not.toBeNull();
        expect(await systemLinesToday(l.id)).toBe(1);
      });
    });

    it(`${kind}: a staff session of ours wrote an \`opened\` event first — the system line is still recorded`, async () => {
      await rolledBack(async () => {
        const l = await link(kind);
        await sessionOpened(staff, ORG, l.id);
        expect(await resolve(l.tokenSha)).not.toBeNull();
        expect(await systemLinesToday(l.id)).toBe(1);
      });
    });
  }
});

describe("2. the throttle still holds for our own system line", () => {
  for (const kind of KINDS) {
    it(`${kind}: three views in a day write one \`opened\` line, and the view counter counts all three`, async () => {
      await rolledBack(async () => {
        const l = await link(kind);
        for (let i = 0; i < 3; i++) expect(await resolve(l.tokenSha)).not.toBeNull();
        expect(await systemLinesToday(l.id)).toBe(1);
        const v = await o.query("select view_count from share_links where id = $1", [l.id]);
        expect(v.rows[0].view_count).toBe(3);
      });
    });
  }

  it("an unknown token still resolves to nothing and writes nothing", async () => {
    await rolledBack(async () => {
      const count = async () =>
        (await o.query<{ e: number; v: number }>(
          "select (select count(*)::int from events) as e, (select coalesce(sum(view_count), 0)::int from share_links) as v",
        )).rows[0]!;
      const before = await count();
      expect(await resolve(sha(randomUUID()))).toBeNull();
      expect(await count()).toEqual(before);
    });
  });
});

describe("3. the function keeps its shape, its callers and 0041's exposure guard", () => {
  it("a definer owned by postgres, search_path public, returning jsonb", async () => {
    const { rows } = await o.query(
      `select p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig, p.prorettype::regtype::text as ret
         from pg_proc p where p.oid = '${SIG}'::regprocedure`,
    );
    expect(rows[0]).toEqual({ prosecdef: true, owner: "postgres", proconfig: ["search_path=public"], ret: "jsonb" });
  });

  it("the body is 0041's but the two predicates per throttle and their comment lines", async () => {
    const now = (await o.query<{ src: string }>(`select prosrc as src from pg_proc where oid = '${SIG}'::regprocedure`)).rows[0]!.src;
    let before = "";
    await rolledBack(async () => {
      await o.query(REVERT_0137_SQL);
      before = (await o.query<{ src: string }>(`select prosrc as src from pg_proc where oid = '${SIG}'::regprocedure`)).rows[0]!.src;
    });
    expect(now.replace(A_PRED, "").replace(B_PRED, "")).toBe(before);
    expect(now).not.toBe(before);
  });

  it("0041's exposure guard: no forbidden column name appears in the function's source", async () => {
    const src = (await o.query<{ src: string }>(`select prosrc as src from pg_proc where oid = '${SIG}'::regprocedure`)).rows[0]!.src;
    for (const w of FORBIDDEN_0041) expect(src, w).not.toContain(w);
  });

  it("anon, authenticated and the service role may call it (the deliberate exception to 0007)", async () => {
    const asAnon = await anonClient().rpc("resolve_share_link", { p_token_sha256: sha(randomUUID()) });
    expect(asAnon.error).toBeNull();
    expect(asAnon.data).toBeNull();
    const { rows } = await o.query(
      `select has_function_privilege('anon', '${SIG}', 'execute') as anon, has_function_privilege('authenticated', '${SIG}', 'execute') as auth,
              has_function_privilege('service_role', '${SIG}', 'execute') as svc`,
    );
    expect(rows[0]).toEqual({ anon: true, auth: true, svc: true });
    const pub = await o.query(`select has_function_privilege('public', '${SIG}', 'execute') as pub`);
    expect(pub.rows[0].pub, "PUBLIC may not execute it (0041)").toBe(false);
  });
});

describe("4. the migration itself (rolled back)", () => {
  it("replays over 0041's body: preflight, postflight, the diagnostic as its last row, the same body as applied", async () => {
    const applied = await bodyMd5();
    await rolledBack(async (notices) => {
      await o.query(REVERT_0137_SQL);
      expect(await bodyMd5()).toBe(BODY_0041_MD5);
      const res = await o.query(readMigration0137());
      const results = Array.isArray(res) ? res : [res];
      expect(results[results.length - 1]!.rows[0].existing_rows).toMatch(/^opened_events_across_orgs=\d+ opened_events_by_a_session=\d+$/);
      expect(notices.some((m) => m.startsWith("0137: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0137: postflight passed"))).toBe(true);
      expect(await bodyMd5()).toBe(applied);
    });
  });

  it("the diagnostic counts exactly what it names — and repairs nothing", async () => {
    await rolledBack(async () => {
      const l = await link("proposal");
      const before = await diagnostic();
      await resolve(l.tokenSha); // our own system line: counted in neither column
      await sessionOpened(theirAgent, OTHER_ORG, l.id); // another organisation's AND a session's: both columns
      await theirSystemLine(l.id); // another organisation's, no actor: the first column only
      await sessionOpened(staff, ORG, l.id); // a session's, ours: the second column only
      await o.query(
        `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
         values ($1, null, 'share_link', $2, 'viewed', '{}'::jsonb)`,
        [OTHER_ORG, l.id],
      ); // not an `opened` event: neither column
      const after = await diagnostic();
      expect(after).toEqual({ across: before.across + 2, session: before.session + 2 });
      const left = await o.query("select count(*)::int as n from events where entity_type = 'share_link' and entity_id = $1", [l.id]);
      expect(left.rows[0].n, "nothing repaired").toBe(5);
    });
  });

  for (const [what, edit] of [
    ["both throttles unbounded", (s: string) => s.replace(A_PRED, "").replace(B_PRED, "")],
    ["the availability throttle unbounded", (s: string) => s.replace(A_PRED, "")],
    ["the proposal throttle unbounded", (s: string) => s.replace(B_PRED, "")],
  ] as const) {
    it(`the postflight refuses the file's own text with ${what} — the replaced body goes with the refusal`, async () => {
      const bad = edit(readMigration0137());
      expect(bad).not.toBe(readMigration0137());
      await rolledBack(async () => {
        await o.query(REVERT_0137_SQL);
        await o.query("savepoint s");
        await expect(o.query(bad)).rejects.toThrow(/0137 postflight: the two `opened` throttles are not both bounded/);
        await o.query("rollback to savepoint s");
        expect(await bodyMd5()).toBe(BODY_0041_MD5);
      });
    });
  }

  it("the postflight's exposure guard refuses a body that names a forbidden column", async () => {
    const bad = readMigration0137().replace(
      "         -- 0137: only this organisation's own system line (a null actor) counts\n",
      "         -- 0137: only this organisation's own system line (a null actor) counts — not the internal_notes\n",
    );
    expect(bad).not.toBe(readMigration0137());
    await rolledBack(async () => {
      await o.query(REVERT_0137_SQL);
      await o.query("savepoint s");
      await expect(o.query(bad)).rejects.toThrow(/0137 postflight: resolve_share_link names the forbidden column internal_notes/);
      await o.query("rollback to savepoint s");
    });
  });

  for (const [what, drift, refusal] of [
    ["applied twice (the body is already 0137's)", "", /0137 aborted: resolve_share_link is not 0041's definer body/],
    ["a body that differs from 0041's", "__REVERT_EDITED__", /0137 aborted: resolve_share_link is not 0041's definer body/],
    ["not a definer", `alter function ${SIG} security invoker`, /0137 aborted: resolve_share_link is not 0041's definer body \(md5 missing/],
    ["anon may not call it", `revoke execute on function ${SIG} from anon`, /0137 aborted: resolve_share_link's grants are not 0041's/],
    ["PUBLIC may call it", `grant execute on function ${SIG} to public`, /0137 aborted: resolve_share_link's grants are not 0041's/],
    [
      "an overload beside it",
      "create function public.resolve_share_link(p int) returns int language sql as $f$ select 0 $f$",
      /0137 aborted: resolve_share_link is missing or overloaded/,
    ],
  ] as const) {
    it(`the preflight refuses: ${what}`, async () => {
      await rolledBack(async () => {
        if (drift === "__REVERT_EDITED__") {
          await o.query(REVERT_0137_SQL.replace("-- throttle: one `opened` event per link per Cyprus day (see header)", "-- throttle: one per day (edited by hand)"));
        } else if (drift) {
          await o.query(REVERT_0137_SQL);
          await o.query(drift);
        }
        const md5 = await bodyMd5();
        await o.query("savepoint s");
        await expect(o.query(readMigration0137())).rejects.toThrow(refusal);
        await o.query("rollback to savepoint s");
        expect(await bodyMd5(), "the body is as it was").toBe(md5);
      });
    });
  }

  it("the file refuses before it changes anything", () => {
    const sql = readMigration0137().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.lastIndexOf("0137 aborted")).toBeLessThan(firstChange);
    expect(sql.indexOf("0137 postflight")).toBeGreaterThan(firstChange);
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0137();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/0137 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  for (const kind of KINDS) {
    for (const [what, plant] of PLANTS) {
      it(`the rollback recipe restores 0041's body — and with it the suppression by ${what} (${kind})`, async () => {
        await rolledBack(async () => {
          const l = await link(kind);
          await plant(l.id);
          await o.query(REVERT_0137_SQL);
          expect(await bodyMd5()).toBe(BODY_0041_MD5);
          expect(await resolve(l.tokenSha)).not.toBeNull();
          expect(await systemLinesToday(l.id), `at 0041 ${what} suppresses our line`).toBe(0);
        });
      });
    }
  }

  it("the restore pack's 0137 row reads true now, false on 0041's body and false with either throttle unbounded", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const from = pack.indexOf("  select 'SECURITY: a share link''s `opened` throttle counts only its own organisation''s system line (0137)'");
    expect(from, "the pack carries the 0137 row").toBeGreaterThan(0);
    const to = pack.indexOf("\n  union all\n", from);
    const row = `select * from (${pack.slice(from, to)}) r(check_name, expected, actual)`;
    const now = (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
    expect(now).toMatchObject({ expected: "true", actual: "true" });
    for (const install of [
      () => REVERT_0137_SQL,
      () => fn0137((s) => s.replace(A_PRED, "")),
      () => fn0137((s) => s.replace(B_PRED, "")),
    ]) {
      await rolledBack(async () => {
        await o.query(install());
        expect((await o.query<{ actual: string }>(row)).rows[0]!.actual).toBe("false");
      });
    }
  });
});
