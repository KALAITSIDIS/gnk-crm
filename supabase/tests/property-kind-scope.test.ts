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
 * The properties list says what its default leaves out, and "All kinds" holds
 * it (F04, the list half) — through the REAL list page, map page and export
 * route, against a REAL PostgREST, with real aal2 sessions.
 *
 * At 66a4f09 the list's default (every kind but units) read "N properties",
 * and no list view held every kind: a dashboard count of available records
 * (10) was 4 under the default plus 6 under "Units only", and nothing on the
 * screen said so. The default now reads "N listings & developments · M units
 * not shown — Show all kinds", M being one exact HEAD count of the same
 * filters with kind=unit, and `kind=all` lists every kind.
 *
 * WHAT IT PINS (each case prints one `[evidence]` line):
 *   1. the header's N and M are the database's own counts, for the default,
 *      a status filter, every mandate filter (the aliased anti-join embeds
 *      ride in the HEAD count), the archived scope and an agent's view;
 *   2. M is exactly what the "Units only" page states, and N + M exactly what
 *      `kind=all` states — and the link the hint carries is that `kind=all`
 *      view, every other filter kept, no page;
 *   3. `kind=all` puts no kind predicate on the wire; the default sends
 *      `kind=neq.unit` and the hint's HEAD `kind=eq.unit`;
 *   4. the map and the CSV of `kind=all` hold the same rows as its list, and
 *      the export's audit line records `kind: "all"`;
 *   5. a page past the end states the true total (its read carries no count),
 *      not 0; a default with no listing but some units says so and links;
 *   6. another organisation's units are never counted.
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const ORGS = [ORG, OTHER_ORG];
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `kind-scope-${RUN}`;

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
// A real session per user; every REST request it sends is recorded (method + URL)
// ---------------------------------------------------------------------------
type Session = { client: SupabaseClient; requests: { method: string; url: string }[] };
const sessions = new Map<TestUser, Session>();

async function session(user: TestUser): Promise<Session> {
  const known = sessions.get(user);
  if (known) return known;
  const s = (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const requests: Session["requests"] = [];
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/rest/v1/")) requests.push({ method: (init?.method ?? "GET").toUpperCase(), url: decodeURIComponent(url) });
        return fetch(input, init);
      },
    },
  });
  const { error } = await client.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  const out = { client, requests };
  sessions.set(user, out);
  return out;
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

/** The header line: its total, its noun, and the units it says it is not showing. */
const HEADER =
  /^(\d+) (?:archived )?(listings & developments|listing or development|propert(?:y|ies) · all kinds|units?|standalone listings?|projects?|phases?)(?: · (\d+) units? not shown — Show all kinds)?$/;

interface ListScreen {
  total: number;
  noun: string;
  hidden: number | null;
  /** where "Show all kinds" goes, when the page offers it */
  allKindsHref: string | null;
  ids: string[];
  text: string;
  requests: Session["requests"];
}

async function listPage(user: TestUser, params: Params): Promise<ListScreen> {
  const { client, requests } = await session(user);
  requests.length = 0;
  const root = (await ctx.als.run(client, () =>
    PropertiesPage({ searchParams: Promise.resolve({ view: "table", ...params }) }),
  )) as ReactNode;
  const els = [...walk(root)];
  const header = els.find((e) => e.type === "p" && HEADER.test(textOf(e)));
  if (!header) throw new Error(`the page stated no total: ${textOf(root).slice(0, 300)}`);
  const m = HEADER.exec(textOf(header))!;
  const link = els.find((e) => typeof e.props.href === "string" && textOf(e) === "Show all kinds");
  const table = els.find((e) => e.type === PropertiesTable);
  return {
    total: Number(m[1]),
    noun: m[2]!,
    hidden: m[3] === undefined ? null : Number(m[3]),
    allKindsHref: link ? String(link.props.href) : null,
    ids: table ? (table.props.rows as { id: string }[]).map((r) => r.id) : [],
    text: textOf(root),
    requests: [...requests],
  };
}

async function mapPins(user: TestUser, params: Params): Promise<string[]> {
  const { client } = await session(user);
  const root = (await ctx.als.run(client, () => PropertiesMapPage({ searchParams: Promise.resolve({ ...params }) }))) as ReactNode;
  const map = [...walk(root)].find((e) => e.type === PropertyMap);
  if (!map) throw new Error("the map page rendered no map");
  return (map.props.data as { features: { properties: { id: string } }[] }).features.map((f) => f.properties.id);
}

async function exportRefs(user: TestUser, params: Params): Promise<{ status: number; refs: string[] }> {
  const { client } = await session(user);
  const url = new URL("http://localhost/properties/export");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await ctx.als.run(client, () => propertiesExport(new NextRequest(url)));
  const body = (await res.text()).replace(/^﻿/, "");
  const lines = body.split("\r\n").filter(Boolean);
  // References are the first column and never carry a comma or a quote here
  return { status: res.status, refs: lines.slice(1).map((l) => l.split(",")[0]!) };
}

/** The `properties` requests of one page load, as "METHOD kind-predicate". */
function kindOnWire(requests: Session["requests"]): string[] {
  return requests
    .filter((r) => /\/rest\/v1\/properties\?/.test(r.url))
    .map((r) => {
      const kind = new URL(r.url).searchParams.getAll("kind");
      return `${r.method} ${kind.length ? kind.join("&") : "(none)"}`;
    });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let agent: TestUser;
const userIds: string[] = [];

/**
 * What a filter set selects, in SQL, split by kind: the default scope (not
 * withdrawn, not archived) or the archived one; a status; a mandate filter as
 * `mandates_safe` shows it (an agent: their own, or on a listing assigned to
 * them). Ordered as the list orders.
 */
async function expected(opts: { status?: string; mandate?: Mandate; archived?: boolean; agentId?: string | null } = {}) {
  const visible = `m.property_id = p.id and ($4::uuid is null or m.created_by = $4 or p.assigned_agent_id = $4)`;
  const scope = opts.archived
    ? "(p.status = 'withdrawn' or p.visibility = 'archived')"
    : "(p.status <> 'withdrawn' and p.visibility <> 'archived')";
  const { rows } = await pg.query<{ id: string; kind: string; reference: string }>(
    `select p.id::text as id, p.kind::text as kind, p.reference from properties p
      where p.org_id = $1 and ${scope} and ($2::text is null or p.status::text = $2)
        and case $3::text
              when 'active' then exists (select 1 from mandates m where ${visible} and m.status = 'active')
              when 'expired' then exists (select 1 from mandates m where ${visible} and m.status = 'expired')
                              and not exists (select 1 from mandates m where ${visible} and m.status = 'active')
              when 'none' then not exists (select 1 from mandates m where ${visible} and m.status in ('active', 'expired'))
              else true
            end
      order by p.created_at desc, p.id`,
    [ORG, opts.status ?? null, opts.mandate ?? null, opts.agentId ?? null],
  );
  return {
    shown: rows.filter((r) => r.kind !== "unit").map((r) => r.id),
    units: rows.filter((r) => r.kind === "unit").map((r) => r.id),
    all: rows.map((r) => r.id),
    refs: rows.map((r) => r.reference),
  };
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();

  await ensureTestOrg(svc, ORG, `Kind scope ${RUN}`, SLUG);
  await ensureTestOrg(svc, OTHER_ORG, `Kind scope other ${RUN}`, `${SLUG}-other`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `ks-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agent = await createTestUser(svc, `ks-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);

  // Every record placed (so the map draws a pin for each) and created at one
  // instant (so the order is the id tie-breaker's, the same everywhere).
  const AT = "2026-01-01 09:00:00+00";
  const insert = async (
    org: string,
    reference: string,
    kind: "standalone" | "project" | "phase" | "unit",
    parent: string | null,
    extra: { status?: string; visibility?: string; agent?: string } = {},
  ): Promise<string> => {
    const { rows } = await pg.query<{ id: string }>(
      `insert into properties (org_id, reference, kind, parent_id, property_type, status, visibility, assigned_agent_id, location, created_at)
       values ($1, $2, $3::property_kind, $4, 'apartment', $5::property_status, $6::visibility_level, $7,
               st_setsrid(st_makepoint(33.0 + random() * 0.01, 34.7), 4326)::geography, $8::timestamptz)
       returning id::text as id`,
      [org, reference, kind, parent, extra.status ?? "available", extra.visibility ?? "private", extra.agent ?? null, AT],
    );
    return rows[0]!.id;
  };

  // ORG — three standalone listings (one assigned to the agent), a project with
  // six available units, a sold one and an archived one, a phase with two
  // units; one withdrawn and one archived listing
  const s1 = await insert(ORG, `KS${TAG}-1`, "standalone", null, { agent: agent.id });
  const s2 = await insert(ORG, `KS${TAG}-2`, "standalone", null);
  await insert(ORG, `KS${TAG}-3`, "standalone", null);
  const project = await insert(ORG, `KP${TAG}`, "project", null);
  const units: string[] = [];
  for (let i = 1; i <= 6; i++) units.push(await insert(ORG, `KP${TAG}-A${i}`, "unit", project));
  await insert(ORG, `KP${TAG}-S1`, "unit", project, { status: "sold" });
  await insert(ORG, `KP${TAG}-Z1`, "unit", project, { visibility: "archived" });
  const phase = await insert(ORG, `KP${TAG}-B`, "phase", project);
  await insert(ORG, `KP${TAG}-B1`, "unit", phase);
  await insert(ORG, `KP${TAG}-B2`, "unit", phase);
  await insert(ORG, `KW${TAG}-1`, "standalone", null, { status: "withdrawn" });
  await insert(ORG, `KZ${TAG}-1`, "standalone", null, { visibility: "archived" });

  // mandates: active on a listing (written by the agent) and on a unit; expired
  // on another listing and on two units (one of them also active — it wins)
  const mandate = (propertyId: string, status: "active" | "expired", createdBy: string | null = null) =>
    pg.query(
      `insert into mandates (org_id, property_id, type, status, created_by) values ($1, $2, 'exclusive', $3::mandate_status, $4)`,
      [ORG, propertyId, status, createdBy],
    );
  await mandate(s1, "active", agent.id);
  await mandate(s2, "expired");
  await mandate(units[0]!, "active");
  await mandate(units[0]!, "expired");
  await mandate(units[1]!, "expired", agent.id);

  // OTHER_ORG — a project with four units: never counted for ORG
  const otherProject = await insert(OTHER_ORG, `XP${TAG}`, "project", null);
  for (let i = 1; i <= 4; i++) await insert(OTHER_ORG, `XP${TAG}-A${i}`, "unit", otherProject);

  await pg.query("analyze properties; analyze mandates;");
}, 300_000);

afterAll(async () => {
  await pg.query("delete from mandates where org_id = any($1::uuid[])", [ORGS]);
  await pg.query("delete from properties where org_id = any($1::uuid[]) and kind = 'unit'", [ORGS]);
  await pg.query("delete from properties where org_id = any($1::uuid[]) and kind = 'phase'", [ORGS]);
  await pg.query("delete from properties where org_id = any($1::uuid[])", [ORGS]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
  await pg.query("delete from organizations where id = any($1::uuid[])", [ORGS]);
  await pg.end();
}, 300_000);

// ---------------------------------------------------------------------------
describe("the default list says how many units it leaves out, and All kinds holds them (F04)", () => {
  it("the fixture is what the cases assume", async () => {
    const live = await expected();
    const archived = await expected({ archived: true });
    console.log(
      `[evidence] fixture: default ${live.shown.length}, units ${live.units.length}, all ${live.all.length}; archived scope ${archived.shown.length} + ${archived.units.length} units`,
    );
    expect(live.shown).toHaveLength(5); // 3 standalone + project + phase
    expect(live.units).toHaveLength(9); // 6 + 1 sold + 2 under the phase
    expect(archived.shown).toHaveLength(2);
    expect(archived.units).toHaveLength(1);
  });

  it("the default header: N listings & developments · M units not shown — Show all kinds, from the database's own counts", async () => {
    const want = await expected();
    const page = await listPage(admin, {});
    console.log(`[evidence] default: "${page.total} ${page.noun} · ${page.hidden} units not shown" (database ${want.shown.length} + ${want.units.length}); wire ${kindOnWire(page.requests).join(" | ")}`);
    expect(page.total).toBe(want.shown.length);
    expect(page.noun).toBe("listings & developments");
    expect(page.hidden).toBe(want.units.length);
    expect(page.ids).toEqual(want.shown);
    // view=table travels; the kind becomes all; no page
    expect(page.allKindsHref).toBe("/properties?view=table&kind=all");
    // one list read without units, one exact HEAD count of only the units
    expect(kindOnWire(page.requests).sort()).toEqual(["GET neq.unit", "HEAD eq.unit"]);
  }, 60_000);

  it("kind=all lists every kind — the default's rows plus the units it hid — with no kind predicate and no hint", async () => {
    const want = await expected();
    const page = await listPage(admin, { kind: "all" });
    console.log(`[evidence] kind=all: "${page.total} ${page.noun}", rows ${page.ids.length} (database ${want.all.length}); wire ${kindOnWire(page.requests).join(" | ")}`);
    expect(page.total).toBe(want.all.length);
    expect(page.noun).toBe("properties · all kinds");
    expect(page.hidden).toBeNull();
    expect(page.allKindsHref).toBeNull();
    expect(page.ids).toEqual(want.all);
    expect(kindOnWire(page.requests)).toEqual(["GET (none)"]);
  }, 60_000);

  const CASES: [string, Params, Parameters<typeof expected>[0]][] = [
    ["status=available", { status: "available" }, { status: "available" }],
    ["status=sold", { status: "sold" }, { status: "sold" }],
    ["mandate=active", { mandate: "active" }, { mandate: "active" }],
    ["mandate=expired", { mandate: "expired" }, { mandate: "expired" }],
    ["mandate=none", { mandate: "none" }, { mandate: "none" }],
    ["scope=archived", { scope: "archived" }, { archived: true }],
  ];

  for (const [label, params, sql] of CASES) {
    it(`${label}: M is what "Units only" states and N + M what kind=all states — and both are the database's`, async () => {
      const want = await expected(sql);
      const shown = await listPage(admin, params);
      const units = await listPage(admin, { ...params, kind: "unit" });
      const all = await listPage(admin, { ...params, kind: "all" });
      console.log(
        `[evidence] ${label}: default ${shown.total} · hint ${shown.hidden ?? "none"}; units page ${units.total}; all-kinds page ${all.total}; database ${want.shown.length} + ${want.units.length}`,
      );
      expect(shown.total).toBe(want.shown.length);
      expect(shown.hidden ?? 0).toBe(want.units.length);
      expect(units.total).toBe(want.units.length);
      expect(all.total).toBe(want.all.length);
      expect(shown.total + (shown.hidden ?? 0)).toBe(all.total);
      expect(all.ids).toEqual(want.all.slice(0, 25));
      if (want.units.length > 0) {
        const href = new URL(shown.allKindsHref!, "http://localhost");
        expect(Object.fromEntries(href.searchParams)).toEqual({ view: "table", ...params, kind: "all" });
      } else {
        // nothing hidden, nothing to offer
        expect(shown.allKindsHref).toBeNull();
      }
    }, 90_000);
  }

  it("an agent: the hint counts what mandates_safe shows the agent", async () => {
    for (const mandate of ["active", "expired", "none"] as const) {
      const want = await expected({ mandate, agentId: agent.id });
      const shown = await listPage(agent, { mandate });
      const units = await listPage(agent, { mandate, kind: "unit" });
      console.log(`[evidence] agent mandate=${mandate}: default ${shown.total} · hint ${shown.hidden ?? "none"}; units page ${units.total}; database ${want.shown.length} + ${want.units.length}`);
      expect(shown.total).toBe(want.shown.length);
      expect(shown.hidden ?? 0).toBe(want.units.length);
      expect(units.total).toBe(want.units.length);
    }
  }, 90_000);

  it("kind=all: the map and the CSV hold the list's rows, and the export's audit line says kind all", async () => {
    const want = await expected();
    const pins = await mapPins(admin, { kind: "all" });
    const before = await pg.query<{ n: string }>("select count(*) as n from events where org_id = $1 and event_type = 'exported'", [ORG]);
    const csv = await exportRefs(admin, { kind: "all" });
    const { rows: audit } = await pg.query<{ payload: { filters?: Record<string, unknown> } }>(
      "select payload from events where org_id = $1 and event_type = 'exported' order by occurred_at desc limit 1",
      [ORG],
    );
    console.log(`[evidence] kind=all: map ${pins.length} pins, CSV ${csv.status} ${csv.refs.length} rows, audit filters ${JSON.stringify(audit[0]?.payload.filters)} (database ${want.all.length})`);
    expect([...pins].sort()).toEqual([...want.all].sort());
    expect(csv.status).toBe(200);
    expect(csv.refs).toEqual(want.refs);
    expect(Number(before.rows[0]!.n) + 1).toBe(
      Number((await pg.query<{ n: string }>("select count(*) as n from events where org_id = $1 and event_type = 'exported'", [ORG])).rows[0]!.n),
    );
    expect(audit[0]!.payload.filters).toMatchObject({ kind: "all", scope: "active" });
  }, 90_000);

  it("a page past the end states the true total, not 0, and still the units it leaves out", async () => {
    const want = await expected();
    const page = await listPage(admin, { page: "2" });
    console.log(`[evidence] page 2 of 1: "${page.total} ${page.noun}", hint ${page.hidden}, rows ${page.ids.length}`);
    expect(page.ids).toEqual([]);
    expect(page.text).toMatch(/Nothing on this page\./);
    expect(page.total).toBe(want.shown.length);
    expect(page.hidden).toBe(want.units.length);
    expect(page.text).not.toMatch(/Page 2 of/);
  }, 60_000);

  it("a default with no listing but matching units says so, and links to them", async () => {
    // a unit's reference typed into the search: the default holds nothing
    const q = `KP${TAG}-A`;
    const page = await listPage(admin, { q });
    console.log(`[evidence] q=${q}: "${page.total} ${page.noun}", hint ${page.hidden}; empty state "${/No listings[^.]*\./.exec(page.text)?.[0]}"`);
    expect(page.total).toBe(0);
    expect(page.hidden).toBe(6);
    expect(page.text).toContain("No listings or developments match — 6 units do.");
    expect(page.allKindsHref).toBe(`/properties?view=table&q=${encodeURIComponent(q).replace(/%20/g, "+")}&kind=all`);
    const all = await listPage(admin, { q, kind: "all" });
    expect(all.total).toBe(6);
  }, 60_000);
});
