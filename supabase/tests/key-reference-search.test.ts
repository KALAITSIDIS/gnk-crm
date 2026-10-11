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
 * A search on the Keys register finds every key whose property REFERENCE
 * matches, however many references match — on the screen and in its CSV, which
 * select the same set — through the REAL page server component and the REAL
 * export route, against a REAL PostgREST, with the session's RLS and aal2 token
 * (T-key-reference-search).
 *
 * At c8fe4b7 the search first read the ids of the properties whose reference
 * matched — `.limit(200)`, no order, no overflow check — and folded them into
 * the key query as `property_id.in.(…)`. A term matching more than 200
 * references silently dropped the keys of the rest. The search now asks the
 * database in ONE request: the key's own property, embedded a second time under
 * an alias that carries the reference predicate and selects nothing, joins the
 * key's own fields in the `.or()` as `<alias>.not.is.null`. No id list, so the
 * request is the same size whatever the term matches.
 *
 * WHAT IT PINS (each walk prints one `[evidence]` line):
 *   1. a term matching 199, 200, 201 and 1,001 references, one key on each
 *      property, lists every key exactly once, in the database's order, every
 *      page its 25-row slice, the header total and page count exact; the CSV
 *      holds the same keys in the same order;
 *   2. 600 matching references with only two keys (on the properties written
 *      last): the broad term and each exact reference find them, and so does
 *      each key's own code;
 *   3. the request does not grow with the matches: one key request per page,
 *      the same length for every family's term, on the page and in the export;
 *      no property-id lookup, no `property_id` list and no id at all in a key
 *      request;
 *   4. the key code, the description and the holder's name each match on their
 *      own when the reference does not, case-insensitively; a key matching on
 *      several fields appears once; every key of a matching property appears;
 *      the property reference shown (screen and CSV) is the key's own property
 *      even when the key matched on its own fields;
 *   5. a status narrows the search; an empty or blank search is the whole
 *      register; a term matching nothing is one empty page; the header's
 *      register-wide counts never follow the search;
 *   6. an agent finds the same keys as an admin; another organisation's
 *      properties carry the SAME references and newer keys (a leak would land
 *      on page one) and never appear; that organisation's admin finds only its
 *      own;
 *   7. a property the session cannot read (a temporary restrictive policy)
 *      never makes its key findable by its reference — the reference test runs
 *      under the caller's RLS, not a privileged join;
 *   8. a failed key read is the page's load failure, never an empty or narrower
 *      register (the export's refusal is pinned in list-export-complete).
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included
 * (the CSV comparison writes `exported` audit lines).
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const ORGS = [ORG, OTHER_ORG];
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `key-reference-search-${RUN}`;

const PAGE_SIZE = 25;
const TIED = "2026-01-01 09:00:00+00";
/** The other organisation's keys are NEWER than all of ORG's: a leak would surface on page one. */
const OTHER_AT = "2026-06-01 09:00:00+00";
/** Most keys share TIED; one in 7 sorts a day later, one in 11 a day earlier. */
const VARIED = (g: string, at: string) =>
  `(${at}::timestamptz + case when ${g} % 7 = 0 then interval '1 day' when ${g} % 11 = 0 then interval '-1 day' else interval '0' end)`;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Reference families: `properties` references `KR<TAG><name>-00001…`, and keys
 * on the last `keys` of them (all of them, but for FEW). Names are one length,
 * so every family's search term is one length too.
 */
const FAMILIES = [
  { name: "F0199", properties: 199, keys: 199 },
  { name: "F0200", properties: 200, keys: 200 },
  { name: "F0201", properties: 201, keys: 201 },
  { name: "F1001", properties: 1001, keys: 1001 },
] as const;
const FEW = { name: "F0600", properties: 600, keys: 2 } as const;
const termOf = (family: string) => `KR${TAG}${family}-`;
const refOf = (family: string, n: number) => `${termOf(family)}${String(n).padStart(5, "0")}`;
const codeOf = (family: string, n: number) => `KC${TAG}-${family}-${String(n).padStart(5, "0")}`;

/** The branch fixture's search term — stored upper-case, searched lower-case. */
const ZQ = `ZQ${TAG}`;
const HIDDEN_REF = `${ZQ}-HIDDEN`;
/**
 * The temporary restrictive policy of the unreadable-property test. A FIXED
 * name, dropped before and after the file too: it has to be committed for
 * PostgREST to see it, so a run killed mid-test leaves it behind — and the next
 * run removes it. It names this run's organisation, so a leftover hides nothing
 * of anyone else's.
 */
const HIDE_POLICY = "zz_key_reference_search_hide";

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

import KeysPage from "@/app/(app)/keys/page";
import { GET as keysExport } from "@/app/(app)/keys/export/route";
import { KeysRegister, type KeyRegisterRow } from "@/components/features/keys/keys-register";
import { Pager } from "@/components/features/shared/pager";

type Params = Record<string, string>;

// ---------------------------------------------------------------------------
// A real session per user, made once; every REST GET it sends is recorded, and
// a GET matching `failGet` is answered 500 instead of being sent
// ---------------------------------------------------------------------------
type Session = { client: SupabaseClient; gets: string[]; failGet: RegExp | null };
const sessions = new Map<TestUser, Session>();

async function session(user: TestUser): Promise<Session> {
  const known = sessions.get(user);
  if (known) return known;
  const s = (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const state: Session = { client: undefined as unknown as SupabaseClient, gets: [], failGet: null };
  state.client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if ((init?.method ?? "GET").toUpperCase() === "GET" && url.includes("/rest/v1/")) {
          state.gets.push(url);
          if (state.failGet?.test(url)) {
            return new Response(JSON.stringify({ code: "XX000", message: "steered failure", details: null, hint: null }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
        }
        return fetch(input, init);
      },
    },
  });
  const { error } = await state.client.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  sessions.set(user, state);
  return state;
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

interface Screen {
  rows: KeyRegisterRow[];
  ids: string[];
  /** The total the Pager states (the filtered count). */
  total: number;
  pageCount: number;
  next: string | null;
  /** "N registered · M out" — the whole register, never the search. */
  header: string;
  emptyText: string;
}

function read(root: ReactNode): Screen {
  const els = [...walk(root)];
  const register = els.find((e) => e.type === KeysRegister);
  if (!register) throw new Error("the keys page rendered no register");
  const pager = els.find((e) => e.type === Pager);
  if (!pager) throw new Error("the keys page rendered no Pager");
  const props = pager.props as Parameters<typeof Pager>[0];
  // a plain function of its props (no hooks): calling it yields the links it renders
  const links = [...walk(Pager(props))];
  const next = links.find((e) => typeof e.props.href === "string" && (e.props.rel === "next" || textOf(e) === "Next"));
  const header = els.find((e) => e.type === "p" && /registered ·/.test(textOf(e)));
  const rows = register.props.keys as KeyRegisterRow[];
  return {
    rows,
    ids: rows.map((k) => k.id),
    total: props.total,
    pageCount: props.pageCount,
    next: next ? (next.props.href as string) : null,
    header: header ? textOf(header) : "",
    emptyText: String(register.props.emptyText),
  };
}

async function show(client: SupabaseClient, params: Params): Promise<Screen> {
  const root = await ctx.als.run(client, () => KeysPage({ searchParams: Promise.resolve({ ...params }) }));
  return read(root);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let agent: TestUser;
let outsider: TestUser;
const userIds: string[] = [];

async function ids(sql: string, params: unknown[]): Promise<string[]> {
  const { rows } = await pg.query<{ v: string }>(sql, params);
  return rows.map((r) => r.v);
}

/** Inserts one property and returns its id. */
async function property(org: string, reference: string): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id",
    [org, reference],
  );
  return rows[0]!.id;
}

async function key(
  org: string,
  propertyId: string,
  code: string,
  o: { description?: string; holder?: string; status?: string; at?: string } = {},
): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `insert into property_keys (org_id, property_id, key_code, description, current_holder_name, status, created_at)
     values ($1, $2, $3, $4, $5, $6::key_status, $7::timestamptz) returning id`,
    [org, propertyId, code, o.description ?? null, o.holder ?? null, o.status ?? "in_office", o.at ?? TIED],
  );
  return rows[0]!.id;
}

/** The branch fixture's keys, by code. */
const BRANCH = {
  /** three keys on a property whose reference matches */
  home1: `BR${TAG}-M1`,
  home2: `BR${TAG}-M2`,
  home3: `BR${TAG}-M3`,
  /** the reference AND the key code match: listed once */
  both: `${ZQ}-BOTH`,
  /** only its own field matches (its property is PL…-PLAIN) */
  code: `${ZQ}-CODE`,
  desc: `BR${TAG}-DESC`,
  hold: `BR${TAG}-HOLD`,
  /** on PL…-PLAIN, nothing matches: never listed */
  none: `BR${TAG}-NONE`,
  /** on ZQ…-HIDDEN: found by its reference unless the session cannot read that property */
  hid: `BR${TAG}-HID`,
};
const PLAIN_REF = `PL${TAG}-PLAIN`;
const HOME_REF = `${ZQ}-HOME`;

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await pg.query(`drop policy if exists ${HIDE_POLICY} on public.properties`);

  await ensureTestOrg(svc, ORG, `Key reference search ${RUN}`, SLUG);
  await ensureTestOrg(svc, OTHER_ORG, `Key reference search other ${RUN}`, `${SLUG}-other`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `krs-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agent = await createTestUser(svc, `krs-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);
  outsider = await createTestUser(svc, `krs-other-${RUN}@test.local`, "admin", OTHER_ORG);
  userIds.push(outsider.id);

  // the reference families: properties in order, keys on the last `keys` of them
  for (const f of [...FAMILIES, FEW]) {
    await pg.query(
      `insert into properties (org_id, reference, property_type)
       select $1::uuid, $2::text || lpad(g::text, 5, '0'), 'apartment' from generate_series(1, $3::int) g`,
      [ORG, termOf(f.name), f.properties],
    );
    await pg.query(
      `insert into property_keys (org_id, property_id, key_code, created_at)
       select $1::uuid, p.id, $4::text || right(p.reference, 5), ${VARIED("right(p.reference, 5)::int", "$5")}
         from properties p
        where p.org_id = $1 and p.reference like $2::text || '%' and right(p.reference, 5)::int > $3::int`,
      [ORG, termOf(f.name), f.properties - f.keys, `KC${TAG}-${f.name}-`, TIED],
    );
  }

  // the branch fixture
  const home = await property(ORG, HOME_REF);
  const plain = await property(ORG, PLAIN_REF);
  const hidden = await property(ORG, HIDDEN_REF);
  await key(ORG, home, BRANCH.home1);
  await key(ORG, home, BRANCH.home2, { status: "checked_out", holder: "Someone else" });
  await key(ORG, home, BRANCH.home3, { at: "2026-01-02 09:00:00+00" });
  await key(ORG, home, BRANCH.both);
  await key(ORG, plain, BRANCH.code);
  await key(ORG, plain, BRANCH.desc, { description: `spare for the ${ZQ} gate` });
  await key(ORG, plain, BRANCH.hold, { holder: `${ZQ} Locksmith`, status: "checked_out" });
  await key(ORG, plain, BRANCH.none, { description: "the back door", holder: "A neighbour", status: "with_owner" });
  await key(ORG, hidden, BRANCH.hid);

  // OTHER_ORG: the SAME references (a family's first thirty, and the branch's
  // home) with newer keys — a leak would land on page one
  await pg.query(
    `insert into properties (org_id, reference, property_type)
     select $1::uuid, $2::text || lpad(g::text, 5, '0'), 'apartment' from generate_series(1, 30) g`,
    [OTHER_ORG, termOf("F0201")],
  );
  await pg.query(
    `insert into property_keys (org_id, property_id, key_code, created_at)
     select $1::uuid, p.id, 'XC' || $3::text || right(p.reference, 5), $4::timestamptz
       from properties p where p.org_id = $1 and p.reference like $2::text || '%'`,
    [OTHER_ORG, termOf("F0201"), TAG, OTHER_AT],
  );
  const otherHome = await property(OTHER_ORG, HOME_REF);
  await key(OTHER_ORG, otherHome, `XC${TAG}-HOME`, { at: OTHER_AT });
}, 300_000);

afterAll(async () => {
  await pg.query(`drop policy if exists ${HIDE_POLICY} on public.properties`);
  await pg.query("delete from property_keys where org_id = any($1::uuid[])", [ORGS]);
  await pg.query("delete from properties where org_id = any($1::uuid[])", [ORGS]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
  await pg.query("delete from organizations where id = any($1::uuid[])", [ORGS]);
  await pg.end();
}, 300_000);

// ---------------------------------------------------------------------------
// The authorised matching set, as postgres, in the order the page must show:
// the key's own fields OR its own property's reference
// ---------------------------------------------------------------------------
const expected = (org: string, q: string | null, status: string | null = null) =>
  ids(
    `select k.id::text as v from property_keys k
       join properties p on p.org_id = k.org_id and p.id = k.property_id
      where k.org_id = $1 and ($2::text is null or k.status::text = $2)
        and ($3::text is null or k.key_code ilike '%' || $3 || '%' or k.description ilike '%' || $3 || '%'
             or k.current_holder_name ilike '%' || $3 || '%' or p.reference ilike '%' || $3 || '%')
      order by k.created_at desc, k.id`,
    [org, status, q],
  );

const codesOf = async (idList: string[]): Promise<string[]> => {
  const { rows } = await pg.query<{ id: string; v: string }>(
    "select id::text as id, key_code as v from property_keys where id = any($1::uuid[])",
    [idList],
  );
  const code = new Map(rows.map((r) => [r.id, r.v]));
  return idList.map((id) => code.get(id) ?? `?${id}`);
};

const registerCounts = async (org: string): Promise<string> => {
  const { rows } = await pg.query<{ n: string; out: string }>(
    "select count(*) as n, count(*) filter (where status = 'checked_out') as out from property_keys where org_id = $1",
    [org],
  );
  return `${rows[0]!.n} registered · ${rows[0]!.out} out`;
};

// ---------------------------------------------------------------------------
// Walking the register the way a person does: page 1, then Next until the last
// ---------------------------------------------------------------------------
interface Walk {
  pages: Screen[];
  ids: string[];
  rows: KeyRegisterRow[];
  /** Every REST GET the walk sent. */
  gets: string[];
  /** The key-list requests (the paged ones), in the order sent. */
  listRequests: URL[];
}

async function browse(user: TestUser, filters: Params): Promise<Walk> {
  const s = await session(user);
  s.gets.length = 0;
  const pages = [await show(s.client, filters)];
  for (let p = 2; p <= pages[0]!.pageCount; p++) pages.push(await show(s.client, { ...filters, page: String(p) }));
  const gets = [...s.gets];
  const listRequests = gets
    .map((u) => new URL(u))
    .filter((u) => u.pathname === "/rest/v1/property_keys" && u.searchParams.get("limit") === String(PAGE_SIZE));
  const rows = pages.flatMap((p) => p.rows);
  return { pages, ids: rows.map((r) => r.id), rows, gets, listRequests };
}

async function expectWalk(label: string, user: TestUser, filters: Params, want: string[], foreign: string[] = []): Promise<Walk> {
  const w = await browse(user, filters);
  const seen = new Set(w.ids);
  const wanted = new Set(want);
  const repeated = w.ids.length - seen.size;
  const missing = want.filter((id) => !seen.has(id));
  const extra = [...seen].filter((id) => !wanted.has(id));
  const leaked = w.ids.filter((id) => foreign.includes(id));
  const lookups = w.gets.filter((u) => new URL(u).pathname === "/rest/v1/properties");
  const longest = Math.max(0, ...w.listRequests.map((u) => u.href.length));
  console.log(
    `[evidence] keys ${label}: stated ${w.pages[0]!.total} (database ${want.length}), pages ${w.pages.length},` +
      ` shown ${w.ids.length}, distinct ${seen.size}, repeated ${repeated}, missing ${missing.length},` +
      ` not in scope ${extra.length}, other org ${leaked.length}, property lookups ${lookups.length},` +
      ` key request ${longest} chars`,
  );

  const pageCount = Math.max(1, Math.ceil(want.length / PAGE_SIZE));
  expect.soft(w.pages[0]!.total, `${label}: the stated total`).toBe(want.length);
  expect.soft(w.pages[0]!.pageCount, `${label}: the page count`).toBe(pageCount);
  expect.soft(repeated, `${label}: keys shown on more than one page`).toBe(0);
  expect.soft(missing.length, `${label}: matching keys on no page`).toBe(0);
  expect.soft(extra, `${label}: keys outside the search`).toEqual([]);
  expect.soft(leaked, `${label}: another organisation's keys`).toEqual([]);
  w.pages.forEach((s, i) => {
    expect.soft(s.ids, `${label}: page ${i + 1} is exactly its slice`).toEqual(want.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE));
    expect.soft(s.total, `${label}: page ${i + 1} states the same total`).toBe(want.length);
  });
  expect.soft(w.ids, `${label}: the walk is the database's order`).toEqual(want);
  if (w.pages.length > 1) {
    expect.soft(w.pages[0]!.next, `${label}: page 1 Next keeps the search`).toBe(
      `?${new URLSearchParams({ ...filters, page: "2" }).toString()}`,
    );
  }

  // one request per page, its own order, and nothing sized by the matches
  expect.soft(w.listRequests.length, `${label}: one key request per page`).toBe(w.pages.length);
  for (const u of w.listRequests) {
    expect.soft(u.searchParams.get("order"), `${label}: the key request's order`).toBe("created_at.desc,id.asc");
    // `property_id` is a selected column; what must not be there is a predicate
    // over it, or any id at all (RLS scopes the organisation, not the URL)
    const query = decodeURIComponent(u.search);
    expect.soft(query, `${label}: no property id list in the key request`).not.toMatch(/property_id[.=]in\./);
    expect.soft(query.match(UUID_ANYWHERE) ?? [], `${label}: no id in the key request`).toEqual([]);
  }
  expect.soft(lookups, `${label}: no separate property lookup`).toEqual([]);
  return w;
}

// ---------------------------------------------------------------------------
// The CSV of the same search, through the real export route
// ---------------------------------------------------------------------------
interface Exported {
  status: number;
  rows: Record<string, string>[];
  body: string;
  /** Every REST GET the export sent. */
  gets: string[];
  /** Its key reads (one per 1,000-row page), in the order sent. */
  keyReads: URL[];
}

async function exportKeys(user: TestUser, filters: Params): Promise<Exported> {
  const url = new URL("http://localhost/keys/export");
  for (const [k, v] of Object.entries(filters)) url.searchParams.set(k, v);
  const s = await session(user);
  s.gets.length = 0;
  const res = await ctx.als.run(s.client, () => keysExport(new NextRequest(url)));
  const body = await res.text();
  const gets = [...s.gets];
  const keyReads = gets.map((u) => new URL(u)).filter((u) => u.pathname === "/rest/v1/property_keys");
  return { status: res.status, rows: res.status === 200 ? parseCsvTable(body).rows : [], body, gets, keyReads };
}

/** The export's reads carry the search themselves: no property lookup, no id in any key read. */
function expectExportShape(label: string, csv: Exported): void {
  expect.soft(csv.keyReads.length, `${label}: the export read keys`).toBeGreaterThan(0);
  expect.soft(csv.gets.filter((u) => new URL(u).pathname === "/rest/v1/properties"), `${label}: no property lookup in the export`).toEqual([]);
  for (const u of csv.keyReads) {
    const query = decodeURIComponent(u.search);
    expect.soft(query, `${label}: no property id list in an export read`).not.toMatch(/property_id[.=]in\./);
    expect.soft(query.match(UUID_ANYWHERE) ?? [], `${label}: no id in an export read`).toEqual([]);
  }
}

/** The CSV lists the walk's keys, in its order, each with the property the screen showed. */
async function expectCsvMatchesScreen(label: string, user: TestUser, filters: Params, w: Walk): Promise<void> {
  const csv = await exportKeys(user, filters);
  expect(csv.status, `${label} export: ${csv.body.slice(0, 200)}`).toBe(200);
  expectExportShape(label, csv);
  const screen = await codesOf(w.ids);
  const codes = csv.rows.map((r) => r["Key code"] ?? "");
  const same = JSON.stringify(screen) === JSON.stringify(codes);
  console.log(`[evidence] keys ${label} screen vs CSV: screen ${screen.length}, csv ${codes.length}, same order ${same ? "yes" : "NO"}`);
  expect.soft(codes, `${label}: the CSV lists the screen's keys in the screen's order`).toEqual(screen);
  expect.soft(
    csv.rows.map((r) => r.Property ?? ""),
    `${label}: the CSV's Property column is the screen's`,
  ).toEqual(w.rows.map((r) => (r.propertyRef === "—" ? "" : r.propertyRef)));
}

// ---------------------------------------------------------------------------
describe("a property-reference search on the keys register finds every matching key", () => {
  it("the fixture: each family's references and keys, and the other organisation's same references (measured)", async () => {
    for (const f of [...FAMILIES, FEW]) {
      const { rows } = await pg.query<{ refs: string; keys: string; keyed: string }>(
        `select (select count(*) from properties where org_id = $1 and reference ilike '%' || $2 || '%') as refs,
                (select count(*) from property_keys k join properties p on p.id = k.property_id
                  where k.org_id = $1 and p.reference ilike '%' || $2 || '%') as keys,
                (select count(distinct k.property_id) from property_keys k join properties p on p.id = k.property_id
                  where k.org_id = $1 and p.reference ilike '%' || $2 || '%') as keyed`,
        [ORG, termOf(f.name)],
      );
      const r = rows[0]!;
      console.log(`[evidence] family ${f.name}: ${r.refs} matching references, ${r.keys} keys on ${r.keyed} of them`);
      expect(Number(r.refs)).toBe(f.properties);
      expect(Number(r.keys)).toBe(f.keys);
      expect(Number(r.keyed)).toBe(f.keys);
    }
    const other = await expected(OTHER_ORG, termOf("F0201"));
    expect(other, "the other organisation holds keys under the same references").toHaveLength(30);
  });

  it.each(FAMILIES.map((f) => [f.name, f.properties] as const))(
    "%s: a term matching %i references lists every key — screen and CSV",
    async (name) => {
      const term = termOf(name);
      const want = await expected(ORG, term);
      const foreign = await expected(OTHER_ORG, term);
      const w = await expectWalk(`q=${name} (admin)`, admin, { q: term }, want, foreign);
      await expectCsvMatchesScreen(`q=${name}`, admin, { q: term }, w);
    },
    240_000,
  );

  it("600 matching references, two keys (on the properties written last): the broad term, each exact reference and each key's code find them", async () => {
    const term = termOf(FEW.name);
    const keyed = [refOf(FEW.name, 599), refOf(FEW.name, 600)];
    const codes = [codeOf(FEW.name, 599), codeOf(FEW.name, 600)];
    const want = await expected(ORG, term);
    expect(await codesOf(want), "the oracle: exactly the two keys").toEqual(expect.arrayContaining(codes));
    expect(want).toHaveLength(2);

    const broad = await expectWalk(`q=${FEW.name} (broad)`, admin, { q: term }, want);
    expect(new Set(await codesOf(broad.ids))).toEqual(new Set(codes));
    expect(broad.rows.map((r) => r.propertyRef).sort()).toEqual(keyed);
    await expectCsvMatchesScreen(`q=${FEW.name}`, admin, { q: term }, broad);

    for (const [i, ref] of keyed.entries()) {
      const exact = await expectWalk(`q=<exact reference ${ref.slice(-5)}>`, admin, { q: ref }, await expected(ORG, ref));
      expect(await codesOf(exact.ids), `the exact reference ${ref}`).toEqual([codes[i]]);
      const byCode = await expectWalk(`q=<its key code>`, admin, { q: codes[i]! }, await expected(ORG, codes[i]!));
      expect(await codesOf(byCode.ids), `the key code ${codes[i]}`).toEqual([codes[i]]);
    }
  }, 120_000);

  it("the key request is the same size whatever the term matches — no property lookup, no id list — on the page and in the export", async () => {
    const { client, gets } = await session(admin);
    const sizes: Record<string, number> = {};
    const exportSizes: Record<string, number> = {};
    for (const f of [...FAMILIES, FEW]) {
      gets.length = 0;
      await show(client, { q: termOf(f.name) });
      const list = gets.map((u) => new URL(u)).filter((u) => u.pathname === "/rest/v1/property_keys" && u.searchParams.get("limit") === String(PAGE_SIZE));
      expect(list, `${f.name}: one key request`).toHaveLength(1);
      expect(gets.filter((u) => new URL(u).pathname === "/rest/v1/properties"), `${f.name}: no property lookup`).toEqual([]);
      sizes[`${f.name} (${f.properties} references)`] = list[0]!.href.length;

      const csv = await exportKeys(admin, { q: termOf(f.name) });
      expect(csv.status, `${f.name} export`).toBe(200);
      expectExportShape(`${f.name} export`, csv);
      // the first read (offset 0): later pages differ only in their offset's digits
      exportSizes[`${f.name} (${f.properties} references)`] = csv.keyReads[0]!.href.length;
    }
    console.log(`[evidence] key request length by matching references: page ${JSON.stringify(sizes)}; export ${JSON.stringify(exportSizes)}`);
    expect(new Set(Object.values(sizes)).size, "one length for every family's term").toBe(1);
    expect(Math.max(...Object.values(sizes)), "and a short one").toBeLessThan(2_000);
    expect(new Set(Object.values(exportSizes)).size, "the export: one length for every family's term").toBe(1);
    expect(Math.max(...Object.values(exportSizes)), "and a short one").toBeLessThan(2_000);
  }, 120_000);

  it("the code, the description and the holder each match on their own; a key matching twice appears once; every key of a matching property; the shown reference is the key's own", async () => {
    const term = ZQ.toLowerCase(); // stored upper-case: the match ignores case
    const want = await expected(ORG, term);
    const w = await expectWalk("q=<branch term>", admin, { q: term }, want);
    const byCode = new Map(w.rows.map((r) => [r.keyCode, r.propertyRef]));
    // named, not derived from the oracle
    expect(new Set(byCode.keys())).toEqual(
      new Set([BRANCH.home1, BRANCH.home2, BRANCH.home3, BRANCH.both, BRANCH.code, BRANCH.desc, BRANCH.hold, BRANCH.hid]),
    );
    expect(w.ids, "each key once").toHaveLength(8);
    expect(byCode.has(BRANCH.none), "a key matching on nothing").toBe(false);
    // a key that matched on its own field still shows ITS property's reference
    expect(byCode.get(BRANCH.code)).toBe(PLAIN_REF);
    expect(byCode.get(BRANCH.desc)).toBe(PLAIN_REF);
    expect(byCode.get(BRANCH.hold)).toBe(PLAIN_REF);
    expect(byCode.get(BRANCH.both)).toBe(HOME_REF);
    expect(byCode.get(BRANCH.home1)).toBe(HOME_REF);
    expect(byCode.get(BRANCH.hid)).toBe(HIDDEN_REF);
    await expectCsvMatchesScreen("q=<branch term>", admin, { q: term }, w);

    // each field alone, with a term only that field holds
    const alone: [string, string, string][] = [
      ["the key code", `${ZQ}-CODE`.toLowerCase(), BRANCH.code],
      ["the description", `the ${ZQ} gate`, BRANCH.desc],
      ["the holder's name", `${ZQ} locksmith`, BRANCH.hold],
      ["the reference", HOME_REF.toLowerCase(), BRANCH.home1],
    ];
    for (const [field, q, code] of alone) {
      const one = await expectWalk(`q=<${field}>`, admin, { q }, await expected(ORG, q));
      console.log(`[evidence] keys q=<${field}>: ${(await codesOf(one.ids)).join(", ")}`);
      expect(await codesOf(one.ids), field).toContain(code);
    }
  }, 120_000);

  it("a status narrows the search; an empty or blank search is the whole register; a term matching nothing is one empty page; the header never follows the search", async () => {
    const term = ZQ.toLowerCase();
    const out = await expectWalk("q=<branch term> status=checked_out", admin, { q: term, status: "checked_out" }, await expected(ORG, term, "checked_out"));
    expect(new Set(await codesOf(out.ids))).toEqual(new Set([BRANCH.home2, BRANCH.hold]));
    const inOffice = await expectWalk("q=<branch term> status=in_office", admin, { q: term, status: "in_office" }, await expected(ORG, term, "in_office"));
    expect(inOffice.ids).toHaveLength(6);
    await expectCsvMatchesScreen("q=<branch term> status=checked_out", admin, { q: term, status: "checked_out" }, out);
    const owner = await expectWalk("q=<branch term> status=with_owner", admin, { q: term, status: "with_owner" }, []);
    expect(owner.pages[0]!.emptyText).toBe("No keys match.");

    const header = await registerCounts(ORG);
    expect(out.pages[0]!.header, "the header counts the whole register while searching").toBe(header);

    const all = await expected(ORG, null);
    const adminSession = await session(admin);
    for (const q of ["", "   "]) {
      adminSession.gets.length = 0;
      const s = await show(adminSession.client, { q });
      // an unsearched read does not pay for the reference-match embed
      const pageReads = adminSession.gets.filter((u) => new URL(u).pathname === "/rest/v1/property_keys");
      const csv = await exportKeys(admin, { q });
      const selects = [...pageReads.map((u) => new URL(u)), ...csv.keyReads].map((u) => u.searchParams.get("select") ?? "");
      console.log(`[evidence] keys q=${JSON.stringify(q)}: stated ${s.total} (database ${all.length}), csv ${csv.rows.length}, reads selecting reference_match ${selects.filter((x) => x.includes("reference_match")).length} of ${selects.length}`);
      expect(s.total, `q=${JSON.stringify(q)} is the whole register`).toBe(all.length);
      expect(s.ids).toEqual(all.slice(0, PAGE_SIZE));
      expect(s.header).toBe(header);
      expect(csv.rows).toHaveLength(all.length);
      expect(selects.length).toBeGreaterThan(0);
      expect(selects.filter((x) => x.includes("reference_match")), "no reference_match without a term").toEqual([]);
    }

    const none = await expectWalk("q=<matches nothing>", admin, { q: `NONE${TAG}` }, []);
    expect(none.pages[0]!.emptyText).toBe("No keys match.");
    expect(none.pages[0]!.next).toBeNull();
    const csv = await exportKeys(admin, { q: `NONE${TAG}` });
    expect(csv.status).toBe(200);
    expect(csv.rows).toEqual([]);
  }, 120_000);

  it("an agent finds the same keys; another organisation's keys under the same references never appear; its admin finds only its own", async () => {
    const term = termOf("F0201");
    const foreign = await expected(OTHER_ORG, term);
    await expectWalk("q=F0201 (agent)", agent, { q: term }, await expected(ORG, term), foreign);
    const branch = ZQ.toLowerCase();
    await expectWalk("q=<branch term> (agent)", agent, { q: branch }, await expected(ORG, branch), await expected(OTHER_ORG, branch));

    const theirs = await expectWalk("q=F0201 (other org admin)", outsider, { q: term }, foreign, await expected(ORG, term));
    expect(theirs.ids).toHaveLength(30);
    const theirBranch = await expectWalk("q=<branch term> (other org admin)", outsider, { q: branch }, await expected(OTHER_ORG, branch), await expected(ORG, branch));
    expect(await codesOf(theirBranch.ids)).toEqual([`XC${TAG}-HOME`]);
    await expectCsvMatchesScreen("q=F0201 (other org admin)", outsider, { q: term }, theirs);
  }, 240_000);

  it("a property the session cannot read never makes its key findable by its reference", async () => {
    // ORG is a uuid and TAG is [0-9A-Z]: the literals need no escaping beyond their quotes
    await pg.query(
      `create policy ${HIDE_POLICY} on public.properties as restrictive for select to authenticated
         using (org_id <> '${ORG}'::uuid or reference <> '${HIDDEN_REF}')`,
    );
    try {
      const term = ZQ.toLowerCase();
      const w = await browse(admin, { q: term });
      const codes = await codesOf(w.ids);
      console.log(`[evidence] keys q=<branch term> with ${HIDDEN_REF} unreadable: ${codes.length} keys, ${codes.includes(BRANCH.hid) ? "INCLUDES" : "not"} ${BRANCH.hid}`);
      expect(new Set(codes)).toEqual(new Set([BRANCH.home1, BRANCH.home2, BRANCH.home3, BRANCH.both, BRANCH.code, BRANCH.desc, BRANCH.hold]));
      expect(w.pages[0]!.total).toBe(7);
      const byRef = await browse(admin, { q: HIDDEN_REF });
      expect(byRef.ids, "its exact reference finds nothing").toEqual([]);
      expect(byRef.pages[0]!.total).toBe(0);
      // the key itself is readable: found by its own code, with no reference to show
      const byCode = await browse(admin, { q: BRANCH.hid });
      expect(byCode.rows.map((r) => [r.keyCode, r.propertyRef])).toEqual([[BRANCH.hid, "—"]]);
      const csv = await exportKeys(admin, { q: term });
      expect(csv.status).toBe(200);
      expect(csv.rows.map((r) => r["Key code"]).sort()).toEqual([...codes].sort());
      const csvRef = await exportKeys(admin, { q: HIDDEN_REF });
      expect(csvRef.rows, "nor does the CSV").toEqual([]);
    } finally {
      await pg.query(`drop policy if exists ${HIDE_POLICY} on public.properties`);
    }
  }, 120_000);

  it("a failed key read is the page's load failure, never an empty or narrower register", async () => {
    const s = await session(admin);
    for (const q of [termOf("F1001"), ZQ.toLowerCase()]) {
      s.failGet = /\/rest\/v1\/property_keys\?.*limit=25/;
      try {
        const before = s.gets.length;
        let outcome: string;
        try {
          const screen = await show(s.client, { q });
          outcome = `rendered ${screen.ids.length} keys, total ${screen.total}`;
        } catch (e) {
          outcome = `threw: ${e instanceof Error ? e.message : String(e)}`;
        }
        console.log(`[evidence] keys q=${q} key read fails: ${outcome}`);
        expect(s.gets.slice(before).some((u) => s.failGet!.test(u)), "the key read was attempted").toBe(true);
        expect(outcome).toMatch(/^threw: Query failed \(keys\)/);
      } finally {
        s.failGet = null;
      }
    }
  }, 60_000);
});
