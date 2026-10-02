import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TEST_PASSWORD, anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { HISTORY_SUBJECTS, REVERT_0133_SQL, readMigration0133 } from "./revert-0133";

/**
 * A session cannot create a record at an id that already has history
 * (T-insert-id-without-history, migration 0133).
 *
 * THE GAP (reproduced at 0d43711 / 0132 by this file): events,
 * interaction_notes and documents are keyed by (entity_type, entity_id) with
 * no foreign key, so a row a trusted path deleted leaves its history behind
 * (production held 50 such ids). `authenticated` holds INSERT on the id of
 * every history subject, so a session INSERTed a new row at such an id and the
 * app's reads — the timeline through the service role, bounded by organisation
 * only — gave it the old row's history, including events the inserting agent
 * could not read itself. A session that may DELETE (tasks) could delete a row
 * and insert a new one at its id. 0132 closed the re-key (UPDATE) route.
 *
 * THE DESIGN PINNED HERE: trg_insert_id_without_history(), a SECURITY DEFINER
 * trigger AFTER INSERT on the 11 history subjects a session may insert,
 * refuses a session's (role GUC authenticated / anon) INSERT at an id with an
 * event / note / document of the table's entity_type in the row's own
 * organisation (profiles: also an event it is the actor of) — 42501 "A record
 * cannot be created at an id that already has history (<table>.id)". AFTER,
 * so it answers only for a row RLS admitted (no oracle for an aal1 session, a
 * refused role or another organisation's org_id), and an upsert that
 * conflicts never reaches it. It lets through: the service role and postgres
 * (imports, restores), an id whose history is another organisation's, and a
 * fresh id (the lead convert's deal, the invite's profile).
 *
 * TWO KINDS OF CALLER: supabase-js clients through PostgREST (the audit's
 * shape) and `pg` sessions impersonating a user in rolled-back transactions
 * (the mechanism, the catalogue, the migration replay).
 *
 * Fixtures: two throwaway organisations, deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const RUN = Date.now().toString(36);

let o: Client;
let svc: SupabaseClient;
let admin: TestUser;
let agent: TestUser;
let lm: TestUser;
let otherAdmin: TestUser;
let aal1: SupabaseClient; // the admin, signed in again without the second factor
const userIds: string[] = [];
let n = 0;

const refusal = (table: string) => `A record cannot be created at an id that already has history (${table}.id)`;
type PgrstResult = { error: { code?: string; message?: string } | null; status: number; data?: unknown };
function expectRefused(r: PgrstResult, table: string) {
  expect(r.error?.code, JSON.stringify(r.error)).toBe("42501");
  expect(r.error?.message).toBe(refusal(table));
  expect(r.status).toBe(403);
}
function expectAccepted(r: PgrstResult) {
  expect(r.error, JSON.stringify(r.error)).toBeNull();
  expect(r.status).toBe(201);
}

// ---------------------------------------------------------------------------
// fixtures (written as postgres)
// ---------------------------------------------------------------------------
const ref = () => `ZZHI-${RUN}-${++n}`;
async function one<T = { id: string }>(sql: string, args: unknown[]): Promise<T> {
  return (await o.query(sql, args)).rows[0] as T;
}
async function property(org = ORG) {
  return (await one("insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id", [org, ref()])).id;
}
async function contact(org = ORG) {
  return (await one("insert into contacts (org_id, first_name, last_name) values ($1, 'ZZTEST', 'history') returning id", [org])).id;
}
async function stage(org = ORG) {
  return (await one("select id from deal_stages where org_id = $1 and deal_type = 'sale' and sort_order = 1", [org])).id;
}
async function deal(owner: string, org = ORG) {
  return (await one(
    "insert into deals (org_id, deal_type, stage_id, title, agent_id, created_by) values ($1, 'sale', $2, 'ZZTEST deal', $3, $3) returning id",
    [org, await stage(org), owner],
  )).id;
}
async function present(table: string, id: string) {
  return (await o.query(`select 1 from ${table} where id = $1`, [id])).rowCount === 1;
}

type Plant = { event?: boolean; note?: boolean; document?: boolean; actorOnly?: boolean };
/** History for an id that has no row: an admin-authored event, a note, a document — as a deletion leaves it. */
async function plant(entityType: string, id: string, what: Plant = { event: true }, org = ORG) {
  if (what.event) {
    await o.query(
      `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
       values ($1, $2, $3, $4, 'created', '{}'::jsonb)`,
      [org, admin.id, entityType, id],
    );
  }
  if (what.actorOnly) {
    // a line elsewhere whose ACTOR is this id (an orphaned user's history)
    await o.query(
      `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
       values ($1, $2, 'contact', $3, 'updated', '{}'::jsonb)`,
      [org, id, await contact(org)],
    );
  }
  if (what.note) {
    await o.query(
      `insert into interaction_notes (org_id, entity_type, entity_id, channel, body, body_sha256, created_by)
       values ($1, $2, $3, 'phone', 'ZZTEST orphaned note', repeat('0', 64), $4)`,
      [org, entityType, id, admin.id],
    );
  }
  if (what.document) {
    await o.query(
      `insert into documents (org_id, entity_type, entity_id, title, storage_path, uploaded_by, visibility)
       values ($1, $2, $3, 'ZZTEST orphaned doc', $4, $5, 'admin_only')`,
      [org, entityType, id, `${org}/${entityType}/${id}/zz.pdf`, admin.id],
    );
  }
}

/** A session's INSERT payload for each history subject, at id X, with the parents it needs. */
type Insert = { table: string; entityType: string; who: () => TestUser; row: (x: string) => Promise<Record<string, unknown>> };
const INSERTS: Insert[] = [
  { table: "contacts", entityType: "contact", who: () => agent, row: async (x) => ({ id: x, org_id: ORG, first_name: "ZZTEST adopter" }) },
  { table: "leads", entityType: "lead", who: () => agent, row: async (x) => ({ id: x, org_id: ORG, source: "other", message: "ZZTEST adopter" }) },
  { table: "properties", entityType: "property", who: () => lm, row: async (x) => ({ id: x, org_id: ORG, reference: ref(), property_type: "apartment" }) },
  {
    table: "deals", entityType: "deal", who: () => agent,
    row: async (x) => ({ id: x, org_id: ORG, deal_type: "sale", stage_id: await stage(), title: "ZZTEST adopter", agent_id: agent.id }),
  },
  {
    table: "viewings", entityType: "viewing", who: () => agent,
    row: async (x) => ({
      id: x, org_id: ORG, property_id: await property(), contact_id: await contact(), agent_id: agent.id,
      scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  },
  { table: "offers", entityType: "offer", who: () => agent, row: async (x) => ({ id: x, org_id: ORG, deal_id: await deal(agent.id), amount: 1000 }) },
  { table: "mandates", entityType: "mandate", who: () => admin, row: async (x) => ({ id: x, org_id: ORG, property_id: await property(), type: "exclusive" }) },
  { table: "property_keys", entityType: "key", who: () => lm, row: async (x) => ({ id: x, org_id: ORG, property_id: await property(), key_code: ref() }) },
  { table: "tasks", entityType: "task", who: () => agent, row: async (x) => ({ id: x, org_id: ORG, title: "ZZTEST adopter", assignee_id: agent.id, created_by: agent.id }) },
  {
    table: "share_links", entityType: "share_link", who: () => agent,
    row: async (x) => ({
      id: x, org_id: ORG, token_sha256: randomBytes(32).toString("hex"), created_by: agent.id,
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    }),
  },
];
/** profiles need an auth user at the id: one is created, and its history planted, per case. */
async function authUser(tag: string) {
  const email = `hi-${tag}-${RUN}-${++n}@test.local`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: randomUUID(), email_confirm: true });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  userIds.push(data.user.id);
  return { id: data.user.id, email };
}
const profileRow = (u: { id: string; email: string }) => ({ id: u.id, org_id: ORG, role: "agent", full_name: "ZZTEST adopter", email: u.email });

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
async function asSession(uid: string) {
  await o.query("set local role authenticated");
  await o.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal: "aal2" })]);
}

// ---------------------------------------------------------------------------
beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `insert history ${RUN}`, `insert-history-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `insert history other ${RUN}`, `insert-history-other-${RUN}`);
  // sequential (GoTrue enrolment); an id is recorded even if the creation fails part-way
  const user = async (who: string, role: "admin" | "agent" | "listing_manager", org: string) => {
    const email = `hi-${who}-${RUN}@test.local`;
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
  agent = await user("agent", "agent", ORG);
  lm = await user("lm", "listing_manager", ORG);
  otherAdmin = await user("other-admin", "admin", OTHER_ORG);
  aal1 = anonClient();
  const signIn = await aal1.auth.signInWithPassword({ email: admin.email, password: TEST_PASSWORD });
  if (signIn.error) throw new Error(`aal1 sign-in: ${signIn.error.message}`);
});

afterAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    for (const t of ["offers", "tasks", "viewings", "share_links", "property_keys", "mandates", "documents", "interaction_notes", "leads", "deals"]) {
      await o.query(`delete from ${t} where org_id = $1`, [org]);
    }
    await o.query("delete from contacts where org_id = $1", [org]);
    await o.query("delete from properties where org_id = $1", [org]);
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
describe("1. a session cannot create a record at an id whose history outlived its row", () => {
  for (const c of INSERTS) {
    it(`${c.table} — a session its policy admits is refused, nothing is created, the history stays nobody's`, async () => {
      const x = randomUUID();
      await plant(c.entityType, x, { event: true });
      const r = await c.who().client.from(c.table).insert(await c.row(x)).select("id");
      expectRefused(r, c.table);
      expect(await present(c.table, x), "no row at the id").toBe(false);
      const { rows } = await o.query("select count(*)::int as n from events where org_id = $1 and entity_type = $2 and entity_id = $3", [
        ORG,
        c.entityType,
        x,
      ]);
      expect(rows[0].n).toBe(1);
    });
  }

  it("profiles — an admin's invite cannot bind a profile to an auth user whose 'user' history outlived its profile", async () => {
    const u = await authUser("user-history");
    await plant("user", u.id, { event: true });
    expectRefused(await admin.client.from("profiles").insert(profileRow(u)).select("id"), "profiles");
    expect(await present("profiles", u.id)).toBe(false);
  });

  it("profiles — nor to one that is the ACTOR of orphaned lines (they would be attributed to the new user)", async () => {
    const u = await authUser("actor-history");
    await plant("user", u.id, { actorOnly: true });
    expectRefused(await admin.client.from("profiles").insert(profileRow(u)).select("id"), "profiles");
  });

  it("every source counts on its own: a note alone (lead), a document alone (property), an event alone (contact)", async () => {
    const lead = randomUUID();
    await plant("lead", lead, { note: true });
    expectRefused(await agent.client.from("leads").insert({ id: lead, org_id: ORG, source: "other" }).select("id"), "leads");

    const prop = randomUUID();
    await plant("property", prop, { document: true });
    expectRefused(
      await lm.client.from("properties").insert({ id: prop, org_id: ORG, reference: ref(), property_type: "apartment" }).select("id"),
      "properties",
    );

    const c = randomUUID();
    await plant("contact", c, { event: true });
    expectRefused(await admin.client.from("contacts").insert({ id: c, org_id: ORG, first_name: "ZZTEST" }).select("id"), "contacts");
  });

  it("the guard sees history the session cannot: an agent who reads none of the orphan's lines is still refused", async () => {
    const x = randomUUID();
    await plant("contact", x, { event: true, note: true, document: true });
    const seen = await agent.client.from("events").select("id").eq("entity_id", x);
    expect(seen.data ?? [], "events_select shows an agent only its own lines").toEqual([]);
    expectRefused(await agent.client.from("contacts").insert({ id: x, org_id: ORG, first_name: "ZZTEST" }).select("id"), "contacts");
  });

  it("an UPSERT that would insert at such an id is refused the same way", async () => {
    const x = randomUUID();
    await plant("contact", x, { event: true });
    expectRefused(
      await agent.client.from("contacts").upsert({ id: x, org_id: ORG, first_name: "ZZTEST" }, { onConflict: "id" }).select("id"),
      "contacts",
    );
  });
});

describe("2. delete-then-insert: a deleted row's id cannot be taken again", () => {
  it("a task's creator deletes it and inserts a new task at its id — refused; its 'created' and 'completed' lines stay its own", async () => {
    const created = await agent.client.from("tasks").insert({ org_id: ORG, title: "ZZTEST original task", assignee_id: agent.id, created_by: agent.id }).select("id").single();
    expect(created.error, JSON.stringify(created.error)).toBeNull();
    const t = created.data!.id as string;
    await o.query(
      `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
       values ($1, $2, 'task', $3, 'created', '{}'::jsonb), ($1, $2, 'task', $3, 'completed', '{}'::jsonb)`,
      [ORG, agent.id, t],
    );
    const del = await agent.client.from("tasks").delete().eq("id", t).select("id");
    expect(del.data, JSON.stringify(del.error)).toEqual([{ id: t }]);
    expectRefused(await agent.client.from("tasks").insert({ id: t, org_id: ORG, title: "ZZTEST impostor task", assignee_id: agent.id, created_by: agent.id }).select("id"), "tasks");
    expect(await present("tasks", t)).toBe(false);
  });
});

describe("3. what keeps working", () => {
  it("a fresh, explicitly chosen id is accepted on every table — the lead convert's deal and the invite's profile among them", async () => {
    for (const c of INSERTS) {
      const r = await c.who().client.from(c.table).insert(await c.row(randomUUID())).select("id");
      expectAccepted(r);
    }
    const u = await authUser("fresh");
    expectAccepted(await admin.client.from("profiles").insert(profileRow(u)).select("id"));
  });

  it("a default id is accepted (what the app sends everywhere else)", async () => {
    expectAccepted(await agent.client.from("contacts").insert({ org_id: ORG, first_name: "ZZTEST default" }).select("id"));
    expectAccepted(await agent.client.from("tasks").insert({ org_id: ORG, title: "ZZTEST default", assignee_id: agent.id, created_by: agent.id }).select("id"));
  });

  it("an UPSERT restating a LIVE row that has history passes — its history is its own", async () => {
    const c = await contact();
    await o.query("update contacts set assigned_agent_id = $1 where id = $2", [agent.id, c]);
    await plant("contact", c, { event: true, note: true, document: true });
    const r = await agent.client
      .from("contacts")
      .upsert({ id: c, org_id: ORG, first_name: "ZZTEST restated" }, { onConflict: "id" })
      .select("id, first_name");
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(r.data).toEqual([{ id: c, first_name: "ZZTEST restated" }]);
  });

  it("another organisation inserting at an id whose history is only ORG's: accepted, and it adopts nothing (no oracle either way)", async () => {
    const x = randomUUID();
    await plant("contact", x, { event: true, note: true, document: true });
    const r = await otherAdmin.client.from("contacts").insert({ id: x, org_id: OTHER_ORG, first_name: "ZZTEST other" }).select("id");
    expectAccepted(r);
    // the reads are bounded by organisation: OTHER_ORG sees none of ORG's lines
    const seen = await otherAdmin.client.from("events").select("id").eq("entity_id", x);
    expect(seen.data).toEqual([]);
    const docs = await otherAdmin.client.from("documents").select("id").eq("entity_id", x);
    expect(docs.data).toEqual([]);
  });

  it("…and a row naming ANOTHER organisation gets RLS's refusal, never this guard's (nothing said about that organisation's history)", async () => {
    const x = randomUUID();
    await plant("contact", x, { event: true });
    const r = await otherAdmin.client.from("contacts").insert({ id: x, org_id: ORG, first_name: "ZZTEST" }).select("id");
    expect(r.error?.code).toBe("42501");
    expect(r.error?.message).not.toBe(refusal("contacts"));
    expect(r.error?.message).toMatch(/row-level security/);
  });

  it("no oracle ahead of RLS: an aal1 session and a role the policy refuses get RLS's answer, never this guard's", async () => {
    const x = randomUUID();
    await plant("contact", x, { event: true });
    const r1 = await aal1.from("contacts").insert({ id: x, org_id: ORG, first_name: "ZZTEST" }).select("id");
    expect(r1.error?.code, JSON.stringify(r1.error)).toBe("42501");
    expect(r1.error?.message).not.toBe(refusal("contacts"));
    const d = randomUUID();
    await plant("deal", d, { event: true });
    const r2 = await lm.client
      .from("deals")
      .insert({ id: d, org_id: ORG, deal_type: "sale", stage_id: await stage(), title: "ZZTEST", agent_id: agent.id })
      .select("id");
    expect(r2.error?.code, JSON.stringify(r2.error)).toBe("42501");
    expect(r2.error?.message).not.toBe(refusal("deals"));
    expect(await present("contacts", x)).toBe(false);
    expect(await present("deals", d)).toBe(false);
  });

  it("trusted paths, deliberately: the service role and postgres may insert at such an id (imports, restores)", async () => {
    const x = randomUUID();
    await plant("contact", x, { event: true });
    expectAccepted(await svc.from("contacts").insert({ id: x, org_id: ORG, first_name: "ZZTEST import" }).select("id"));
    const y = randomUUID();
    await plant("lead", y, { event: true });
    await o.query("insert into leads (id, org_id, source) values ($1, $2, 'other')", [y, ORG]);
    expect(await present("leads", y)).toBe(true);
  });
});

describe("4. the mechanism and the catalogue", () => {
  it("the guard: a definer owned by postgres, pg_temp last, callable by no role, binding sessions by the role GUC", async () => {
    const fn = (
      await o.query(
        `select p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig,
                has_function_privilege('public', p.oid, 'execute') as pub, has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('service_role', p.oid, 'execute') as svc,
                regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') ~ 'current_setting\\(''role'', true\\)' as role_guc,
                regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') ~ 'current_user' as uses_current_user
           from pg_proc p where p.oid = to_regprocedure('public.trg_insert_id_without_history()')`,
      )
    ).rows[0];
    expect(fn).toEqual({
      prosecdef: true, owner: "postgres", proconfig: ["search_path=public, pg_temp"],
      pub: false, anon: false, auth: false, svc: false, role_guc: true, uses_current_user: false,
    });
  });

  it("exactly the 11 history subjects carry it: AFTER INSERT FOR EACH ROW, enabled, no WHEN, the entity_type as its argument", async () => {
    const { rows } = await o.query<{ t: string; arg: string; ok: boolean }>(
      `select t.tgrelid::regclass::text as t, (string_to_array(encode(t.tgargs, 'escape'), '\\000'))[1] as arg,
              (t.tgname = t.tgrelid::regclass::text || '_id_without_history' and t.tgenabled = 'O' and t.tgqual is null
               and (t.tgtype & (2 | 64)) = 0 and (t.tgtype & 1) = 1 and (t.tgtype & 4) = 4 and (t.tgtype & (8 | 16 | 32)) = 0
               and t.tgnargs = 1) as ok
         from pg_trigger t where t.tgfoid = to_regprocedure('public.trg_insert_id_without_history()') and not t.tgisinternal
        order by 1`,
    );
    expect(rows).toEqual([...HISTORY_SUBJECTS].sort((a, b) => a[0].localeCompare(b[0])).map(([t, arg]) => ({ t, arg, ok: true })));
  });

  it("it binds the session, not the statement's owner: refused as authenticated, accepted as service_role, in one transaction each", async () => {
    for (const [role, refused] of [
      ["authenticated", true],
      ["service_role", false],
    ] as const) {
      await rolledBack(async () => {
        const x = randomUUID();
        await plant("contact", x, { event: true });
        if (role === "authenticated") await asSession(admin.id);
        else await o.query("set local role service_role");
        const q = o.query("insert into contacts (id, org_id, first_name) values ($1, $2, 'ZZTEST')", [x, ORG]);
        if (refused) await expect(q).rejects.toMatchObject({ code: "42501", message: refusal("contacts") });
        else expect((await q).rowCount).toBe(1);
      });
    }
  });

  it("attached any other way it refuses to run (AFTER UPDATE, BEFORE INSERT, statement-level, no argument, two arguments)", async () => {
    for (const attach of [
      "after update on public.zz_hi_attach for each row execute function public.trg_insert_id_without_history('contact')",
      "before insert on public.zz_hi_attach for each row execute function public.trg_insert_id_without_history('contact')",
      "after insert on public.zz_hi_attach for each statement execute function public.trg_insert_id_without_history('contact')",
      "after insert on public.zz_hi_attach for each row execute function public.trg_insert_id_without_history()",
      "after insert on public.zz_hi_attach for each row execute function public.trg_insert_id_without_history('contact', 'lead')",
    ]) {
      await rolledBack(async () => {
        await o.query("create table public.zz_hi_attach (id uuid primary key, org_id uuid); insert into public.zz_hi_attach values (gen_random_uuid(), null)");
        await o.query(`create trigger zz_hi_attach_guard ${attach}`);
        const stmt = attach.startsWith("after update")
          ? "update public.zz_hi_attach set org_id = null"
          : "insert into public.zz_hi_attach values (gen_random_uuid(), null)";
        await expect(o.query(stmt), attach).rejects.toThrow(/trg_insert_id_without_history runs only as an AFTER INSERT row trigger/);
      });
    }
  });

  it("the restore pack's 0133 row passes now, and reads a missing guard and an unbound body", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const from = pack.indexOf("  select 'SECURITY: no session can create a record at an id that already has history");
    expect(from, "the pack carries the 0133 row").toBeGreaterThan(0);
    const to = pack.indexOf("\n  union all\n", from);
    const row = `select * from (${pack.slice(from, to)}) r(check_name, expected, actual)`;
    const now = (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
    expect(now.actual).toBe(now.expected);
    expect(now.expected).toBe("11 true");
    for (const drift of [
      "drop trigger tasks_id_without_history on public.tasks",
      `create or replace function public.trg_insert_id_without_history() returns trigger language plpgsql security definer
         set search_path = public, pg_temp as $f$ begin return new; end $f$`,
    ]) {
      await rolledBack(async () => {
        await o.query(drift);
        const r = (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
        expect(r.actual, drift).not.toBe(r.expected);
      });
    }
  });
});

describe("5. the migration: it replays over 0132, refuses what it was not written against, and its rollback restores 0132", () => {
  it("over the rollback's 0132 state, the file's preflight and postflight pass and its last row names the 11 subjects", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0133_SQL);
      const results = [(await o.query(readMigration0133()))].flat();
      expect(notices.some((m) => m.startsWith("0133: preflight passed")), notices.join("\n")).toBe(true);
      expect(notices.some((m) => m.startsWith("0133: postflight passed")), notices.join("\n")).toBe(true);
      const last = results[results.length - 1] as { rows: Array<{ guarded_tables: string; tables: string }> };
      expect(Number(last.rows[0]!.guarded_tables)).toBe(11);
      expect(last.rows[0]!.tables.split(", ").sort()).toEqual(HISTORY_SUBJECTS.map(([t, e]) => `${t}:${e}`).sort());
    });
  });

  it("the file refuses before it changes anything, and takes every lock before its first change", () => {
    const sql = readMigration0133().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.lastIndexOf("0133 aborted")).toBeLessThan(firstChange);
    expect(sql.search(/\block table\b/i)).toBeLessThan(firstChange);
    const lock = /lock table([\s\S]*?)in share row exclusive mode/i.exec(sql)![1]!;
    expect(lock.split(",").map((t) => t.trim().replace(/^public\./, ""))).toEqual(HISTORY_SUBJECTS.map(([t]) => t));
  });

  const refusals: Array<[string, string, RegExp]> = [
    [
      "a function of its name already there",
      "create function public.trg_insert_id_without_history() returns trigger language plpgsql as $f$ begin return new; end $f$;",
      /0133 aborted: public\.trg_insert_id_without_history\(\) already exists/,
    ],
    [
      "a trigger of its naming already there",
      "create trigger tasks_id_without_history after insert on public.tasks for each row execute function public.set_updated_at();",
      /0133 aborted: a trigger named \*_id_without_history already exists/,
    ],
    ["a missing history index", "drop index public.documents_entity_idx;", /0133 aborted: the history index documents_entity_idx is missing/],
  ];
  for (const [label, drift, refused] of refusals) {
    it(`the preflight refuses ${label}`, async () => {
      await rolledBack(async () => {
        await o.query(REVERT_0133_SQL);
        await o.query(drift);
        await expect(o.query(readMigration0133())).rejects.toThrow(refused);
      });
    });
  }

  it("the rollback recipe restores 0132's behaviour: a session may insert at an id with history again (it adopts it)", async () => {
    await rolledBack(async () => {
      await o.query(REVERT_0133_SQL);
      expect((await o.query("select to_regprocedure('public.trg_insert_id_without_history()') as f")).rows[0].f).toBeNull();
      const x = randomUUID();
      await plant("contact", x, { event: true });
      await asSession(agent.id);
      expect((await o.query("insert into contacts (id, org_id, first_name) values ($1, $2, 'ZZTEST')", [x, ORG])).rowCount).toBe(1);
    });
  });
});
