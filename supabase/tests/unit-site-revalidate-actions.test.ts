import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  ANON_KEY,
  SUPABASE_URL,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * The unit actions tell the marketing site — through the REAL actions, against
 * the REAL stack, knocking on a REAL door (T-unit-site-revalidate).
 *
 * Nothing below the action is stubbed except the Next.js request plumbing (as
 * in price-uplift-actions.test.ts): every read and write goes through
 * PostgREST, RLS and the triggers; the notifier is the real one, and its knock
 * is a real HTTP POST to a door this file runs on a local port — the site's
 * stand-in, recording the key header and the body it receives. The public
 * feed is read the way the site reads it: `public_listings` as anon, by slug.
 *
 * WHAT IT PINS (each scenario prints one `[evidence]` line):
 *   1. a published unit sold: the row moves, ONE status line is written, the
 *      door is told once with the unit's reference — and the feed no longer
 *      carries it (the page the knock rebuilds will answer 404);
 *   2. the same press again — a retry after a lost answer, the same change
 *      and operation id — is answered "replayed" (0143): it writes and
 *      records nothing, and tells the door again;
 *   3. a private unit, and a write RLS refuses, never reach the door;
 *   4. a door answering 500 never turns a committed change into an error;
 *   5. a bulk reprice and a unit-type stamp knock ONCE, naming no unit; an
 *      answer lost after the commit sends nothing, and its retry is answered
 *      "replayed" — the knock repeated, no price, history row or line written
 *      twice; the feed carries the new prices and layouts of the PUBLIC units
 *      only.
 *
 * A THROWAWAY ORGANISATION, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `site-knock-${RUN}`;
const KEY = `db-test-key-${RUN}`;

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>() };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound for this action");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("./helpers");
  return { createAdminClient: () => h.serviceClient() };
});

import { applyPriceUplift, applyUnitType, updateUnitStatus, type UnitActionState } from "@/lib/actions/units";
import { resetSiteRevalidateLatch } from "@/lib/services/site-revalidate";

// ---------------------------------------------------------------------------
// The door: a local stand-in for the site's /api/revalidate.
// ---------------------------------------------------------------------------
type Knock = { key: string | undefined; body: unknown };
const door = { knocks: [] as Knock[], mode: "ok" as "ok" | "500", server: null as Server | null, url: "" };

/** The knock is sent after the action returns (inline outside a request); wait for `n`. */
async function knocked(n: number): Promise<Knock[]> {
  const t0 = Date.now();
  while (door.knocks.length < n && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50)); // and nothing more arrives after it
  return door.knocks;
}

// ---------------------------------------------------------------------------
// Sessions: a client per call; the RPC answer can be lost after the database replied.
// ---------------------------------------------------------------------------
let dropNextRpcAnswer = false;

async function sessionClient(user: TestUser): Promise<SupabaseClient> {
  const { data } = await user.client.auth.getSession();
  const session = data.session;
  if (!session) throw new Error(`no session for ${user.email}`);
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (dropNextRpcAnswer && /\/rest\/v1\/rpc\/(record_price_list_version|apply_unit_type)/.test(url)) {
          dropNextRpcAnswer = false;
          await res.text(); // the database has answered and committed; the answer never arrives
          throw new TypeError("fetch failed (test: the answer was lost after the database replied)");
        }
        return res;
      },
    },
  });
  const { error } = await c.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  return c;
}

async function as<T>(user: TestUser, run: () => Promise<T>): Promise<T> {
  const client = await sessionClient(user);
  return ctx.als.run(client, run);
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const blank: UnitActionState = { error: null, savedAt: null };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let agent: TestUser;
const userIds: string[] = [];
let fixtureN = 0;

type Unit = { id: string; reference: string };
type Project = { id: string; reference: string; units: Record<string, Unit> };

/** A project with block-A units; `public` ones are published and available — listings of their own. */
async function newProject(units: Array<{ code: string; visibility: "public" | "private"; price: number }>): Promise<Project> {
  fixtureN += 1;
  const reference = `ZZSK${TAG}${fixtureN}`;
  const { rows } = await pg.query<{ id: string }>(
    `insert into properties (org_id, reference, kind, property_type, status, title)
     values ($1, $2, 'project', 'apartment', 'available', jsonb_build_object('en', 'ZZTEST site knock ' || $2)) returning id`,
    [ORG, reference],
  );
  const out: Record<string, Unit> = {};
  for (const u of units) {
    const ref = `${reference}-${u.code}`;
    const { rows: r } = await pg.query<{ id: string }>(
      `insert into properties (org_id, reference, kind, parent_id, property_type, status, visibility, block, unit_number,
                               asking_price, bedrooms, covered_area_sqm, title)
       values ($1, $2, 'unit', $3, 'apartment', 'available', $4::visibility_level, 'A', $5, $6, 2, 80,
               jsonb_build_object('en', 'ZZTEST unit ' || $2)) returning id`,
      [ORG, ref, rows[0]!.id, u.visibility, u.code, u.price],
    );
    out[u.code] = { id: r[0]!.id, reference: ref };
  }
  return { id: rows[0]!.id, reference, units: out };
}

/** What the SITE can read: the public feed for this organisation, as anon. */
async function feed(): Promise<Map<string, { asking_price: number | null; bedrooms: number | null; covered_area_sqm: number | null }>> {
  const { data, error } = await anonClient().rpc("public_listings", { p_org_slug: SLUG, p_limit: 100, p_offset: 0 });
  if (error) throw new Error(`public_listings: ${error.message}`);
  return new Map(
    (data as Array<{ reference: string; asking_price: number | null; bedrooms: number | null; covered_area_sqm: number | null }>).map((r) => [
      r.reference,
      { asking_price: r.asking_price, bedrooms: r.bedrooms, covered_area_sqm: r.covered_area_sqm },
    ]),
  );
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pg.query<{ n: string }>(sql, params);
  return Number(rows[0]!.n);
}
const statusLines = (id: string) =>
  count(`select count(*)::text as n from events where org_id = $1 and entity_id = $2 and event_type = 'status_changed'`, [ORG, id]);
const historyRows = (p: Project) =>
  count(`select count(*)::text as n from price_history h join properties u on u.id = h.property_id where u.parent_id = $1`, [p.id]);
const priceLines = (p: Project) =>
  count(
    `select count(*)::text as n from events e join properties u on u.id = e.entity_id
      where e.org_id = $1 and u.parent_id = $2 and e.event_type = 'price_changed'`,
    [ORG, p.id],
  );
const typeLines = (p: Project) =>
  count(
    `select count(*)::text as n from events e join properties u on u.id = e.entity_id
      where e.org_id = $1 and u.parent_id = $2 and e.event_type = 'updated' and e.payload->>'source' = 'type_applied'`,
    [ORG, p.id],
  );
const versions = (p: Project) => count(`select count(*)::text as n from price_lists where project_id = $1`, [p.id]);
const priceOf = async (u: Unit) =>
  Number((await pg.query<{ p: string }>(`select asking_price::text as p from properties where id = $1`, [u.id])).rows[0]!.p);

beforeAll(async () => {
  door.server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      door.knocks.push({ key: req.headers["x-gnk-revalidate-key"] as string | undefined, body: JSON.parse(raw || "null") });
      res.writeHead(door.mode === "ok" ? 200 : 500, { "content-type": "application/json" });
      res.end(door.mode === "ok" ? '{"ok":true}' : '{"error":"down"}');
    });
  });
  await new Promise<void>((r) => door.server!.listen(0, "127.0.0.1", () => r()));
  door.url = `http://127.0.0.1:${(door.server.address() as AddressInfo).port}/api/revalidate`;
  process.env.SITE_REVALIDATE_URL = door.url;
  process.env.SITE_REVALIDATE_KEY = KEY;
  resetSiteRevalidateLatch();

  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Site knock ${RUN}`, SLUG);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `sk-admin-${RUN}@test.local`, "admin", ORG);
  agent = await createTestUser(svc, `sk-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(admin.id, agent.id);
});

afterEach(() => {
  door.knocks = [];
  door.mode = "ok";
  dropNextRpcAnswer = false;
});

afterAll(async () => {
  delete process.env.SITE_REVALIDATE_URL;
  delete process.env.SITE_REVALIDATE_KEY;
  await new Promise<void>((r) => (door.server ? door.server.close(() => r()) : r()));
  await pg.query("delete from unit_types where org_id = $1", [ORG]);
  await pg.query("delete from tasks where org_id = $1", [ORG]);
  await pg.query("delete from price_history where org_id = $1", [ORG]);
  // children before parents: properties.parent_id is ON DELETE RESTRICT
  await pg.query("delete from properties where org_id = $1 and kind = 'unit'", [ORG]);
  await pg.query("delete from properties where org_id = $1", [ORG]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  await pg.query("delete from profiles where org_id = $1", [ORG]);
  await pg.query("delete from events where org_id = $1", [ORG]);
  await pg.query("delete from events_chain_checkpoint where org_id = $1", [ORG]);
  await pg.query("delete from chain_checks where org_id = $1", [ORG]);
  await pg.query("delete from deal_stages where org_id = $1", [ORG]);
  await pg.query("delete from districts where org_id = $1", [ORG]);
  await pg.query("delete from organizations where id = $1", [ORG]);
  await pg.end();
});

// ---------------------------------------------------------------------------
describe("updateUnitStatus — one unit", () => {
  it("1–2. a published unit sold: committed, one line, one knock naming it, gone from the feed; the same press again writes nothing and knocks again", async () => {
    const p = await newProject([
      { code: "A1", visibility: "public", price: 200000 },
      { code: "A2", visibility: "public", price: 210000 },
    ]);
    const unit = p.units.A1!;
    expect((await feed()).has(unit.reference), "published and available: on the site").toBe(true);

    // ONE change: the grid re-sends exactly this after an unconfirmed answer
    const op = randomUUID();
    const first = await as(admin, () => updateUnitStatus(unit.id, "sold", "available", op));
    const k1 = [...(await knocked(1))];
    const lines1 = await statusLines(unit.id);
    const onSite = (await feed()).has(unit.reference);

    const again = await as(admin, () => updateUnitStatus(unit.id, "sold", "available", op));
    const k2 = await knocked(2);
    const lines2 = await statusLines(unit.id);

    console.log(
      `[evidence] sold: ${JSON.stringify(first)} · status lines ${lines1} · knocks ${JSON.stringify(k1.map((k) => k.body))} · in the feed afterwards: ${onSite}\n` +
        `  again: ${JSON.stringify(again)} · status lines ${lines2} · knocks ${JSON.stringify(k2.map((k) => k.body))}`,
    );
    expect(first).toMatchObject({ error: null });
    expect(first.replayed ?? false).toBe(false);
    expect(lines1).toBe(1);
    expect(k1).toEqual([{ key: KEY, body: { reference: unit.reference } }]);
    expect(onSite, "the page the knock rebuilds now answers 404").toBe(false);
    expect((await feed()).has(p.units.A2!.reference), "the unit beside it is untouched").toBe(true);
    expect(again).toMatchObject({ error: null, replayed: true });
    expect(lines2, "the retry records nothing").toBe(1);
    expect(k2.map((k) => k.body)).toEqual([{ reference: unit.reference }, { reference: unit.reference }]);
  });

  it("3. a private unit sold, and an agent's refused write: neither reaches the door", async () => {
    const p = await newProject([
      { code: "P1", visibility: "private", price: 200000 },
      { code: "P2", visibility: "public", price: 200000 },
    ]);
    const priv = await as(admin, () => updateUnitStatus(p.units.P1!.id, "sold", "available", randomUUID()));
    const refused = await as(agent, () => updateUnitStatus(p.units.P2!.id, "sold", "available", randomUUID()));
    const k = await knocked(0);
    const { rows } = await pg.query<{ status: string }>(`select status from properties where id = $1`, [p.units.P2!.id]);
    console.log(`[evidence] private: ${JSON.stringify(priv)} · agent: ${JSON.stringify(refused)} · P2 status ${rows[0]!.status} · knocks ${k.length}`);
    expect(priv).toMatchObject({ error: null });
    expect((await feed()).has(p.units.P1!.reference)).toBe(false);
    expect(refused.error).not.toBeNull();
    expect(rows[0]!.status, "the refused write wrote nothing").toBe("available");
    expect(k).toEqual([]);
  });

  it("4. the door answers 500: the committed change is still reported saved", async () => {
    const p = await newProject([{ code: "D1", visibility: "public", price: 200000 }]);
    door.mode = "500";
    const r = await as(admin, () => updateUnitStatus(p.units.D1!.id, "reserved", "available", randomUUID()));
    const k = await knocked(1);
    const { rows } = await pg.query<{ status: string }>(`select status from properties where id = $1`, [p.units.D1!.id]);
    expect(r).toMatchObject({ error: null });
    expect(rows[0]!.status).toBe("reserved");
    expect(k).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("bulk changes — ONE knock naming no unit, repeated on a confirmed replay", () => {
  it("5a. a reprice whose answer is lost after the commit: no knock; the retry is a replay — the knock, and nothing written twice", async () => {
    const p = await newProject([
      { code: "R1", visibility: "public", price: 200000 },
      { code: "R2", visibility: "public", price: 300000 },
      { code: "R3", visibility: "private", price: 250000 },
    ]);
    const { rows } = await pg.query<{ id: string; price: string }>(
      `select id, asking_price::text as price from properties where parent_id = $1 and kind = 'unit' order by block, unit_number`,
      [p.id],
    );
    // ONE submission: the form re-sends exactly this after an unconfirmed answer
    const fields = {
      project_id: p.id,
      block: "",
      mode: "percent",
      amount: "10",
      operation_id: randomUUID(),
      expected: JSON.stringify(rows.map((r) => ({ id: r.id, price: Number(r.price) }))),
    };

    dropNextRpcAnswer = true;
    const lost = await as(admin, () => applyPriceUplift(blank, form(fields)));
    const kLost = [...(await knocked(0))];
    const afterCommit = { history: await historyRows(p), lines: await priceLines(p), versions: await versions(p) };

    const retry = await as(admin, () => applyPriceUplift(blank, form(fields)));
    const kRetry = await knocked(1);
    const afterRetry = { history: await historyRows(p), lines: await priceLines(p), versions: await versions(p) };
    const site = await feed();

    console.log(
      `[evidence] lost answer: ${JSON.stringify(lost)} · knocks ${kLost.length} · committed ${JSON.stringify(afterCommit)}\n` +
        `  retry: ${JSON.stringify(retry)} · knocks ${JSON.stringify(kRetry.map((k) => k.body))} · ${JSON.stringify(afterRetry)}\n` +
        `  feed: ${JSON.stringify([...site.entries()])}`,
    );
    expect(lost.unconfirmed).toBe(true);
    expect(kLost, "an unknown outcome is not announced").toEqual([]);
    expect(afterCommit, "the lost answer DID commit").toEqual({ history: 3, lines: 3, versions: 1 });
    expect(retry).toMatchObject({ error: null, replayed: true });
    expect(kRetry, "one knock, naming no unit").toEqual([{ key: KEY, body: { scope: "listings" } }]);
    expect(afterRetry, "nothing written twice").toEqual(afterCommit);
    expect(await priceOf(p.units.R1!)).toBe(220000);
    expect(site.get(p.units.R1!.reference)?.asking_price).toBe(220000);
    expect(site.get(p.units.R2!.reference)?.asking_price).toBe(330000);
    expect(site.has(p.units.R3!.reference), "the private unit is repriced, and never on the site").toBe(false);
  });

  it("5b. a unit-type stamp: one knock; its replay knocks again and writes nothing; the feed carries the layout", async () => {
    const p = await newProject([
      { code: "T1", visibility: "public", price: 200000 },
      { code: "T2", visibility: "private", price: 200000 },
    ]);
    const { rows: t } = await pg.query<{ id: string }>(
      `insert into unit_types (org_id, project_id, code, bedrooms, bathrooms, covered_area_sqm, veranda_sqm, price_per_sqm)
       values ($1, $2, 'B3', 3, 2, 110, 20, 3000) returning id`,
      [ORG, p.id],
    );
    const fields = { project_id: p.id, unit_type_id: t[0]!.id, block: "", operation_id: randomUUID() };
    const first = await as(admin, () => applyUnitType(blank, form(fields)));
    const k1 = [...(await knocked(1))];
    const after1 = { lines: await typeLines(p), history: await historyRows(p) };
    const again = await as(admin, () => applyUnitType(blank, form(fields)));
    const k2 = await knocked(2);
    const after2 = { lines: await typeLines(p), history: await historyRows(p) };
    const site = await feed();
    console.log(
      `[evidence] stamp: ${JSON.stringify(first)} · knocks ${JSON.stringify(k1.map((k) => k.body))} · ${JSON.stringify(after1)}\n` +
        `  replay: ${JSON.stringify(again)} · knocks ${k2.length} · ${JSON.stringify(after2)} · feed ${JSON.stringify([...site.entries()])}`,
    );
    expect(first).toMatchObject({ error: null, replayed: false });
    expect(k1).toEqual([{ key: KEY, body: { scope: "listings" } }]);
    expect(after1).toEqual({ lines: 2, history: 2 });
    expect(again).toMatchObject({ error: null, replayed: true });
    expect(k2.map((k) => k.body)).toEqual([{ scope: "listings" }, { scope: "listings" }]);
    expect(after2, "the replay writes nothing").toEqual(after1);
    expect(site.get(p.units.T1!.reference)).toEqual({ asking_price: 330000, bedrooms: 3, covered_area_sqm: 110 });
    expect(site.has(p.units.T2!.reference)).toBe(false);
  });
});
