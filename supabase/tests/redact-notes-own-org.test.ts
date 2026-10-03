import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { BODY_0094_MD5, REVERT_0135_SQL, readMigration0135 } from "./revert-0135";

/**
 * The nightly enquiry sweep blanks only its own organisation's notes
 * (T-redact-notes-own-org, migration 0135).
 *
 * THE GAP (reproduced at 0134 by this file): redact_stale_enquiries() — cron,
 * nightly, as postgres — redacts stale unlinked website leads and blanks the
 * interaction notes on them, matched by `entity_id` alone (0094). Notes
 * outlive their lead, and the inserting session chooses a lead's id, so
 * another organisation's agent could insert a back-dated website lead at the
 * id of one of OUR deleted leads (0133 lets it through: the history is not
 * theirs) and the next sweep blanked OUR notes — irreversibly.
 *
 * THE FIX PINNED HERE: the notes half carries `n.org_id = done.org_id`, the
 * redacted lead's own organisation; everything else about the sweep is 0094's.
 *
 * TWO KINDS OF CALLER: supabase-js clients through PostgREST (the colliding
 * insert, the RPC grants) and a `pg` session as postgres — the cron's role —
 * running the sweep in transactions that are always rolled back (it sweeps
 * every organisation's due leads, the shared stack's residue included).
 *
 * Fixtures: two throwaway organisations, deleted at the end as postgres.
 * Requires the local Supabase stack. Run: npm run test:rls
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID(); // ours: the notes that must survive
const OTHER_ORG = randomUUID(); // theirs: the colliding lead
const RUN = Date.now().toString(36);
const REDACTED = "[erased at the contact's request]";
const SIG = "public.redact_stale_enquiries(integer)";

let o: Client;
let svc: SupabaseClient;
let admin: TestUser;
let otherAgent: TestUser;
const userIds: string[] = [];

const agoMonths = (m: number) => new Date(Date.now() - m * 30.5 * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// fixtures (written as postgres)
// ---------------------------------------------------------------------------
async function lead(org: string, extra: { source?: string; status?: string; months?: number; message?: string } = {}) {
  const { rows } = await o.query<{ id: string }>(
    `insert into leads (org_id, channel, source, status, received_at, message)
     values ($1, 'email', $2::lead_source, $3::lead_status, $4, $5) returning id`,
    [org, extra.source ?? "website", extra.status ?? "new", agoMonths(extra.months ?? 25), extra.message ?? `ZZTEST lead ${RUN}`],
  );
  return rows[0]!.id;
}
/** A note on a lead id, as the desk writes it (0094's triggers on: it brings its conversation_logged event). */
async function note(org: string, leadId: string, body: string, by: string) {
  const { rows } = await o.query<{ id: string }>(
    `insert into interaction_notes (org_id, entity_type, entity_id, channel, body, body_sha256, created_by)
     values ($1, 'lead', $2, 'phone', $3, encode(sha256(convert_to($3, 'UTF8')), 'hex'), $4) returning id`,
    [org, leadId, body, by],
  );
  return rows[0]!.id;
}
async function noteState(id: string) {
  const { rows } = await o.query<{ body: string | null; redacted: boolean }>(
    "select body, redacted_at is not null as redacted from interaction_notes where id = $1",
    [id],
  );
  return rows[0];
}
async function bodyMd5() {
  const { rows } = await o.query<{ md5: string }>(`select md5(replace(prosrc, E'\\r', '')) as md5 from pg_proc where oid = '${SIG}'::regprocedure`);
  return rows[0]!.md5;
}

/** Run `body` in a transaction on `o` that is always rolled back; collect NOTICEs. */
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
const sweep = async () => (await o.query<{ n: number }>("select redact_stale_enquiries() as n")).rows[0]!.n;

/**
 * The attack's shape: one of OUR leads, with a note, deleted by a trusted path
 * (its note stays behind); ANOTHER organisation's agent inserts — through
 * PostgREST, committed — a back-dated unlinked website lead at that id, and
 * writes a note of its own on it.
 */
async function collision() {
  const x = await lead(ORG);
  const ours = await note(ORG, x, `ZZTEST our note ${RUN}`, admin.id);
  await o.query("delete from leads where id = $1", [x]);
  const r = await otherAgent.client
    .from("leads")
    .insert({ id: x, org_id: OTHER_ORG, channel: "email", source: "website", status: "new", received_at: agoMonths(25), message: "ZZTEST their lead" })
    .select("id");
  expect(r.error, `0133 lets another organisation's id collide: ${JSON.stringify(r.error)}`).toBeNull();
  const theirs = await note(OTHER_ORG, x, `ZZTEST their note ${RUN}`, otherAgent.id);
  return { x, ours, theirs };
}

// ---------------------------------------------------------------------------
beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `redact notes ${RUN}`, `redact-notes-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `redact notes other ${RUN}`, `redact-notes-other-${RUN}`);
  // sequential (GoTrue enrolment); an id is recorded even if the creation fails part-way
  const user = async (who: string, role: "admin" | "agent", org: string) => {
    const email = `rn-${who}-${RUN}@test.local`;
    try {
      const u = await createTestUser(svc, email, role, org);
      userIds.push(u.id);
      return u;
    } catch (e) {
      const { rows } = await o.query<{ id: string }>("select id from auth.users where email = $1", [email]);
      for (const r of rows) if (!userIds.includes(r.id)) userIds.push(r.id);
      throw e;
    }
  };
  admin = await user("admin", "admin", ORG);
  otherAgent = await user("other-agent", "agent", OTHER_ORG);
});

afterAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await o.query("delete from interaction_notes where org_id = $1", [org]);
    await o.query("delete from leads where org_id = $1", [org]);
    await o.query("delete from contacts where org_id = $1", [org]);
  }
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
describe("1. another organisation's lead at our deleted lead's id does not get our notes blanked", () => {
  it("the sweep redacts their lead and blanks THEIR note — ours keeps its body", async () => {
    const { x, ours, theirs } = await collision();
    await rolledBack(async () => {
      expect(await sweep()).toBeGreaterThanOrEqual(1);
      const mine = await noteState(ours);
      expect(mine, "our note survives the sweep untouched").toEqual({ body: `ZZTEST our note ${RUN}`, redacted: false });
      expect(await noteState(theirs), "their note goes with their lead").toEqual({ body: null, redacted: true });
      const { rows } = await o.query("select org_id, message from leads where id = $1", [x]);
      expect(rows).toEqual([{ org_id: OTHER_ORG, message: REDACTED }]);
      const ev = await o.query(
        "select org_id, actor_id, payload from events where entity_type = 'lead' and entity_id = $1 and event_type = 'redacted'",
        [x],
      );
      expect(ev.rows).toEqual([{ org_id: OTHER_ORG, actor_id: null, payload: { reason: "retention", months: 24 } }]);
    });
  });

  it("a second run changes nothing more: our note still untouched, no second event", async () => {
    const { x, ours } = await collision();
    await rolledBack(async () => {
      await sweep();
      await sweep();
      expect(await noteState(ours)).toEqual({ body: `ZZTEST our note ${RUN}`, redacted: false });
      const ev = await o.query("select count(*)::int as n from events where entity_id = $1 and event_type = 'redacted'", [x]);
      expect(ev.rows[0].n).toBe(1);
    });
  });
});

describe("2. what the sweep still does in its own organisation", () => {
  it("a stale unlinked website lead: its message redacted, its own notes blanked, one shape-only event — another organisation's note at its id is not ours to blank", async () => {
    const y = await lead(ORG);
    const a = await note(ORG, y, `ZZTEST own note a ${RUN}`, admin.id);
    const b = await note(ORG, y, `ZZTEST own note b ${RUN}`, admin.id);
    const planted = await note(OTHER_ORG, y, `ZZTEST their note on our id ${RUN}`, otherAgent.id);
    await rolledBack(async () => {
      await sweep();
      expect(await noteState(a)).toEqual({ body: null, redacted: true });
      expect(await noteState(b)).toEqual({ body: null, redacted: true });
      expect(await noteState(planted), "0094 blanked it too; 0135 leaves another organisation's note alone").toEqual({
        body: `ZZTEST their note on our id ${RUN}`,
        redacted: false,
      });
      const { rows } = await o.query("select message from leads where id = $1", [y]);
      expect(rows[0].message).toBe(REDACTED);
      const ev = await o.query("select actor_id, payload from events where entity_id = $1 and event_type = 'redacted'", [y]);
      expect(ev.rows).toEqual([{ actor_id: null, payload: { reason: "retention", months: 24 } }]);
    });
  });

  it("leads the sweep does not redact keep their notes — young, linked, converted, not from the website — in a sweep that redacts a lead of ours", async () => {
    const made: string[] = [];
    let c: string | undefined;
    try {
      c = (await o.query<{ id: string }>("insert into contacts (org_id, first_name) values ($1, 'ZZTEST') returning id", [ORG])).rows[0]!.id;
      const due = await lead(ORG);
      const young = await lead(ORG, { months: 23 });
      const converted = await lead(ORG, { status: "converted" });
      const desk = await lead(ORG, { source: "phone" });
      const linked = await lead(ORG);
      made.push(due, young, converted, desk, linked);
      await o.query("update leads set contact_id = $1 where id = $2", [c, linked]);
      const blanked = await note(ORG, due, `ZZTEST due ${due}`, admin.id);
      const kept: string[] = [];
      for (const id of [young, converted, desk, linked]) kept.push(await note(ORG, id, `ZZTEST kept ${id}`, admin.id));
      await rolledBack(async () => {
        await sweep();
        expect(await noteState(blanked), "the due lead's note goes in the same sweep").toEqual({ body: null, redacted: true });
        for (const n of kept) expect((await noteState(n))?.redacted, n).toBe(false);
      });
    } finally {
      await o.query("delete from interaction_notes where entity_id = any($1)", [made]);
      await o.query("delete from leads where id = any($1)", [made]);
      if (c) await o.query("delete from contacts where id = $1", [c]);
    }
  });
});

describe("3. the function keeps its shape and its callers", () => {
  it("a definer owned by postgres, search_path public, returning int, its comment stating the rule", async () => {
    const { rows } = await o.query(
      `select p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig, p.prorettype::regtype::text as ret,
              pg_get_function_arguments(p.oid) as args, obj_description(p.oid, 'pg_proc') as comment
         from pg_proc p where p.oid = '${SIG}'::regprocedure`,
    );
    expect(rows[0]).toMatchObject({ prosecdef: true, owner: "postgres", proconfig: ["search_path=public"], ret: "integer", args: "p_months integer DEFAULT 24" });
    expect(rows[0].comment).toContain("only notes of the lead's own organisation (0135");
  });

  it("the body is 0094's but the one predicate and its comment", async () => {
    const now = (await o.query<{ src: string }>(`select prosrc as src from pg_proc where oid = '${SIG}'::regprocedure`)).rows[0]!.src;
    let before = "";
    await rolledBack(async () => {
      await o.query(REVERT_0135_SQL);
      before = (await o.query<{ src: string }>(`select prosrc as src from pg_proc where oid = '${SIG}'::regprocedure`)).rows[0]!.src;
    });
    const stripped = now
      .replace("  -- 0135: only the notes of the redacted lead's own organisation — notes\n  -- outlive their lead, and another organisation may hold a lead at its id.\n", "")
      .replace("\n       and n.org_id = done.org_id", "");
    expect(stripped).toBe(before);
    expect(now).not.toBe(before);
  });

  it("executable by the service role (the tests' caller) and postgres (cron), by no session role", async () => {
    const asService = await svc.rpc("redact_stale_enquiries", { p_months: 1200 }); // 100 years: redacts nothing
    expect(asService.error).toBeNull();
    expect(asService.data).toBe(0);
    const asAnon = await anonClient().rpc("redact_stale_enquiries", { p_months: 1200 });
    expect(asAnon.error?.code).toBe("42501");
    const asAdmin = await admin.client.rpc("redact_stale_enquiries", { p_months: 1200 });
    expect(asAdmin.error?.code).toBe("42501");
    const { rows } = await o.query(
      `select has_function_privilege('anon', '${SIG}', 'execute') as anon, has_function_privilege('authenticated', '${SIG}', 'execute') as auth,
              has_function_privilege('service_role', '${SIG}', 'execute') as svc`,
    );
    expect(rows[0]).toEqual({ anon: false, auth: false, svc: true });
  });

  it("the cron job still calls it by name, nightly at 03:10", async () => {
    const { rows } = await o.query("select schedule, command, active from cron.job where jobname = 'redact-stale-enquiries'");
    expect(rows).toEqual([{ schedule: "10 3 * * *", command: "select redact_stale_enquiries()", active: true }]);
  });
});

describe("4. the migration itself (rolled back)", () => {
  it("replays over 0094's body: preflight, postflight, the diagnostic as its last row, the same body as applied", async () => {
    const applied = await bodyMd5();
    await rolledBack(async (notices) => {
      await o.query(REVERT_0135_SQL);
      expect(await bodyMd5()).toBe(BODY_0094_MD5);
      const res = await o.query(readMigration0135());
      const results = Array.isArray(res) ? res : [res];
      const last = results[results.length - 1]!;
      expect(last.rows).toHaveLength(1);
      expect(last.rows[0].existing_rows).toMatch(/^lead_notes_under_other_orgs_lead=\d+ of_them_redacted=\d+$/);
      expect(notices.some((m) => m.startsWith("0135: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0135: postflight passed"))).toBe(true);
      expect(await bodyMd5()).toBe(applied);
    });
  });

  it("the diagnostic counts a live collision, and counts it again as redacted once 0094's sweep has blanked it", async () => {
    const { ours } = await collision();
    const diag = async () => {
      const res = await o.query(readMigration0135());
      const results = Array.isArray(res) ? res : [res];
      const m = /^lead_notes_under_other_orgs_lead=(\d+) of_them_redacted=(\d+)$/.exec(results[results.length - 1]!.rows[0].existing_rows);
      expect(m, "the last row's shape").not.toBeNull();
      return { n: Number(m![1]), r: Number(m![2]) };
    };
    // the diagnostic's own predicate, for this one note: counted, and counted as redacted
    const counted = async (redacted: boolean) =>
      (await o.query(
        `select 1 from interaction_notes n join leads l on l.id = n.entity_id
          where n.entity_type = 'lead' and l.org_id <> n.org_id and n.id = $1
            and (n.redacted_at is not null) = $2`,
        [ours, redacted],
      )).rowCount;
    await rolledBack(async () => {
      await o.query(REVERT_0135_SQL);
      const first = await diag();
      expect(await counted(false), "our colliding note is among the counted rows, not redacted").toBe(1);
      expect(await noteState(ours), "the diagnostic repairs and writes nothing").toEqual({ body: `ZZTEST our note ${RUN}`, redacted: false });
      // at 0094 the sweep blanks it — the shape the diagnostic reports as redacted.
      // (It also blanks the earlier tests' committed collisions: hence "more", not "+1".)
      await o.query(REVERT_0135_SQL);
      await sweep();
      expect((await noteState(ours))?.redacted).toBe(true);
      await o.query(REVERT_0135_SQL);
      const second = await diag();
      expect(second.n, "the same collisions").toBe(first.n);
      expect(await counted(true), "our note is now counted as redacted").toBe(1);
      expect(second.r, "more of them redacted").toBeGreaterThan(first.r);
    });
  });

  it("the postflight refuses the file's own text if the notes predicate is missing — changing nothing", async () => {
    const bad = readMigration0135().replace("\n       and n.org_id = done.org_id", "");
    expect(bad, "the edit really went in").not.toBe(readMigration0135());
    await rolledBack(async () => {
      await o.query(REVERT_0135_SQL);
      await o.query("savepoint s");
      await expect(o.query(bad)).rejects.toThrow(/0135 postflight: the notes half does not bound the notes by the redacted lead's organisation/);
      await o.query("rollback to savepoint s");
      expect(await bodyMd5(), "the replaced body went with the refusal").toBe(BODY_0094_MD5);
    });
  });

  it("the file refuses before it changes anything", () => {
    const sql = readMigration0135().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.lastIndexOf("0135 aborted")).toBeLessThan(firstChange);
    expect(sql.indexOf("0135 postflight")).toBeGreaterThan(firstChange);
  });

  it("outside one transaction it refuses before anything else (SET LOCAL did not take: the one-transaction guard)", async () => {
    // only the file's opening statements, on a fresh connection with no BEGIN:
    // each query is then its own transaction, as a tool that splits a file
    // into statements would run it — never the whole file this way
    const sql = readMigration0135();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/0135 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  for (const [what, drift, refusal] of [
    ["applied twice (the body is already 0135's)", "", /0135 aborted: redact_stale_enquiries is not 0094's definer body/],
    ["a body that differs from 0094's", "__REVERT_EDITED__", /0135 aborted: redact_stale_enquiries is not 0094's definer body/],
    ["not a definer", `alter function ${SIG} security invoker`, /0135 aborted: redact_stale_enquiries is not 0094's definer body \(md5 missing/],
    ["a session role may execute it", `grant execute on function ${SIG} to authenticated`, /0135 aborted: a session role may execute redact_stale_enquiries/],
    ["the service role may not execute it", `revoke execute on function ${SIG} from service_role`, /0135 aborted: the service role may not execute redact_stale_enquiries/],
    [
      "an overload beside it (the cron calls it by name)",
      "create function public.redact_stale_enquiries(p text) returns int language sql as $f$ select 0 $f$",
      /0135 aborted: redact_stale_enquiries is overloaded/,
    ],
  ] as const) {
    it(`the preflight refuses, changing nothing: ${what}`, async () => {
      await rolledBack(async () => {
        if (drift === "__REVERT_EDITED__") {
          await o.query(REVERT_0135_SQL.replace("for update skip locked", "for update skip locked -- edited by hand"));
        } else if (drift) {
          await o.query(REVERT_0135_SQL);
          await o.query(drift);
        }
        const md5 = await bodyMd5();
        await o.query("savepoint s");
        await expect(o.query(readMigration0135())).rejects.toThrow(refusal);
        await o.query("rollback to savepoint s");
        expect(await bodyMd5(), "nothing was changed").toBe(md5);
      });
    });
  }

  it("the rollback recipe restores 0094's body — and with it the cross-organisation blanking", async () => {
    const { ours } = await collision();
    await rolledBack(async () => {
      await o.query(REVERT_0135_SQL);
      expect(await bodyMd5()).toBe(BODY_0094_MD5);
      await sweep();
      expect(await noteState(ours), "at 0094 the sweep blanks the other organisation's note").toEqual({ body: null, redacted: true });
    });
  });

  it("the restore pack's 0135 row reads true now and false on 0094's body", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const from = pack.indexOf("  select 'SECURITY: the enquiry sweep blanks only the redacted lead''s own organisation''s notes (0135)'");
    expect(from, "the pack carries the 0135 row").toBeGreaterThan(0);
    const to = pack.indexOf("\n  union all\n", from);
    const row = `select * from (${pack.slice(from, to)}) r(check_name, expected, actual)`;
    const now = (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
    expect(now).toMatchObject({ expected: "true", actual: "true" });
    await rolledBack(async () => {
      await o.query(REVERT_0135_SQL);
      expect((await o.query<{ actual: string }>(row)).rows[0]!.actual).toBe("false");
    });
  });
});
