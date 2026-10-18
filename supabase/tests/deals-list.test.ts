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
import { parseCsvTable } from "../../scripts/import/_shared.mts";

/**
 * The /deals register (F05), through the REAL page server component and the
 * REAL /deals/export route, against a REAL PostgREST with each session's RLS
 * and aal2 token.
 *
 * Before F05 the only list of deals was the pipeline board: open deals, and
 * won/lost ones for 30 days (DECISIONS T-audit-pipeline item 4). A deal closed
 * longer ago was reachable only through a contact, a lead or a task that
 * happened to link it; its CSV could be neither filtered nor linked.
 *
 * WHAT IT PINS (each walk prints one `[evidence]` line):
 *   1. walked page by page — most records sharing ONE created_at, a slice a
 *      day either side — the register shows exactly the authorised matching
 *      set in `created_at desc, id` order, each record once, every page its
 *      exact 25-row slice; the request orders by `created_at` then `id`;
 *      the header total and page count are exact; Previous/Next keep every
 *      filter; a page past the end is empty, says so, and STILL states the
 *      true total (PostgREST's range answer carries no count — it is asked
 *      for, never assumed to be 0);
 *   2. RLS, not the page, decides the rows: an admin and a listing manager
 *      walk the whole organisation; an agent only the deals they own or
 *      created; a second agent none of them; another organisation's deals —
 *      newer than all of these, so a leak would land on page one — never
 *      appear, and its admin walks only its own;
 *   3. each filter keeps its meaning past page one: status (open / won / lost
 *      / closed), type, agent, property, contact (buyer OR seller), a title
 *      search, and the closed range in CYPRUS days — checked against an
 *      oracle computed in SQL with `at time zone 'Asia/Nicosia'`, not with the
 *      helper under test; a deal closed 00:30 Cyprus time on 1 April (21:30Z
 *      on 31 March) is April's, one closed 23:59:59 Cyprus time on 31 March is
 *      March's; a LOST deal with a stray `won_at` inside the range is not
 *      matched by it; several `or()` filters at once are ANDed;
 *   4. junk in the URL (an unknown status, a malformed id, an impossible day)
 *      is no filter — never an error page;
 *   5. the filter bar is handed the chosen contact by name, and a chosen id
 *      the session cannot read as "not found", still clearable;
 *   6. the CSV of the same filters lists the screen's records in the screen's
 *      order; its audit line records the filters' shape, never the search
 *      text; a filtered export past PostgREST's max_rows (1000) is complete.
 *
 * NOT PINNED: a record created, deleted or re-dated BETWEEN two page loads can
 * still shift a page boundary — every page is its own request.
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included
 * (the export writes `exported` audit lines).
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const ORGS = [ORG, OTHER_ORG];
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `deals-list-${RUN}`;

const PAGE_SIZE = 25;
/** ORG's deals: six pages, the last one short. */
const N = 140;
/** OTHER_ORG's deals: more than one PostgREST response (max_rows 1000) holds. */
const OTHER_N = 1050;
const TIED = "2026-01-01 09:00:00+00";
const OTHER_AT = "2026-06-01 09:00:00+00";
const VARIED = (g: string, at: string) =>
  `(${at}::timestamptz + case when ${g} % 7 = 0 then interval '1 day' when ${g} % 11 = 0 then interval '-1 day' else interval '0' end)`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

import DealsPage from "@/app/(app)/deals/page";
import { GET as dealsExport } from "@/app/(app)/deals/export/route";
import { DealsFilters } from "@/components/features/deals/deals-filters";
import { DealsTable, type DealListItem } from "@/components/features/deals/deals-table";
import { Pager } from "@/components/features/shared/pager";

type Params = Record<string, string>;

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
// Reading what the page returned — its element tree, no rendering
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

const hrefOf = (el: Element) => (typeof el.props.href === "string" ? el.props.href : null);
const linkTo = (els: Element[], label: string, rel: string) =>
  els.find((e) => hrefOf(e) !== null && (e.props.rel === rel || textOf(e) === label));

interface Screen {
  ids: string[];
  rows: DealListItem[];
  /** the header's "N deals" / "N matching deals" */
  total: number;
  /** the Pager's own total, when it renders */
  pagerTotal: number | null;
  pageCount: number;
  next: string | null;
  prev: string | null;
  text: string;
  filterBar: Record<string, unknown>;
}

function read(root: ReactNode): Screen {
  const els = [...walk(root)];
  const text = textOf(root);
  const header = els.find((e) => e.type === "p" && /^\d+ (?:matching )?deals?$/.test(textOf(e)));
  if (!header) throw new Error(`the page stated no total: ${text.slice(0, 300)}`);
  const table = els.find((e) => e.type === DealsTable);
  const rows = table ? (table.props.rows as DealListItem[]) : [];
  const bar = els.find((e) => e.type === DealsFilters);
  if (!bar) throw new Error("the page rendered no filter bar");
  const pager = els.find((e) => e.type === Pager);
  let paging: Pick<Screen, "pagerTotal" | "pageCount" | "next" | "prev"> = {
    pagerTotal: null,
    pageCount: 1,
    next: null,
    prev: null,
  };
  if (pager) {
    const props = pager.props as Parameters<typeof Pager>[0];
    // a plain function of its props (no hooks): calling it yields the links it renders
    const links = [...walk(Pager(props))];
    const next = linkTo(links, "Next", "next");
    const prev = linkTo(links, "Previous", "prev");
    paging = {
      pagerTotal: props.total,
      pageCount: props.pageCount,
      next: next ? hrefOf(next) : null,
      prev: prev ? hrefOf(prev) : null,
    };
  }
  return {
    ids: rows.map((r) => r.id),
    rows,
    total: Number(/^(\d+)/.exec(textOf(header))![1]),
    ...paging,
    text,
    filterBar: bar.props,
  };
}

async function show(user: TestUser, params: Params): Promise<Screen> {
  const { client } = await session(user);
  const root = await ctx.als.run(client, () => DealsPage({ searchParams: Promise.resolve({ ...params }) }));
  return read(root);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let manager: TestUser;
let agent: TestUser;
let agent2: TestUser;
let outsider: TestUser;
const userIds: string[] = [];
let BUYER = "";
let PROPERTY = "";
let FOREIGN_PROPERTY = "";

async function ids(sql: string, params: unknown[]): Promise<string[]> {
  const { rows } = await pg.query<{ v: string }>(sql, params);
  return rows.map((r) => r.v);
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();

  await ensureTestOrg(svc, ORG, `Deals list ${RUN}`, SLUG);
  await ensureTestOrg(svc, OTHER_ORG, `Deals list other ${RUN}`, `${SLUG}-other`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s; each id is
  // kept as soon as it exists, so a later failure still cleans it up
  admin = await createTestUser(svc, `dlr-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  manager = await createTestUser(svc, `dlr-lm-${RUN}@test.local`, "listing_manager", ORG);
  userIds.push(manager.id);
  agent = await createTestUser(svc, `dlr-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);
  agent2 = await createTestUser(svc, `dlr-agent2-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent2.id);
  outsider = await createTestUser(svc, `dlr-other-${RUN}@test.local`, "admin", OTHER_ORG);
  userIds.push(outsider.id);

  BUYER = (
    await pg.query<{ id: string }>(
      "insert into contacts (org_id, first_name) values ($1, $2) returning id::text as id",
      [ORG, `DLBuyer${TAG}`],
    )
  ).rows[0]!.id;
  PROPERTY = (
    await pg.query<{ id: string }>(
      "insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id::text as id",
      [ORG, `DLP${TAG}`],
    )
  ).rows[0]!.id;
  FOREIGN_PROPERTY = (
    await pg.query<{ id: string }>(
      "insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id::text as id",
      [OTHER_ORG, `DLX${TAG}`],
    )
  ).rows[0]!.id;

  const stage = (type: string, kind: "open" | "won" | "lost") =>
    `(select id from deal_stages s where s.org_id = $1 and s.deal_type = ${type}
        and ${kind === "won" ? "s.is_won" : kind === "lost" ? "s.is_lost" : "not s.is_won and not s.is_lost"}
      order by s.sort_order limit 1)`;
  // ORG: N deals, most created at ONE instant. One in five rental. One in four
  // won, one in four lost — closed on dates spread across 2026 — the rest open.
  // The agent owns one in six and created one in ten more; one in seven has no
  // agent. The buyer contact is the buyer of one in nine and the seller of one
  // in thirteen; the property is on one in eight.
  await pg.query(
    `insert into deals (org_id, deal_type, stage_id, title, status, expected_value, final_value, won_at, lost_at,
                        agent_id, created_by, buyer_contact_id, seller_contact_id, property_id, created_at)
     select $1::uuid, t.dt::deal_type,
            case when g % 4 = 0 then ${stage("t.dt::deal_type", "won")}
                 when g % 4 = 1 then ${stage("t.dt::deal_type", "lost")}
                 else ${stage("t.dt::deal_type", "open")} end,
            format('DL%s-%s', $2::text, lpad(g::text, 5, '0')),
            (case when g % 4 = 0 then 'won' when g % 4 = 1 then 'lost' else 'open' end)::deal_status,
            (g * 1000)::numeric(14,2),
            case when g % 8 = 0 then (g * 900)::numeric(14,2) end,
            case when g % 4 = 0 then '2026-01-10 10:00+00'::timestamptz + (g % 12) * interval '20 days' end,
            case when g % 4 = 1 then '2026-01-12 10:00+00'::timestamptz + (g % 12) * interval '20 days' end,
            case when g % 6 = 0 then $3::uuid when g % 7 = 0 then null else $4::uuid end,
            case when g % 10 = 3 then $3::uuid else $4::uuid end,
            case when g % 9 = 0 then $5::uuid end,
            case when g % 13 = 0 then $5::uuid end,
            case when g % 8 = 0 then $6::uuid end,
            ${VARIED("g", "$7")}
       from generate_series(1, $8::int) g
       cross join lateral (select case when g % 5 = 0 then 'rental' else 'sale' end as dt) t`,
    [ORG, TAG, agent.id, admin.id, BUYER, PROPERTY, TIED, N],
  );
  // the Cyprus-day edges and a stray stamp, all tied with the rest
  await pg.query(
    `insert into deals (org_id, deal_type, stage_id, title, status, won_at, lost_at, agent_id, created_by, created_at) values
       ($1, 'sale', ${stage("'sale'", "lost")}, $2 || '-edge-in', 'lost', null, '2026-03-31 21:30:00+00', $3, $3, $4),
       ($1, 'sale', ${stage("'sale'", "won")}, $2 || '-edge-out', 'won', '2026-03-31 20:59:59+00', null, $3, $3, $4),
       ($1, 'sale', ${stage("'sale'", "lost")}, $2 || '-stray', 'lost', '2026-04-10 10:00:00+00', '2025-06-01 10:00:00+00', $3, $3, $4)`,
    [ORG, `DLB${TAG}`, admin.id, TIED],
  );
  // OTHER_ORG: newer than everything above, all lost in April 2026 — a leak
  // into ORG's walks (and its closed-range walks) would land on page one
  await pg.query(
    `insert into deals (org_id, deal_type, stage_id, title, status, lost_at, agent_id, created_by, created_at)
     select $1::uuid, 'sale', ${stage("'sale'", "lost")}, format('DX%s-%s', $2::text, lpad(g::text, 5, '0')), 'lost',
            '2026-04-05 10:00+00'::timestamptz + (g % 20) * interval '1 hour', $3::uuid, $3::uuid, ${VARIED("g", "$4")}
       from generate_series(1, $5::int) g`,
    [OTHER_ORG, TAG, outsider.id, OTHER_AT, OTHER_N],
  );
}, 600_000);

afterAll(async () => {
  await pg.query("delete from deals where org_id = any($1::uuid[])", [ORGS]);
  await pg.query("delete from properties where org_id = any($1::uuid[])", [ORGS]);
  await pg.query("delete from contacts where org_id = any($1::uuid[])", [ORGS]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
  await pg.query("delete from organizations where id = any($1::uuid[])", [ORGS]);
  await pg.end();
}, 600_000);

// ---------------------------------------------------------------------------
// The oracle: the authorised matching set, computed in SQL — the Cyprus day
// by Postgres' own `at time zone`, not by the helper under test
// ---------------------------------------------------------------------------
interface Want {
  type?: string;
  status?: "open" | "won" | "lost" | "closed";
  agent?: string;
  property?: string;
  contact?: string;
  from?: string;
  to?: string;
  q?: string;
  /** an agent's RLS: deals they own or created */
  viewer?: string;
}

const EXPECTED = (org: string, w: Want = {}) =>
  ids(
    `select d.id::text as v from deals d
      where d.org_id = $1
        and ($2::text is null or d.deal_type::text = $2)
        and ($3::text is null or case when $3 = 'closed' then d.status in ('won', 'lost') else d.status::text = $3 end)
        and ($4::uuid is null or d.agent_id = $4)
        and ($5::uuid is null or d.property_id = $5)
        and ($6::uuid is null or d.buyer_contact_id = $6 or d.seller_contact_id = $6)
        and (($7::date is null and $8::date is null)
             or (d.status = 'won'
                 and ($7::date is null or d.won_at >= ($7::date)::timestamp at time zone 'Asia/Nicosia')
                 and ($8::date is null or d.won_at < ($8::date + 1)::timestamp at time zone 'Asia/Nicosia'))
             or (d.status = 'lost'
                 and ($7::date is null or d.lost_at >= ($7::date)::timestamp at time zone 'Asia/Nicosia')
                 and ($8::date is null or d.lost_at < ($8::date + 1)::timestamp at time zone 'Asia/Nicosia')))
        and ($9::text is null or d.title ilike '%' || $9 || '%')
        and ($10::uuid is null or d.agent_id = $10 or d.created_by = $10)
      order by d.created_at desc, d.id`,
    [
      org,
      w.type ?? null,
      w.status ?? null,
      w.agent ?? null,
      w.property ?? null,
      w.contact ?? null,
      w.from ?? null,
      w.to ?? null,
      w.q ?? null,
      w.viewer ?? null,
    ],
  );

const titleOf = async (title: string) =>
  (await pg.query<{ id: string }>("select id::text as id from deals where title = $1", [title])).rows[0]!.id;

// ---------------------------------------------------------------------------
// Walking the register: page 1, then Next until the last page
// ---------------------------------------------------------------------------
interface Walk {
  pages: Screen[];
  ids: string[];
  beyond: Screen;
  again: Screen;
  requests: { order: string | null; offset: number }[];
}

async function browse(user: TestUser, filters: Params): Promise<Walk> {
  const { gets } = await session(user);
  gets.length = 0;
  const pages = [await show(user, filters)];
  for (let p = 2; p <= pages[0]!.pageCount; p++) pages.push(await show(user, { ...filters, page: String(p) }));
  const beyond = await show(user, { ...filters, page: String(pages[0]!.pageCount + 1) });
  const mid = Math.max(1, Math.ceil(pages[0]!.pageCount / 2));
  const again = await show(user, mid === 1 ? filters : { ...filters, page: String(mid) });
  const requests = gets
    .map((u) => new URL(u))
    .filter((u) => u.pathname === "/rest/v1/deals" && u.searchParams.get("limit") === String(PAGE_SIZE))
    .map((u) => ({ order: u.searchParams.get("order"), offset: Number(u.searchParams.get("offset") ?? 0) }));
  return { pages, ids: pages.flatMap((s) => s.ids), beyond, again, requests };
}

function linkParams(href: string | null): Params | null {
  if (href === null) return null;
  return Object.fromEntries(new URLSearchParams(href.replace(/^\?/, "")).entries());
}

async function expectWalk(
  label: string,
  user: TestUser,
  filters: Params,
  expected: string[],
  foreign: string[] = [],
): Promise<Walk> {
  const w = await browse(user, filters);
  const seen = new Set(w.ids);
  const want = new Set(expected);
  const repeated = w.ids.length - seen.size;
  const missing = expected.filter((id) => !seen.has(id));
  const extra = [...seen].filter((id) => !want.has(id));
  const leaked = w.ids.filter((id) => foreign.includes(id));
  const inOrder = JSON.stringify(w.ids) === JSON.stringify(expected);
  const orders = [...new Set(w.requests.map((r) => r.order))];
  console.log(
    `[evidence] deals ${label}: stated ${w.pages[0]!.total} (database ${expected.length}), pages ${w.pages.length},` +
      ` shown ${w.ids.length}, repeated ${repeated}, missing ${missing.length}, not in scope ${extra.length},` +
      ` other org ${leaked.length}, database order ${inOrder ? "yes" : "NO"}, order=${orders.join("|")},` +
      ` past the end states ${w.beyond.total}`,
  );

  const pageCount = Math.max(1, Math.ceil(expected.length / PAGE_SIZE));
  expect.soft(w.pages[0]!.total, `${label}: the header total`).toBe(expected.length);
  expect.soft(w.pages[0]!.pageCount, `${label}: the page count`).toBe(pageCount);
  expect.soft(repeated, `${label}: records on more than one page`).toBe(0);
  expect.soft(missing, `${label}: records on no page`).toEqual([]);
  expect.soft(extra, `${label}: records outside the scope`).toEqual([]);
  expect.soft(leaked, `${label}: another organisation's records`).toEqual([]);
  w.pages.forEach((s, i) => {
    expect.soft(s.ids, `${label}: page ${i + 1} is exactly its slice`).toEqual(
      expected.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE),
    );
    expect.soft(s.total, `${label}: page ${i + 1} states the same total`).toBe(expected.length);
    if (expected.length > 0) expect.soft(s.pagerTotal, `${label}: page ${i + 1} pager total`).toBe(expected.length);
  });
  expect.soft(w.ids, `${label}: the walk is the database's order`).toEqual(expected);
  if (expected.length > 0) {
    expect.soft(orders, `${label}: the page orders by created_at, then id`).toEqual(["created_at.desc,id.asc"]);
    expect.soft(
      w.requests.slice(0, w.pages.length).map((r) => r.offset),
      `${label}: offsets step by the page size`,
    ).toEqual(w.pages.map((_, i) => i * PAGE_SIZE));
  }

  // past the end: nothing, said plainly — and the total is still the truth, not 0
  expect.soft(w.beyond.ids, `${label}: the page past the end`).toEqual([]);
  expect.soft(w.beyond.total, `${label}: the page past the end still states the total`).toBe(expected.length);
  if (expected.length > 0) expect.soft(w.beyond.text).toMatch(/Nothing on this page\./);
  const mid = Math.max(1, Math.ceil(pageCount / 2));
  expect.soft(w.again.ids, `${label}: page ${mid} asked for again`).toEqual(w.pages[mid - 1]!.ids);

  // Previous / Next: the neighbouring page, every filter kept
  w.pages.forEach((s, i) => {
    const p = i + 1;
    const next = linkParams(s.next);
    const prev = linkParams(s.prev);
    if (p < w.pages.length) expect.soft(next, `${label}: page ${p} Next`).toEqual({ ...filters, page: String(p + 1) });
    else expect.soft(next, `${label}: no Next on the last page`).toBeNull();
    if (p === 1) expect.soft(prev, `${label}: no Previous on page 1`).toBeNull();
    else {
      const { page: prevPage, ...rest } = prev ?? {};
      expect.soft(rest, `${label}: page ${p} Previous keeps the filters`).toEqual(filters);
      expect.soft(prevPage ?? "1", `${label}: page ${p} Previous`).toBe(String(p - 1));
    }
  });
  return w;
}

// ---------------------------------------------------------------------------
// The CSV of the same filters, through the real export route
// ---------------------------------------------------------------------------
async function exportAs(user: TestUser, filters: Params) {
  const url = new URL("http://localhost/deals/export");
  for (const [k, v] of Object.entries(filters)) url.searchParams.set(k, v);
  const s = await session(user);
  s.gets.length = 0;
  const res = await ctx.als.run(s.client, () => dealsExport(new NextRequest(url)));
  const body = await res.text();
  const dealGets = s.gets.filter((u) => new URL(u).pathname === "/rest/v1/deals");
  return { res, body, dealGets, rows: res.status === 200 ? parseCsvTable(body).rows : [] };
}

async function titlesOf(idList: string[]): Promise<string[]> {
  const { rows } = await pg.query<{ id: string; title: string }>(
    "select id::text as id, title from deals where id = any($1::uuid[])",
    [idList],
  );
  const title = new Map(rows.map((r) => [r.id, r.title]));
  return idList.map((id) => title.get(id) ?? `?${id}`);
}

async function lastExportPayload(org: string) {
  const { rows } = await pg.query<{ payload: Record<string, unknown> }>(
    `select payload from events where org_id = $1 and entity_type = 'export' and event_type = 'exported'
      order by occurred_at desc, id desc limit 1`,
    [org],
  );
  return rows[0]?.payload ?? null;
}

// ---------------------------------------------------------------------------
describe("the deals register", () => {
  it("the fixture ties most deals across page boundaries and spreads the closes (measured)", async () => {
    const { rows } = await pg.query<{ at: string; c: string }>(
      "select created_at::text as at, count(*) as c from deals where org_id = $1 group by created_at order by 1",
      [ORG],
    );
    console.log(`[evidence] deals created_at: ${rows.map((r) => `${r.at.slice(0, 10)}×${r.c}`).join(", ")}`);
    expect(rows, "three created_at groups — a day before, the tie, a day after").toHaveLength(3);
    expect(Number(rows.find((r) => r.at.startsWith("2026-01-01"))!.c)).toBeGreaterThan(3 * PAGE_SIZE);
    const { rows: mix } = await pg.query<{ status: string; deal_type: string; c: string }>(
      "select status::text, deal_type::text, count(*) as c from deals where org_id = $1 group by 1, 2 order by 1, 2",
      [ORG],
    );
    console.log(`[evidence] deals status×type: ${mix.map((r) => `${r.status}/${r.deal_type}×${r.c}`).join(", ")}`);
    expect(mix.length).toBe(6);
  });

  it("admin and listing manager walk the whole organisation; another organisation's deals never appear", async () => {
    const all = await EXPECTED(ORG);
    const foreign = await EXPECTED(OTHER_ORG);
    expect(all).toHaveLength(N + 3);
    await expectWalk("all/admin", admin, {}, all, foreign);
    await expectWalk("all/listing manager", manager, {}, all, foreign);
  }, 180_000);

  it("an agent walks only the deals they own or created; a second agent sees none of them", async () => {
    const own = await EXPECTED(ORG, { viewer: agent.id });
    const { rows } = await pg.query<{ owned: string; created: string }>(
      `select count(*) filter (where agent_id = $2) as owned,
              count(*) filter (where created_by = $2 and agent_id is distinct from $2) as created
         from deals where org_id = $1`,
      [ORG, agent.id],
    );
    console.log(`[evidence] the agent's deals: owned ${rows[0]!.owned}, created (not owned) ${rows[0]!.created}`);
    expect(Number(rows[0]!.owned)).toBeGreaterThan(0);
    expect(Number(rows[0]!.created)).toBeGreaterThan(0);
    const everyone = await EXPECTED(ORG);
    const others = everyone.filter((id) => !own.includes(id));
    await expectWalk("all/agent", agent, {}, own, others);
    await expectWalk("closed/agent", agent, { status: "closed" }, await EXPECTED(ORG, { status: "closed", viewer: agent.id }), others);

    const none = await show(agent2, {});
    console.log(`[evidence] deals second agent: stated ${none.total}, rows ${none.ids.length}`);
    expect(none.ids).toEqual([]);
    expect(none.total).toBe(0);
    expect(none.text).toMatch(/No deals yet — a deal opens when a lead is converted\./);
    const filtered = await show(agent2, { status: "lost" });
    expect(filtered.ids).toEqual([]);
    expect(filtered.text).toMatch(/No deals match these filters\./);
  }, 180_000);

  it("status, type, agent, property, contact and a title search keep their meaning past page one", async () => {
    for (const status of ["open", "won", "lost", "closed"] as const) {
      await expectWalk(`status=${status}`, admin, { status }, await EXPECTED(ORG, { status }));
    }
    await expectWalk("type=rental", admin, { type: "rental" }, await EXPECTED(ORG, { type: "rental" }));
    await expectWalk("agent", admin, { agent: agent.id }, await EXPECTED(ORG, { agent: agent.id }));
    await expectWalk("property", admin, { property: PROPERTY }, await EXPECTED(ORG, { property: PROPERTY }));
    const asParty = await EXPECTED(ORG, { contact: BUYER });
    const { rows } = await pg.query<{ buyer: string; seller: string }>(
      `select count(*) filter (where buyer_contact_id = $2) as buyer, count(*) filter (where seller_contact_id = $2) as seller
         from deals where org_id = $1`,
      [ORG, BUYER],
    );
    console.log(`[evidence] the contact: buyer on ${rows[0]!.buyer}, seller on ${rows[0]!.seller}, either on ${asParty.length}`);
    expect(Number(rows[0]!.buyer)).toBeGreaterThan(0);
    expect(Number(rows[0]!.seller)).toBeGreaterThan(0);
    await expectWalk("contact (buyer or seller)", admin, { contact: BUYER }, asParty);
    const found = await EXPECTED(ORG, { q: `DL${TAG}-000` });
    expect(found, "the search matches 99 deals: four pages").toHaveLength(99);
    await expectWalk("q (title search)", admin, { q: `DL${TAG}-000` }, found);
  }, 240_000);

  it("the closed range is Cyprus days, both ends included; a lost deal's stray won_at does not match it", async () => {
    const edgeIn = await titleOf(`DLB${TAG}-edge-in`);
    const edgeOut = await titleOf(`DLB${TAG}-edge-out`);
    const stray = await titleOf(`DLB${TAG}-stray`);
    const foreign = await EXPECTED(OTHER_ORG);

    const april = await EXPECTED(ORG, { from: "2026-04-01", to: "2026-04-30" });
    const w = await expectWalk("closed April", admin, { closed_from: "2026-04-01", closed_to: "2026-04-30" }, april, foreign);
    expect(w.ids, "lost at 00:30 Cyprus time on 1 April (21:30Z on 31 March) is April's").toContain(edgeIn);
    expect(w.ids, "won at 23:59:59 Cyprus time on 31 March is March's").not.toContain(edgeOut);
    expect(w.ids, "a lost deal is matched by its lost_at, never a stray won_at").not.toContain(stray);

    const upToMarch = await EXPECTED(ORG, { to: "2026-03-31" });
    const m = await expectWalk("closed to 31 March", admin, { closed_to: "2026-03-31" }, upToMarch, foreign);
    expect(m.ids).toContain(edgeOut);
    expect(m.ids).not.toContain(edgeIn);
    // the stray deal's own close (lost_at, June 2025) IS before 31 March 2026
    expect(m.ids).toContain(stray);

    await expectWalk("closed from 1 June", admin, { closed_from: "2026-06-01" }, await EXPECTED(ORG, { from: "2026-06-01" }), foreign);
    // a range means closed: an open deal never matches, whatever the status filter says
    const open = await show(admin, { status: "open", closed_from: "2026-01-01" });
    expect(open.ids).toEqual([]);
    expect(open.total).toBe(0);
  }, 240_000);

  it("several or() filters at once are ANDed", async () => {
    const want: Want = { status: "lost", contact: BUYER, from: "2026-02-01", q: TAG };
    const expected = await EXPECTED(ORG, want);
    const narrower = await EXPECTED(ORG, { contact: BUYER });
    console.log(`[evidence] combined: ${expected.length} of the contact's ${narrower.length}`);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(narrower.length);
    await expectWalk("lost+contact+from+q", admin, { status: "lost", contact: BUYER, closed_from: "2026-02-01", q: TAG }, expected);
  }, 120_000);

  it("junk in the URL is no filter, never an error page", async () => {
    const s = await show(admin, {
      status: "deleted",
      type: "Sale",
      contact: "not-a-uuid",
      property: `${PROPERTY},owner_contact_id.not.is.null`,
      closed_from: "2026-02-30",
      closed_to: "yesterday",
    });
    const all = await EXPECTED(ORG);
    expect(s.total).toBe(all.length);
    expect(s.ids).toEqual(all.slice(0, PAGE_SIZE));
    expect(s.filterBar.values).toEqual({});
  }, 60_000);

  it("the filter bar is handed the chosen contact by name, and an id this session cannot read as 'not found'", async () => {
    const s = await show(admin, { contact: BUYER });
    expect(s.filterBar.contact).toMatchObject({ id: BUYER, label: `DLBuyer${TAG}` });
    expect(s.filterBar.property).toBeNull();
    const p = await show(admin, { property: PROPERTY });
    expect(p.filterBar.property).toMatchObject({ id: PROPERTY, label: `DLP${TAG}`, sublabel: `DLP${TAG}` });
    // another organisation's listing: RLS withholds it — it still filters (nothing) and can be cleared
    const f = await show(admin, { property: FOREIGN_PROPERTY });
    expect(f.filterBar.property).toEqual({ id: FOREIGN_PROPERTY, label: "Property not found", sublabel: null });
    expect(f.ids).toEqual([]);
    expect(f.text).toMatch(/No deals match these filters\./);
  }, 60_000);

  it("rows carry the deal's link, its figure with its basis, and its close date", async () => {
    const s = await show(admin, { status: "won" });
    const row = s.rows[0]!;
    const { rows } = await pg.query<{ expected_value: number | null; final_value: number | null; won_ms: number }>(
      `select expected_value::float8 as expected_value, final_value::float8 as final_value,
              (extract(epoch from won_at) * 1000)::float8 as won_ms
         from deals where id = $1`,
      [row.id],
    );
    const d = rows[0]!;
    expect(row.value).toBe(d.final_value ?? d.expected_value);
    expect(row.valueIsFinal).toBe(d.final_value !== null);
    expect(row.closedAt).not.toBeNull();
    expect(new Date(row.closedAt!).getTime()).toBe(d.won_ms);
    const open = (await show(admin, { status: "open" })).rows[0]!;
    expect(open.closedAt).toBeNull();
    expect(open.valueIsFinal).toBe(false);
  }, 60_000);

  it("the CSV of the same filters lists the screen's records in the screen's order; its audit line holds no search text", async () => {
    const filters = { status: "closed", q: `DL${TAG}` };
    const w = await expectWalk("closed+q/admin (for the CSV)", admin, filters, await EXPECTED(ORG, { status: "closed", q: `DL${TAG}` }));
    const csv = await exportAs(admin, filters);
    expect(csv.res.status, csv.body.slice(0, 200)).toBe(200);
    const screen = await titlesOf(w.ids);
    const file = csv.rows.map((r) => r.Title ?? "");
    console.log(`[evidence] deals screen vs CSV: screen ${screen.length}, csv ${file.length}, same order ${JSON.stringify(screen) === JSON.stringify(file) ? "yes" : "NO"}`);
    expect(file).toEqual(screen);

    const payload = await lastExportPayload(ORG);
    expect(payload).toEqual({ list: "deals", count: screen.length, filters: { status: "closed", q: true } });
    expect(JSON.stringify(payload)).not.toContain(TAG);

    // the agent's file is the agent's screen
    const own = await EXPECTED(ORG, { viewer: agent.id });
    const agentCsv = await exportAs(agent, {});
    expect(agentCsv.rows.map((r) => r.Title ?? "")).toEqual(await titlesOf(own));
  }, 180_000);

  it("a filtered export past PostgREST's max_rows is complete, in order, and audited with its range", async () => {
    const filters = { status: "lost", closed_from: "2026-04-01", closed_to: "2026-04-30" };
    const expected = await EXPECTED(OTHER_ORG, { status: "lost", from: "2026-04-01", to: "2026-04-30" });
    expect(expected.length, "more than one PostgREST response holds").toBe(OTHER_N);
    const csv = await exportAs(outsider, filters);
    const offsets = csv.dealGets.map((u) => Number(new URL(u).searchParams.get("offset") ?? 0));
    console.log(`[evidence] deals export past max_rows: status ${csv.res.status}, rows ${csv.rows.length}, page offsets ${offsets.join(",")}`);
    expect(csv.res.status, csv.body.slice(0, 200)).toBe(200);
    expect(offsets.slice(0, 2)).toEqual([0, 1000]);
    expect(csv.rows.map((r) => r.Title ?? "")).toEqual(await titlesOf(expected));
    expect(await lastExportPayload(OTHER_ORG)).toEqual({
      list: "deals",
      count: OTHER_N,
      filters: { status: "lost", closed_from: "2026-04-01", closed_to: "2026-04-30" },
    });
    // and its admin walks only its own organisation
    await expectWalk("other org (search)", outsider, { q: `DX${TAG}-0000` }, await EXPECTED(OTHER_ORG, { q: `DX${TAG}-0000` }), await EXPECTED(ORG));
  }, 180_000);

  it("every row links to a deal id (never a title or a reference)", async () => {
    const s = await show(admin, {});
    for (const r of s.rows) expect(r.id).toMatch(UUID);
  });
});
