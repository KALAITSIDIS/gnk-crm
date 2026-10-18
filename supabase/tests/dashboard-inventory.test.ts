import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isValidElement, type ReactElement } from "react";
import {
  ANON_KEY,
  SUPABASE_URL,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";
import { BODY_MD5_0153, REVERT_0153_SQL, SIGNATURE_0153, readMigration0153 } from "./revert-0153";

/**
 * F04-C: the admin dashboard's Inventory card and 0153's
 * property_inventory_counts(), against a REAL PostgREST with each session's
 * RLS and aal2 token, and the migration itself as postgres.
 *
 * THE DEFECT (before 0153): the card read admin_dashboard_stats'
 * property_statuses — every kind, withdrawn rows included, grouped by status
 * only — so "available 10" was 4 rows on the list's default plus 6 on "Units
 * only", no list reproduced it, and a project counted as stock beside its own
 * units.
 *
 * WHAT IT PINS
 *   1. The function, through PostgREST: exactly the live rows (not archived,
 *      not withdrawn) per kind and status, equal to postgres' count(*) by the
 *      documented predicate; nothing of another organisation; an agent reads
 *      the same (properties_select is org-wide); anon is refused (42501).
 *   2. The card (the real server component): every chip's number equals the
 *      row count of the list its link opens — through the list's own parser
 *      and filter builder on the same session (parity oracle); every status
 *      total is the sum of its chips and postgres' count for that status, and
 *      opens ?status=S&kind=all; "Saleable available" is listings + units,
 *      never the project; the footnote; the withdrawn & archived link.
 *   3. An empty answer is the empty state; an answer with no rows array, a
 *      refused read, or a row the function cannot have answered is the page's
 *      failure — never a zero.
 *   4. The migration: replay over the state before it, its shape, the
 *      one-transaction guard, preflight refusals, a bounded lock wait, replay
 *      safety, postflight mutants, the rollback, the restore pack's rows.
 *
 * Before 0153 sections 1, 2 and 4 fail: there is no function to call or
 * replay. (On this fixture the old card read "available 13" with no
 * breakdown — the default list shows 5 of them — and a "withdrawn 2" bar no
 * list in the active scope shows.)
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const RUN = Date.now().toString(36);
const ORG = randomUUID();
const OTHER = randomUUID();
const ORGS = [ORG, OTHER];

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>() };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound for this component");
    return c;
  },
}));
// the card's words, from the English catalogue, through next-intl's own ICU
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const en = (await import("@/messages/en.json")).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: "en", messages: en as never, namespace: namespace as never }),
  };
});

import { Card, CardEmpty } from "@/components/features/dashboard/card";
import { InventoryCard } from "@/components/features/dashboard/inventory-card";
import { applyPropertyListFilters, mandateEmbed, parsePropertyFilters } from "@/lib/queries/properties-list";

// ---------------------------------------------------------------------------
// Sessions: a real client per user; one chosen request can be answered instead
// ---------------------------------------------------------------------------
interface Steer {
  match: (method: string, url: string) => boolean;
  respond: () => Response;
  hits: number;
}
type Session = { client: SupabaseClient; steer: Steer | null };
const sessions = new Map<string, Session>();

async function session(user: TestUser): Promise<Session> {
  const known = sessions.get(user.id);
  if (known) return known;
  const s = (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const state: Session = { client: undefined as unknown as SupabaseClient, steer: null };
  state.client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = decodeURIComponent(raw);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.includes("/rest/v1/") && state.steer?.match(method, url)) {
          state.steer.hits++;
          return state.steer.respond();
        }
        return fetch(input, init);
      },
    },
  });
  const { error } = await state.client.auth.setSession({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
  });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  sessions.set(user.id, state);
  return state;
}

async function as<T>(user: TestUser, fn: () => Promise<T> | T): Promise<T> {
  const { client } = await session(user);
  return ctx.als.run(client, fn);
}

// ---------------------------------------------------------------------------
// Reading what the component returned — its element tree, expanding only the
// synchronous card chrome
// ---------------------------------------------------------------------------
type Element = ReactElement<Record<string, unknown>>;
const EXPAND = new Set<unknown>([Card, CardEmpty]);

function* walk(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!isValidElement(node)) return;
  const el = node as Element;
  yield el;
  if (EXPAND.has(el.type)) {
    yield* walk((el.type as (p: unknown) => unknown)(el.props));
    return;
  }
  yield* walk(el.props.children);
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    const el = node as Element;
    if (EXPAND.has(el.type)) return textOf((el.type as (p: unknown) => unknown)(el.props));
    return textOf(el.props.children);
  }
  return "";
}

interface LinkView {
  href: string;
  text: string;
  aria: string | undefined;
}
const linksOf = (node: unknown): LinkView[] =>
  [...walk(node)]
    // the rendered anchors — not CardEmpty's own href prop
    .filter((e) => typeof e.props.href === "string" && !EXPAND.has(e.type))
    .map((e) => ({
      href: String(e.props.href),
      text: textOf(e.props.children),
      aria: e.props["aria-label"] as string | undefined,
    }));

async function renderCard(user: TestUser) {
  const tree = await as(user, () => InventoryCard());
  const card = [...walk(tree)].find((e) => e.type === Card);
  if (!card) throw new Error("the inventory card rendered no Card");
  const items = [...walk(card.props.children)].filter((e) => e.type === "li");
  return {
    title: String(card.props.title),
    text: textOf(card.props.children),
    links: linksOf(card.props.children),
    /** the first paragraph: the saleable headline */
    headline: [...walk(card.props.children)].find((e) => e.type === "p"),
    rows: items.map((li) => ({ text: textOf(li), links: linksOf(li) })),
  };
}

/** The row count of the list a link opens: its own parser and filter builder, on the session's RLS. */
async function listCount(client: SupabaseClient, href: string): Promise<number> {
  const url = new URL(href, "http://x");
  expect(url.pathname).toBe("/properties");
  const f = parsePropertyFilters(Object.fromEntries(url.searchParams));
  const base = client.from("properties").select(`id, ${mandateEmbed(f)}`, { count: "exact", head: true });
  // the real PostgREST builder at runtime; typed loosely here — the builder's
  // generic over an untyped client is too deep for tsc (TS2589)
  const res = await (applyPropertyListFilters(base as never, f) as unknown as PromiseLike<{
    count: number | null;
    error: { message: string } | null;
  }>);
  if (res.error || typeof res.count !== "number") throw new Error(`list count ${href}: ${res.error?.message ?? "no count"}`);
  return res.count;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let agent: TestUser;
const userIds: string[] = [];

/** ORG's live rows, in the function's order (kind, then status, by enum position). */
const EXPECTED = [
  { kind: "standalone", status: "draft", n: 1 },
  { kind: "standalone", status: "available", n: 3 },
  { kind: "standalone", status: "sold", n: 1 },
  { kind: "project", status: "draft", n: 1 },
  { kind: "project", status: "available", n: 1 },
  { kind: "phase", status: "available", n: 1 },
  { kind: "unit", status: "available", n: 8 },
  { kind: "unit", status: "reserved", n: 1 },
  { kind: "unit", status: "under_offer", n: 1 },
];

async function property(
  org: string,
  ref: string,
  kind: string,
  status: string,
  visibility = "private",
  parent: string | null = null,
): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `insert into properties (org_id, reference, property_type, kind, status, visibility, parent_id)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [org, `IV${RUN}${ref}`.slice(0, 20), kind === "standalone" || kind === "unit" ? "apartment" : "building", kind, status, visibility, parent],
  );
  return rows[0]!.id;
}

/** postgres' own count, by the documented predicate, for one organisation. */
async function pgCounts(org: string): Promise<{ kind: string; status: string; n: number }[]> {
  const { rows } = await pg.query<{ kind: string; status: string; n: number }>(
    `select kind::text as kind, status::text as status, count(*)::int as n
       from properties
      where org_id = $1 and visibility <> 'archived' and status <> 'withdrawn'
      group by properties.kind, properties.status
      order by properties.kind, properties.status`,
    [org],
  );
  return rows;
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Inventory ${RUN}`, `inventory-${RUN}`);
  await ensureTestOrg(svc, OTHER, `Inventory other ${RUN}`, `inventory-other-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `inv-a-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agent = await createTestUser(svc, `inv-g-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);

  // standalone listings: three available (public, private, vip), a draft, a
  // sold one — and, out of scope, a withdrawn one and an archived available one
  await property(ORG, "S1", "standalone", "available", "public");
  await property(ORG, "S2", "standalone", "available", "private");
  await property(ORG, "S3", "standalone", "available", "vip");
  await property(ORG, "S4", "standalone", "draft");
  await property(ORG, "S5", "standalone", "sold");
  await property(ORG, "S6", "standalone", "withdrawn");
  await property(ORG, "S7", "standalone", "available", "archived");
  // an available project with six available units, a reserved one, and out of
  // scope an archived available unit and a withdrawn unit
  const p1 = await property(ORG, "P1", "project", "available");
  for (let i = 1; i <= 6; i++) await property(ORG, `U${i}`, "unit", "available", i % 2 ? "public" : "private", p1);
  await property(ORG, "U7", "unit", "reserved", "private", p1);
  await property(ORG, "U8", "unit", "available", "archived", p1);
  await property(ORG, "U9", "unit", "withdrawn", "private", p1);
  // a draft project with an available phase holding two available units and one under offer
  const p2 = await property(ORG, "P2", "project", "draft");
  const ph = await property(ORG, "PH1", "phase", "available", "private", p2);
  await property(ORG, "U10", "unit", "available", "private", ph);
  await property(ORG, "U11", "unit", "available", "public", ph);
  await property(ORG, "U12", "unit", "under_offer", "private", ph);
  // another organisation's live rows: RLS must keep them out
  await property(OTHER, "S1", "standalone", "available", "public");
  await property(OTHER, "S2", "standalone", "available", "public");
  const op = await property(OTHER, "P1", "project", "available");
  await property(OTHER, "U1", "unit", "available", "public", op);
}, 300_000);

afterAll(async () => {
  if (pg) {
    // children before parents (parent_id is ON DELETE RESTRICT)
    for (const kind of ["unit", "phase", "project", "standalone"]) {
      await pg.query("delete from properties where org_id = any($1::uuid[]) and kind = $2", [ORGS, kind]);
    }
    for (const u of userIds) await svc.auth.admin.deleteUser(u);
    for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
      await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
    }
    await pg.query("delete from organizations where id = any($1::uuid[])", [ORGS]);
    await pg.end();
  }
}, 300_000);

// ---------------------------------------------------------------------------

describe("1. property_inventory_counts() through PostgREST", () => {
  it("answers exactly the live rows per kind and status — postgres' count(*) by the documented predicate", async () => {
    const { client } = await session(admin);
    const { data, error } = await client.rpc("property_inventory_counts");
    expect(error).toBeNull();
    expect(data).toEqual(EXPECTED);
    expect(data).toEqual(await pgCounts(ORG));
    // the withdrawn and archived rows exist, and are not counted
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from properties where org_id = $1 and (visibility = 'archived' or status = 'withdrawn')",
      [ORG],
    );
    expect(rows[0]!.n).toBe(4);
    console.log(`[evidence] admin answer ${JSON.stringify(data)}`);
  });

  it("an agent reads the same — properties_select is the organisation — and nothing of another organisation", async () => {
    const { client } = await session(agent);
    const { data, error } = await client.rpc("property_inventory_counts");
    expect(error).toBeNull();
    expect(data).toEqual(EXPECTED);
    expect((await pgCounts(OTHER)).length).toBeGreaterThan(0); // the other org's rows exist
  });

  it("anon may not call it (42501)", async () => {
    const { data, error } = await anonClient().rpc("property_inventory_counts");
    expect(data).toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("2. the Inventory card: every number opens the list that shows it", () => {
  it("is titled, and each chip's number is the row count of the list its link opens", async () => {
    const card = await renderCard(admin);
    const { client } = await session(admin);
    expect(card.title).toBe("Inventory by status");
    expect(card.rows.map((r) => r.text.split(/\d/)[0])).toEqual(["Draft", "Available", "Reserved", "Under offer", "Sold"]);

    const evidence: string[] = [];
    for (const row of card.rows) {
      const [total, ...chips] = row.links;
      const status = new URL(total!.href, "http://x").searchParams.get("status")!;
      // the status total: every kind, ?status=S&kind=all
      expect(total!.href).toBe(`/properties?status=${status}&kind=all`);
      expect(chips.length).toBeGreaterThan(0);
      let sum = 0;
      for (const chip of chips) {
        const n = Number.parseInt(chip.text, 10);
        const kind = new URL(chip.href, "http://x").searchParams.get("kind")!;
        expect(chip.href).toBe(`/properties?status=${status}&kind=${kind}`);
        // the parity oracle: the list's own parser + filter builder, same session
        expect(await listCount(client, chip.href), `${chip.href} lists ${chip.text}`).toBe(n);
        expect(EXPECTED.find((e) => e.kind === kind && e.status === status)?.n).toBe(n);
        sum += n;
        evidence.push(`${chip.href}=${n}`);
      }
      // a total counts every record of every kind once: the sum of its chips,
      // and postgres' count for that status
      expect(Number(total!.text)).toBe(sum);
      const { rows } = await pg.query<{ n: number }>(
        "select count(*)::int as n from properties where org_id = $1 and status = $2 and visibility <> 'archived'",
        [ORG, status],
      );
      expect(Number(total!.text)).toBe(rows[0]!.n);
      // ...and the every-kind list is the default (units hidden) plus the units
      expect(Number(total!.text)).toBe(
        (await listCount(client, `/properties?status=${status}`)) +
          (await listCount(client, `/properties?status=${status}&kind=unit`)),
      );
      expect(total!.aria).toMatch(new RegExp(`^[A-Z][a-z ]+: ${total!.text} live records? — open the list$`));
    }
    console.log(`[evidence] chips ${evidence.join(" ")}`);
  });

  it("the available row: 13 records — 3 listings, 1 development, 1 phase, 8 units", async () => {
    const card = await renderCard(admin);
    const available = card.rows.find((r) => r.text.startsWith("Available"))!;
    expect(available.links.map((l) => [l.href, l.text])).toEqual([
      ["/properties?status=available&kind=all", "13"],
      ["/properties?status=available&kind=standalone", "3 listings"],
      ["/properties?status=available&kind=project", "1 development"],
      ["/properties?status=available&kind=phase", "1 phase"],
      ["/properties?status=available&kind=unit", "8 units"],
    ]);
  });

  it("saleable available is listings + units — 11, never the 13 records with their containers", async () => {
    const card = await renderCard(admin);
    expect(textOf(card.headline)).toBe("Saleable available: 11 — 3 listings + 8 units");
    expect(linksOf(card.headline).map((l) => [l.href, l.text])).toEqual([
      ["/properties?status=available&kind=standalone", "3 listings"],
      ["/properties?status=available&kind=unit", "8 units"],
    ]);
  });

  it("says what it counts, and opens what it leaves out", async () => {
    const card = await renderCard(admin);
    expect(card.text).toContain("Live records: not archived and not withdrawn, the properties list's default.");
    expect(card.text).toContain("Saleable means listings and units: a development itself cannot be reserved.");
    expect(card.links.at(-1)).toEqual({ href: "/properties?scope=archived&kind=all", text: "Withdrawn & archived →", aria: undefined });
  });

  it("an agent's session renders the same numbers", async () => {
    const mine = await renderCard(admin);
    const theirs = await renderCard(agent);
    expect(theirs.links).toEqual(mine.links);
  });
});

describe("3. an empty answer is empty; a missing one is a failure, never a zero", () => {
  const rpc = (m: string, u: string) => m === "POST" && u.includes("/rest/v1/rpc/property_inventory_counts");
  const json = (status: number, body: string) => () =>
    new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8" } });

  async function withSteer(respond: () => Response) {
    const s = await session(admin);
    s.steer = { match: rpc, respond, hits: 0 };
    try {
      return { result: await renderCard(admin), thrown: null as string | null, hits: s.steer.hits };
    } catch (e) {
      return { result: null, thrown: e instanceof Error ? e.message : String(e), hits: s.steer.hits };
    } finally {
      s.steer = null;
    }
  }

  it("no live rows: the empty state, and the withdrawn & archived link is still there", async () => {
    const r = await withSteer(json(200, "[]"));
    expect(r.hits).toBe(1);
    expect(r.thrown).toBeNull();
    expect(r.result!.text).toContain("No live listings.");
    expect(r.result!.links.map((l) => l.href)).toEqual(["/properties", "/properties?scope=archived&kind=all"]);
    expect(r.result!.text).not.toContain("Saleable available");
  });

  it("an answer with no rows array", async () => {
    const r = await withSteer(json(200, "null"));
    expect(r.hits).toBe(1);
    expect(r.thrown).toMatch(/^Query failed \(inventory counts\): the answer held no rows/);
  });

  it("a refused read", async () => {
    const r = await withSteer(json(500, JSON.stringify({ code: "XX000", message: "boom", details: null, hint: null })));
    expect(r.hits).toBe(1);
    expect(r.thrown).toBe("Query failed (inventory counts): boom");
  });

  it("a row the function cannot have answered (withdrawn)", async () => {
    const r = await withSteer(json(200, JSON.stringify([{ kind: "unit", status: "withdrawn", n: 3 }])));
    expect(r.hits).toBe(1);
    expect(r.thrown).toMatch(/^Query failed \(inventory counts\): row 0 is not a live kind and status/);
  });
});

// ---------------------------------------------------------------------------

describe("4. the migration", () => {
  let o: Client; // postgres: the replays
  let a: Client; // a second session holding a lock

  beforeAll(async () => {
    o = new Client({ connectionString: DB_URL });
    a = new Client({ connectionString: DB_URL });
    await o.connect();
    await a.connect();
  });
  afterAll(async () => {
    await a?.end();
    await o?.end();
  });

  type PgError = Error & { code?: string };
  const failure = (q: Promise<unknown>) =>
    q.then(
      () => null,
      (e: PgError) => e,
    );

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
  const fn = async () =>
    (
      await o.query<{ md5: string | null; secdef: boolean | null; grants: string | null }>(
        `select md5(replace(p.prosrc, chr(13), '')) as md5, p.prosecdef as secdef,
                has_function_privilege('anon', p.oid, 'execute')::text || '/' ||
                has_function_privilege('authenticated', p.oid, 'execute')::text || '/' ||
                has_function_privilege('service_role', p.oid, 'execute')::text as grants
           from (select to_regprocedure($1) as oid) r left join pg_proc p on p.oid = r.oid`,
        [SIGNATURE_0153],
      )
    ).rows[0]!;
  const BODY = (sql: string) => sql.slice(sql.indexOf("as $fn$") + "as $fn$".length, sql.indexOf("$fn$;"));

  it("replays over the state before it: preflight and postflight pass, its body, its grants, the summary as its last row", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0153_SQL);
      expect((await fn()).md5).toBeNull();
      const row = lastRow(await o.query(readMigration0153()));
      expect(String(row.applied)).toMatch(/^0153 applied — property_inventory_counts\(\)/);
      expect(await fn()).toEqual({ md5: BODY_MD5_0153, secdef: false, grants: "false/true/true" });
      expect(notices.some((m) => m.startsWith("0153: postflight passed"))).toBe(true);
    });
  });

  it("its body is the digest it pins, and its shape: aborts before the DDL, no begin/commit, writes only inside the undone probe", () => {
    const sql = readMigration0153();
    expect(createHash("md5").update(BODY(sql)).digest("hex")).toBe(BODY_MD5_0153);
    expect([...sql.matchAll(new RegExp(BODY_MD5_0153, "g"))]).toHaveLength(2);
    const code = sql.replace(/--[^\n]*/g, "");
    const firstDdl = code.search(/\bcreate or replace function\b/i);
    expect(firstDdl).toBeGreaterThan(0);
    const aborts = [...code.matchAll(/raise exception '0153 aborted/g)].map((m) => m.index!);
    expect(aborts.length).toBeGreaterThanOrEqual(6);
    for (const at of aborts) expect(at).toBeLessThan(firstDdl);
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im);
    expect(code).not.toMatch(/\b(update\s+public\.|delete\s+from|truncate)\b/i);
    // every insert is the postflight probe's, which raises its undo marker after it
    const undo = code.indexOf("message = '0153-postflight-undo'");
    for (const m of code.matchAll(/insert into public\.(\w+)/g)) {
      expect(["organizations", "properties"]).toContain(m[1]);
      expect(m.index!).toBeGreaterThan(firstDdl);
      expect(m.index!).toBeLessThan(undo);
    }
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0153();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/^0153 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  const SAME_SHAPE = (body: string, extra = "") => `
    create or replace function public.property_inventory_counts()
    returns table (kind public.property_kind, status public.property_status, n bigint)
    language sql stable ${extra} set search_path = public as $fn$${body}$fn$;`;
  const refusals: Array<[string, string, RegExp]> = [
    [
      "a function of that name it did not write (one that counts withdrawn rows)",
      SAME_SHAPE("select p.kind, p.status, count(*) from public.properties p where p.visibility <> 'archived' group by 1, 2"),
      /^0153 aborted: public\.property_inventory_counts exists and is not this file's \(md5 [0-9a-f]{32}\) — read it before replacing it; nothing was changed$/,
    ],
    [
      "its own body as a SECURITY DEFINER",
      SAME_SHAPE(BODY(readMigration0153()), "security definer"),
      /^0153 aborted: public\.property_inventory_counts exists and is not this file's \(md5 n\/a: another signature, or SECURITY DEFINER\)/,
    ],
    [
      "another signature under the name",
      "create function public.property_inventory_counts(p_org uuid) returns bigint language sql stable as $fn$ select 0::bigint $fn$",
      /^0153 aborted: public\.property_inventory_counts exists and is not this file's \(md5 n\/a: another signature, or SECURITY DEFINER\)/,
    ],
    [
      "two overloads under the name",
      `create function public.property_inventory_counts(p_org uuid) returns bigint language sql stable as $fn$ select 0::bigint $fn$;
       create function public.property_inventory_counts(p_org text) returns bigint language sql stable as $fn$ select 0::bigint $fn$`,
      /^0153 aborted: public\.property_inventory_counts already has 2 overloads — nothing was changed$/,
    ],
    [
      "properties without row level security (an invoker's only tenant boundary)",
      "alter table public.properties disable row level security",
      /^0153 aborted: public\.properties is not a table with row level security enabled — nothing was changed$/,
    ],
    [
      "a properties_select that is not the organisation",
      "alter policy properties_select on public.properties using (true)",
      /^0153 aborted: public\.properties is not read through the org-scoped properties_select and the restrictive require_aal2/,
    ],
    [
      "properties without require_aal2",
      "drop policy require_aal2 on public.properties",
      /^0153 aborted: public\.properties is not read through the org-scoped properties_select and the restrictive require_aal2/,
    ],
  ];
  for (const [label, setup, refusal] of refusals) {
    it(`the preflight refuses ${label}, changing nothing`, async () => {
      await rolledBack(async () => {
        await o.query(REVERT_0153_SQL);
        await o.query(setup);
        const before = await fn();
        await o.query("savepoint before_0153");
        const e = await failure(o.query(readMigration0153()));
        expect(e?.message ?? "(it applied)").toMatch(refusal);
        await o.query("rollback to savepoint before_0153");
        expect(await fn()).toEqual(before);
      });
    });
  }

  it("a property write lock in another session makes its probe wait at most lock_timeout, then abort (55P03)", async () => {
    await a.query("begin");
    await a.query("lock table public.properties in share mode"); // what a CREATE INDEX holds
    try {
      await rolledBack(async () => {
        const t0 = Date.now();
        const e = await failure(o.query(readMigration0153()));
        const waited = Date.now() - t0;
        expect(e?.code, e?.message).toBe("55P03");
        expect(waited).toBeGreaterThanOrEqual(4_500);
        expect(waited).toBeLessThan(15_000);
      });
    } finally {
      await a.query("rollback");
    }
    expect((await fn()).md5).toBe(BODY_MD5_0153);
  });

  it("is replay-safe: run twice in one transaction, one function, its body and its grants", async () => {
    await rolledBack(async (notices) => {
      await o.query(readMigration0153());
      await o.query(readMigration0153());
      const { rows } = await o.query<{ c: number }>(
        "select count(*)::int as c from pg_proc where proname = 'property_inventory_counts' and pronamespace = 'public'::regnamespace",
      );
      expect(rows[0]!.c).toBe(1);
      expect(await fn()).toEqual({ md5: BODY_MD5_0153, secdef: false, grants: "false/true/true" });
      expect(notices.filter((m) => m.startsWith("0153: postflight passed"))).toHaveLength(2);
    });
  });

  /** Rewrite the body AND both pins, so the shape check passes and only the probe can catch it. */
  const repinned = (sql: string, from: string, to: string) => {
    const body = BODY(sql);
    expect(body).toContain(from);
    const next = body.replace(from, () => to);
    const md5 = createHash("md5").update(next).digest("hex");
    return sql.replace(body, () => next).replaceAll(BODY_MD5_0153, md5);
  };
  const mutants: Array<[string, (sql: string) => string, RegExp]> = [
    [
      "a body that counts withdrawn rows (0093's predicate)",
      (s) => repinned(s, "\n     and p.status <> 'withdrawn'", ""),
      /^0153 postflight: public\.property_inventory_counts\(\) counted the probe as "[^"]*standalone\/withdrawn=[1-9]\d*[^"]*" — expected standalone\/available=1 project\/available=1 unit\/available=2/,
    ],
    [
      "a body that counts archived rows",
      (s) => repinned(s, "where p.visibility <> 'archived'\n     and ", "where "),
      // the probe's archived unit (and every other archived available unit) on top of its two
      /^0153 postflight: public\.property_inventory_counts\(\) counted the probe as "[^"]*unit\/available=([3-9]|\d{2,})[^"]*"/,
    ],
    [
      "a body that leaves the units out",
      (s) => repinned(s, "count(*) as n", "count(*) filter (where p.kind <> 'unit') as n"),
      /^0153 postflight: public\.property_inventory_counts\(\) counted the probe as "(?!standalone\/available=1 project\/available=1 unit\/available=2")[^"]*"/,
    ],
    [
      "a body the postflight does not pin",
      (s) => s.replace("   order by p.kind, p.status\n$fn$;", () => "   order by p.status, p.kind\n$fn$;"),
      /^0153 postflight: public\.property_inventory_counts\(\) is not the function this file wrote/,
    ],
    [
      "a SECURITY DEFINER",
      (s) => s.replace("stable\nsecurity invoker\n", "stable\nsecurity definer\n"),
      /^0153 postflight: public\.property_inventory_counts\(\) is not the function this file wrote/,
    ],
    [
      "a VOLATILE function",
      (s) => s.replace("language sql\nstable\n", "language sql\nvolatile\n"),
      /^0153 postflight: public\.property_inventory_counts\(\) is not the function this file wrote/,
    ],
    [
      "no revoke (PUBLIC — and so anon — keeps EXECUTE)",
      (s) => s.replace("revoke execute on function public.property_inventory_counts() from public, anon;\n", ""),
      /^0153 postflight: the grants on public\.property_inventory_counts\(\) are not authenticated \+ service_role, without anon or PUBLIC$/,
    ],
    [
      "no grant to service_role",
      (s) => s.replace("to authenticated, service_role;", "to authenticated;"),
      /^0153 postflight: the grants on public\.property_inventory_counts\(\) are not authenticated \+ service_role, without anon or PUBLIC$/,
    ],
  ];
  for (const [label, mutate, refusal] of mutants) {
    it(`the postflight refuses ${label}`, async () => {
      const sql = readMigration0153();
      const bad = mutate(sql);
      expect(bad, "the mutation installed").not.toBe(sql);
      await rolledBack(async () => {
        await o.query(REVERT_0153_SQL);
        await o.query("savepoint before_0153");
        const e = await failure(o.query(bad));
        expect(e?.message ?? "(it applied)").toMatch(refusal);
        await o.query("rollback to savepoint before_0153");
        expect((await fn()).md5).toBeNull();
      });
    });
  }

  it("the rollback recipe removes the function and nothing else; the file then applies again", async () => {
    await rolledBack(async () => {
      const stats = async () =>
        (await o.query<{ md5: string }>(
          "select md5(replace(prosrc, chr(13), '')) as md5 from pg_proc where oid = 'public.admin_dashboard_stats(timestamptz, timestamptz, timestamptz)'::regprocedure",
        )).rows[0]!.md5;
      const statsBefore = await stats();
      await o.query(REVERT_0153_SQL);
      expect((await fn()).md5).toBeNull();
      expect(await stats()).toBe(statsBefore); // admin_dashboard_stats was never touched
      await o.query(readMigration0153());
      expect((await fn()).md5).toBe(BODY_MD5_0153);
    });
  });

  it("the restore pack's 0153 row and grants row pass now, and read a lost, definer or widened function as drift", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const start = "  select 'INTEGRITY: the dashboard''s inventory counts the properties list''s default scope";
    const from = pack.indexOf(start);
    expect(from, "the pack carries the 0153 row").toBeGreaterThan(0);
    const row = `select * from (${pack.slice(from, pack.indexOf("\n  union all\n", from))}) r(check_name, expected, actual)`;
    const actual = async () => (await o.query<{ expected: string; actual: string }>(row)).rows[0]!;
    expect(await actual()).toMatchObject({ expected: "true", actual: "true" });
    // the grants row, as the pack pins it, against the database's grants
    const grantsRow = pack.match(/\('property_inventory_counts',\s*(true|false),\s*(true|false),\s*(true|false),\s*(true|false)\)/);
    expect(grantsRow, "the pack pins the function's grants").not.toBeNull();
    expect(grantsRow!.slice(1).join("/")).toBe(`false/${(await fn()).grants}`);

    await rolledBack(async () => {
      await o.query(REVERT_0153_SQL);
      expect((await actual()).actual).toBe("false");
    });
    await rolledBack(async () => {
      await o.query("alter function public.property_inventory_counts() security definer");
      expect((await actual()).actual).toBe("false");
    });
    await rolledBack(async () => {
      await o.query(REVERT_0153_SQL);
      await o.query(
        SAME_SHAPE("select p.kind, p.status, count(*) from public.properties p where p.visibility <> 'archived' group by p.kind, p.status order by p.kind, p.status"),
      );
      expect((await actual()).actual).toBe("false");
    });
  });
});
