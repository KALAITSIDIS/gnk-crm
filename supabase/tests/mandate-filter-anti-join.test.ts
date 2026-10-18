import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  ANON_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * The properties "No mandate" and "Expired" filters hold whatever the
 * organisation's mandate count — on the list page, the map and the CSV export —
 * through the REAL page components and export route, against a REAL PostgREST,
 * with real aal2 sessions (T-mandate-filter-anti-join).
 *
 * At 2327337 both filters read every blocking mandate's property id first
 * (`fetchMandateExcludeIds`: "none" excludes an active OR expired mandate,
 * "expired" excludes an active one) and wrote the ids into the properties
 * request as `id=not.in.(…)` — about 39 bytes each. The local Kong refuses a
 * request line past 8 KB: measured 2026-10-12 on the list page's request, 197
 * ids passed and 198 answered 414. Past about 200 mandated properties the list
 * page and the map fell to the error boundary and the export refused
 * ("failed"). Hosted's limit is not measured.
 *
 * WHAT IT PINS (each case prints one `[evidence]` line):
 *   1. with 420 active and 40 expired-only mandated listings, an admin's and a
 *      listing manager's "No mandate" and "Expired" show exactly the listings the
 *      filter means — on the page (header total and rows, page 2 included), the
 *      map and the CSV — and the export is audited once;
 *   2. an agent's filters mean what `mandates_safe` lets the agent see (their
 *      own and their assigned listings' mandates) — a listing whose expired
 *      mandate the agent sees and whose active one they do not is "expired"
 *      to them — as before;
 *   3. every row's badge and CSV Mandate cell say the filter: the display
 *      embed shares the select with the aliases and must not be narrowed;
 *   4. the request does not grow with the mandates: no separate mandate read,
 *      no id list (list, map and export), and the same URL for an organisation
 *      with 463 mandated listings as for one with a single mandate;
 *   5. "Active" is unchanged.
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const ORGS = [ORG, OTHER_ORG];
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `mandate-anti-join-${RUN}`;
const PAGE_SIZE = 25;

/** Listings with an ACTIVE mandate — twice the ~200 ids Kong takes in one URL. */
const N_ACTIVE = 420;
/** …of which the first ten also carry an EXPIRED one (the active wins). */
const N_BOTH = 10;
/** Listings whose only mandates are EXPIRED (the first five carry two). */
const N_EXPIRED = 40;
/** Listings with no mandate at all, and with only a draft or terminated one. */
const N_NONE = 15;
const N_OTHER_STATUS = 8;
/**
 * Listings whose EXPIRED mandate the agent wrote and whose ACTIVE one someone
 * else did, not assigned to the agent: the agent sees only the expired one, so
 * they are "expired" to the agent and "active" to an admin — a block that saw
 * more than the agent can see would drop them from the agent's Expired.
 */
const N_MIXED = 3;

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>() };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound for this page");
    return c;
  },
}));

import PropertiesPage from "@/app/(app)/properties/page";
import PropertiesMapPage from "@/app/(app)/properties/map/page";
import { GET as propertiesExport } from "@/app/(app)/properties/export/route";
import { PropertiesTable } from "@/components/features/properties/list";
import { PropertyMap } from "@/components/features/properties/map-view";

type Params = Record<string, string>;
type Mandate = "none" | "expired" | "active";

// ---------------------------------------------------------------------------
// A real session per user; every REST GET it sends is recorded
// ---------------------------------------------------------------------------
type Session = { client: SupabaseClient; gets: string[] };
const sessions = new Map<TestUser, Session>();

async function session(user: TestUser): Promise<Session> {
  const known = sessions.get(user);
  if (known) return known;
  const s = (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const gets: string[] = [];
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if ((init?.method ?? "GET").toUpperCase() === "GET" && url.includes("/rest/v1/")) gets.push(url);
        return fetch(input, init);
      },
    },
  });
  const { error } = await client.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  sessions.set(user, { client, gets });
  return { client, gets };
}

// ---------------------------------------------------------------------------
// Reading what a page returned — its element tree, no rendering
// ---------------------------------------------------------------------------
type Element = ReactElement<Record<string, unknown>>;

function* walk(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!isValidElement(node)) return;
  const el = node as Element;
  yield el;
  yield* walk(el.props.children);
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as Element).props.children);
  return "";
}

/** What a request did: the GETs it sent, split into the properties read(s) and any mandate read. */
function wire(gets: string[]) {
  const decoded = gets.map((u) => decodeURIComponent(u));
  return {
    propertyReads: decoded.filter((u) => /\/rest\/v1\/properties\?/.test(u)),
    mandateReads: decoded.filter((u) => /\/rest\/v1\/mandates(_safe)?\?/.test(u)),
  };
}

type Outcome<T> = { value: T; thrown: null } | { value: null; thrown: string };
async function attempt<T>(f: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { value: await f(), thrown: null };
  } catch (e) {
    return { value: null, thrown: e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e) };
  }
}

/** The list page in table view: its stated total and the rows of one page. */
async function listPage(user: TestUser, params: Params) {
  const { client, gets } = await session(user);
  gets.length = 0;
  const out = await attempt(async () => {
    const root = (await ctx.als.run(client, () =>
      PropertiesPage({ searchParams: Promise.resolve({ view: "table", ...params }) }),
    )) as ReactNode;
    const els = [...walk(root)];
    // the default list names what it holds (F04): "N listings & developments"
    const header = els.find(
      (e) => e.type === "p" && /^\d+ (?:archived )?(?:listings & developments|listing or development)(?: · |$)/.test(textOf(e)),
    );
    if (!header) throw new Error("the page stated no total");
    const table = els.find((e) => e.type === PropertiesTable);
    const rows = table ? (table.props.rows as { id: string; mandate: string }[]) : [];
    return {
      total: Number(/^(\d+)/.exec(textOf(header))![1]),
      ids: rows.map((r) => r.id),
      // the badge each row shows (active type, else "expired", else "none")
      mandates: rows.map((r) => r.mandate),
    };
  });
  return { ...out, ...wire(gets) };
}

/** Every row of a filter, page by page, as the user would page through it. */
async function walkList(user: TestUser, params: Params) {
  const first = await listPage(user, params);
  if (first.thrown !== null) return { ids: null, mandates: [] as string[], total: null, first };
  const ids = [...first.value.ids];
  const mandates = [...first.value.mandates];
  for (let page = 2; (page - 1) * PAGE_SIZE < first.value.total; page++) {
    const next = await listPage(user, { ...params, page: String(page) });
    if (next.thrown !== null) return { ids: null, mandates: [] as string[], total: null, first: next };
    ids.push(...next.value.ids);
    mandates.push(...next.value.mandates);
  }
  return { ids, mandates, total: first.value.total, first };
}

/** The map page: the ids of the pins it hands the map. */
async function mapPins(user: TestUser, params: Params) {
  const { client, gets } = await session(user);
  gets.length = 0;
  const out = await attempt(async () => {
    const root = (await ctx.als.run(client, () => PropertiesMapPage({ searchParams: Promise.resolve({ ...params }) }))) as ReactNode;
    const map = [...walk(root)].find((e) => e.type === PropertyMap);
    if (!map) throw new Error("the map page rendered no map");
    const data = map.props.data as { features: { properties: { id: string } }[] };
    return data.features.map((f) => f.properties.id);
  });
  return { ...out, ...wire(gets) };
}

/** One CSV line's fields (quoted fields may hold commas and doubled quotes). */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** The export: its answer and the References it holds. */
async function exportCsv(user: TestUser, params: Params) {
  const { client, gets } = await session(user);
  gets.length = 0;
  const url = new URL("http://localhost/properties/export");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const out = await attempt(async () => {
    const res = await ctx.als.run(client, () => propertiesExport(new NextRequest(url)));
    const type = res.headers.get("content-type") ?? "";
    const body = await res.text();
    if (!type.includes("text/csv")) return { status: res.status, refs: null, mandates: null, json: body.slice(0, 200) };
    const lines = body.replace(/^﻿/, "").split("\r\n").filter(Boolean);
    const header = csvFields(lines[0]!);
    const col = header.indexOf("Reference");
    const mcol = header.indexOf("Mandate");
    if (col < 0 || mcol < 0) throw new Error("the CSV has no Reference or Mandate column");
    const rows = lines.slice(1).map((l) => csvFields(l));
    return { status: res.status, refs: rows.map((r) => r[col]!), mandates: rows.map((r) => r[mcol]!), json: null };
  });
  return { ...out, ...wire(gets) };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let manager: TestUser;
let agent: TestUser;
let outsider: TestUser;
const userIds: string[] = [];

/**
 * What a filter means, in SQL: the listings in the default scope (not withdrawn,
 * not archived, not a unit) whose mandates — as `mandates_safe` shows them to
 * the user (an agent: their own, or on a listing assigned to them) — satisfy
 * it. Ordered as the list and the export order them.
 */
async function expected(org: string, mandate: Mandate, agentId: string | null = null) {
  const visible = `m.property_id = p.id and ($3::uuid is null or m.created_by = $3 or p.assigned_agent_id = $3)`;
  const { rows } = await pg.query<{ id: string; reference: string }>(
    `select p.id::text as id, p.reference from properties p
      where p.org_id = $1 and p.kind <> 'unit' and p.status <> 'withdrawn' and p.visibility <> 'archived'
        and case $2::text
              when 'active' then exists (select 1 from mandates m where ${visible} and m.status = 'active')
              when 'expired' then exists (select 1 from mandates m where ${visible} and m.status = 'expired')
                              and not exists (select 1 from mandates m where ${visible} and m.status = 'active')
              else not exists (select 1 from mandates m where ${visible} and m.status in ('active', 'expired'))
            end
      order by p.created_at desc, p.id`,
    [org, mandate, agentId],
  );
  return { ids: rows.map((r) => r.id), refs: rows.map((r) => r.reference) };
}

const exportedEvents = async (org: string) =>
  Number((await pg.query<{ n: string }>("select count(*) as n from events where org_id = $1 and event_type = 'exported'", [org])).rows[0]!.n);

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();

  await ensureTestOrg(svc, ORG, `Mandate anti-join ${RUN}`, SLUG);
  await ensureTestOrg(svc, OTHER_ORG, `Mandate anti-join other ${RUN}`, `${SLUG}-other`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `maj-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  manager = await createTestUser(svc, `maj-lm-${RUN}@test.local`, "listing_manager", ORG);
  userIds.push(manager.id);
  agent = await createTestUser(svc, `maj-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);
  outsider = await createTestUser(svc, `maj-other-${RUN}@test.local`, "admin", OTHER_ORG);
  userIds.push(outsider.id);

  // every listing is placed (so the map draws a pin for each) and created at one
  // instant (so the order is the id tie-breaker's, the same everywhere)
  const AT = "2026-01-01 09:00:00+00";
  const insert = (org: string, prefix: string, n: number, extra = "") =>
    pg.query(
      `insert into properties (org_id, reference, property_type, location, created_at${extra ? ", status" : ""})
       select $1::uuid, format('%s%s-%s', $2::text, $3::text, lpad(g::text, 4, '0')), 'apartment',
              st_setsrid(st_makepoint(33.0 + g * 0.0001, 34.7), 4326)::geography, $5::timestamptz${extra ? `, '${extra}'` : ""}
         from generate_series(1, $4::int) g`,
      [org, prefix, TAG, n, AT],
    );
  await insert(ORG, "MA", N_ACTIVE);
  await insert(ORG, "ME", N_EXPIRED);
  await insert(ORG, "MN", N_NONE);
  await insert(ORG, "MO", N_OTHER_STATUS);
  await insert(ORG, "MW", 5, "withdrawn");
  await insert(ORG, "MZ", N_MIXED);
  // the agent: ten expired-only listings assigned to them
  await pg.query(
    `update properties set assigned_agent_id = $2 where org_id = $1 and reference like 'ME%' and reference <= format('ME%s-%s', $3::text, '0010')`,
    [ORG, agent.id, TAG],
  );
  const mandates = (where: string, status: string, createdBy: string | null = null) =>
    pg.query(
      `insert into mandates (org_id, property_id, type, status, created_by)
       select $1::uuid, p.id, 'exclusive', $2::mandate_status, $3::uuid from properties p where p.org_id = $1 and ${where}`,
      [ORG, status, createdBy],
    );
  // active: the first thirty written by the agent
  await mandates(`p.reference like 'MA%' and p.reference <= format('MA%s-%s', '${TAG}', '0030')`, "active", agent.id);
  await mandates(`p.reference like 'MA%' and p.reference > format('MA%s-%s', '${TAG}', '0030')`, "active");
  await mandates(`p.reference like 'MA%' and p.reference <= format('MA%s-%s', '${TAG}', '${String(N_BOTH).padStart(4, "0")}')`, "expired");
  await mandates(`p.reference like 'ME%'`, "expired");
  await mandates(`p.reference like 'ME%' and p.reference <= format('ME%s-%s', '${TAG}', '0005')`, "expired");
  await mandates(`p.reference like 'MZ%'`, "expired", agent.id);
  await mandates(`p.reference like 'MZ%'`, "active");
  await mandates(`p.reference like 'MO%' and p.reference <= format('MO%s-%s', '${TAG}', '0004')`, "draft");
  await mandates(`p.reference like 'MO%' and p.reference > format('MO%s-%s', '${TAG}', '0004')`, "terminated");

  // OTHER_ORG: five unmandated listings and one with an active mandate
  await insert(OTHER_ORG, "XN", 5);
  await insert(OTHER_ORG, "XA", 1);
  await pg.query(
    `insert into mandates (org_id, property_id, type, status)
     select $1::uuid, p.id, 'exclusive', 'active' from properties p where p.org_id = $1 and p.reference like 'XA%'`,
    [OTHER_ORG],
  );

  // Statistics, as autovacuum keeps them on a real database. Measured
  // 2026-10-12: on tables Postgres has never analysed (this fresh stack; in
  // production only a database just restored, until the first autoanalyse)
  // the page's exact COUNT can plan as a nested loop that rescans the
  // organisation's mandates by org_id once per listing (through the partial
  // index mandates_one_active_per_property) — 1.6–2.7 s for an admin, past the
  // 8 s statement timeout for an agent, for "active" (unchanged) and the
  // anti-joins; with any statistics every shape counts in tens of ms (v14.5 and
  // v16.1). The old "none" count joined no mandates and was immune. The cost is
  // the view's per-row helper calls; hoisting them is on BACKLOG
  // (DECISIONS T-mandate-filter-anti-join).
  await pg.query("analyze properties; analyze mandates;");
}, 300_000);

afterAll(async () => {
  await pg.query("delete from mandates where org_id = any($1::uuid[])", [ORGS]);
  await pg.query("delete from properties where org_id = any($1::uuid[])", [ORGS]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
  await pg.query("delete from organizations where id = any($1::uuid[])", [ORGS]);
  await pg.end();
}, 300_000);

// ---------------------------------------------------------------------------
describe("the No mandate and Expired filters hold past the ~200 mandated listings an id list could carry", () => {
  it("the fixture is what the cases assume", async () => {
    const none = await expected(ORG, "none");
    const expired = await expected(ORG, "expired");
    const active = await expected(ORG, "active");
    console.log(`[evidence] fixture: none ${none.ids.length}, expired ${expired.ids.length}, active ${active.ids.length}`);
    expect(none.ids).toHaveLength(N_NONE + N_OTHER_STATUS);
    expect(expired.ids).toHaveLength(N_EXPIRED);
    expect(active.ids).toHaveLength(N_ACTIVE + N_MIXED);
    expect((await expected(ORG, "expired", agent.id)).refs.filter((r) => r.startsWith("MZ")), "the agent sees the mixed listings as expired").toHaveLength(N_MIXED);
  });

  const ROLES = [
    ["an admin", () => admin],
    ["a listing manager", () => manager],
  ] as const;

  for (const [role, user] of ROLES) {
    for (const mandate of ["none", "expired"] as const) {
      it(`${role}, mandate=${mandate}: the list (every page), the map and the CSV hold exactly the listings it means`, async () => {
        const want = await expected(ORG, mandate);
        const list = await walkList(user(), { mandate });
        const map = await mapPins(user(), { mandate });
        const before = await exportedEvents(ORG);
        const csv = await exportCsv(user(), { mandate });
        const after = await exportedEvents(ORG);
        console.log(
          `[evidence] ${role}, mandate=${mandate}: list ${list.ids ? `total ${list.total}, rows ${list.ids.length}` : `THREW ${list.first.thrown}`}; ` +
            `map ${map.thrown ?? `${map.value!.length} pins`}; ` +
            `export ${csv.thrown ?? `${csv.value!.status} ${csv.value!.refs ? `${csv.value!.refs.length} rows` : csv.value!.json}`}; ` +
            `exported events ${before} → ${after}; longest properties URL ${Math.max(...list.first.propertyReads.map((u) => u.length))} chars`,
        );
        expect(list.first.thrown).toBeNull();
        expect(list.total).toBe(want.ids.length);
        expect(list.ids).toEqual(want.ids);
        expect(map.thrown).toBeNull();
        expect([...map.value!].sort()).toEqual([...want.ids].sort());
        expect(csv.thrown).toBeNull();
        expect(csv.value!.status).toBe(200);
        expect(csv.value!.refs).toEqual(want.refs);
        expect(after, "the export is audited, once").toBe(before + 1);
        // the badge and the CSV's Mandate column come from the display embed,
        // which shares the select with the aliases: it must not be narrowed
        expect(new Set(list.mandates), "every row's badge says the filter").toEqual(new Set([mandate]));
        expect(new Set(csv.value!.mandates), "every CSV row's Mandate says the filter").toEqual(new Set([mandate]));
        for (const surface of [map, csv]) {
          expect(surface.mandateReads, "no separate mandate read").toEqual([]);
          for (const u of surface.propertyReads) expect(u, "no id list in the request").not.toMatch(/not\.in\.|[0-9a-f]{8}-[0-9a-f]{4}-/);
        }
      }, 180_000);
    }
  }

  it("an agent's filters mean what mandates_safe shows the agent (their own and their assigned listings' mandates)", async () => {
    for (const mandate of ["none", "expired"] as const) {
      const want = await expected(ORG, mandate, agent.id);
      const t0 = performance.now();
      const page = await listPage(agent, { mandate });
      const ms = Math.round(performance.now() - t0);
      const csv = await exportCsv(agent, { mandate });
      console.log(
        `[evidence] the agent, mandate=${mandate}: list ${page.thrown ?? `total ${page.value!.total}`} in ${ms} ms; export ${csv.thrown ?? `${csv.value!.status} ${csv.value!.refs?.length ?? csv.value!.json} rows`}; expected ${want.ids.length}`,
      );
      expect(page.thrown).toBeNull();
      expect(page.value!.total).toBe(want.ids.length);
      expect(page.value!.ids).toEqual(want.ids.slice(0, PAGE_SIZE));
      expect(csv.value?.refs).toEqual(want.refs);
      expect(new Set(page.value!.mandates)).toEqual(new Set([mandate]));
      expect(new Set(csv.value!.mandates)).toEqual(new Set([mandate]));
      // the mixed listings: expired to the agent (who cannot see the active one)
      const mixed = csv.value!.refs!.filter((r) => r.startsWith("MZ"));
      expect(mixed, "the mixed listings").toHaveLength(mandate === "expired" ? N_MIXED : 0);
    }
  }, 180_000);

  it("the request does not grow with the mandates: no mandate read, no id list, the same URL for 463 mandated listings as for one", async () => {
    for (const mandate of ["none", "expired"] as const) {
      const big = await listPage(admin, { mandate });
      const small = await listPage(outsider, { mandate });
      const want = await expected(OTHER_ORG, mandate);
      const bigUrl = big.propertyReads[0] ?? "";
      const smallUrl = small.propertyReads[0] ?? "";
      console.log(
        `[evidence] mandate=${mandate}: mandate reads ${big.mandateReads.length}; properties URL ${bigUrl.length} chars (463 mandated) vs ${smallUrl.length} (1 mandated); the other org ${small.thrown ?? `total ${small.value!.total}`}`,
      );
      expect(big.thrown).toBeNull();
      expect(big.propertyReads, "one properties read").toHaveLength(1);
      expect(big.mandateReads, "no separate mandate read").toEqual([]);
      expect(bigUrl, "no id list in the request").not.toMatch(/not\.in\.|[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(bigUrl.length, "the same request whatever the mandate count").toBe(smallUrl.length);
      expect(small.thrown).toBeNull();
      expect(small.value!.ids).toEqual(want.ids);
    }
  }, 120_000);

  it("Active is unchanged: the !inner embed, every active listing counted", async () => {
    const want = await expected(ORG, "active");
    const page = await listPage(admin, { mandate: "active" });
    console.log(`[evidence] mandate=active: ${page.thrown ?? `total ${page.value!.total}`}; expected ${want.ids.length}`);
    expect(page.thrown).toBeNull();
    expect(page.value!.total).toBe(want.ids.length);
    expect(page.value!.ids).toEqual(want.ids.slice(0, PAGE_SIZE));
    expect(new Set(page.value!.mandates), "the badge is the active mandate's type").toEqual(new Set(["exclusive"]));
  }, 60_000);
});
