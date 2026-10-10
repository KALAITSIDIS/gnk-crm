import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import {
  ANON_KEY,
  SERVICE_ROLE_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";
import { parseCsvTable } from "../../scripts/import/_shared.mts";

/**
 * Every list CSV export holds EVERY record its filters match, up to the
 * ceiling — through the REAL route handlers, against a REAL PostgREST whose
 * `max_rows` is below the size of the set (T-export-complete).
 *
 * At 870207d each of the seven routes asked once for `.range(0, 9999)`;
 * PostgREST answered the first `max_rows` (1000) and the route returned them
 * as a complete 200 CSV, its audit line counting what it held. Nothing below
 * the route is stubbed except the Next.js request plumbing: reads go through
 * PostgREST, RLS and the session's aal2 token; the audit line is a real
 * `exported` event on the hash chain. Failures are INJECTED at the session's
 * transport (a page answered 500, the audit insert answered 500), and the
 * server cap is lowered in-database (`pgrst.db_max_rows`) — restored after.
 *
 * WHAT IT PINS (each scenario prints one `[evidence]` line):
 *   1. each of the seven exports, over a set larger than max_rows with most
 *      sort keys tied and a slice a day either side (task due dates: half null,
 *      the rest likewise), yields exactly the authorised set in the route's
 *      order — primary sort, direction, nulls last, then id — none missing or
 *      repeated;
 *      another organisation's rows never appear; the audit count = the rows;
 *   2. filters, archive scopes, the deal type, the mandate filters (an
 *      `!inner` embed and an exclusion list), a key search that matches
 *      through property references, "my tasks" and an agent's own
 *      deals keep their meaning past the first page; an empty set exports a
 *      header-only CSV; a smaller set exports exactly;
 *   3. 0, 999, 1000, 1001, 2501 and exactly 10,000 export completely;
 *      10,001 refuses (422 too_many) — nothing downloaded, nothing audited,
 *      at most 10,001 rows ever requested;
 *   4. a server capped BELOW the page size (300, 750) still yields every row;
 *   5. a later page's failure, the agent-name, mandate or key-reference
 *      lookup's failure and the audit write's failure each release no CSV
 *      (and the read failures write no audit line);
 *   6. the deals CSV keeps expected and final values as separate raw columns
 *      (a final 0 stays "0", an absent one stays blank); CSV quoting, the BOM
 *      and formula neutralising hold on the paged path.
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const SIZE_ORG = randomUUID();
const ORGS = [ORG, OTHER_ORG, SIZE_ORG];
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `list-export-${RUN}`;

/** Larger than PostgREST's max_rows (1000) with room for three pages. */
const N = 2501;
/** Most rows of a list share this timestamp: offset paging must not depend on the sort key alone. */
const TIED = "2026-01-01 09:00:00+00";
/**
 * …and a slice does NOT: one row in 7 sorts a day later, one in 11 a day
 * earlier, so a route that drops or flips its primary sort fails too.
 */
const VARIED = (g: string, at: string) =>
  `(${at}::timestamptz + case when ${g} % 7 = 0 then interval '1 day' when ${g} % 11 = 0 then interval '-1 day' else interval '0' end)`;

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>() };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound for this export");
    return c;
  },
}));

import { GET as dealsExport } from "@/app/(app)/pipeline/export/route";
import { GET as contactsExport } from "@/app/(app)/contacts/export/route";
import { GET as leadsExport } from "@/app/(app)/leads/export/route";
import { GET as keysExport } from "@/app/(app)/keys/export/route";
import { GET as tasksExport } from "@/app/(app)/tasks/export/route";
import { GET as viewingsExport } from "@/app/(app)/viewings/export/route";
import { GET as propertiesExport } from "@/app/(app)/properties/export/route";

type Route = "pipeline" | "contacts" | "leads" | "keys" | "tasks" | "viewings" | "properties";
const HANDLERS: Record<Route, (req: NextRequest) => Promise<Response>> = {
  pipeline: dealsExport,
  contacts: contactsExport,
  leads: leadsExport,
  keys: keysExport,
  tasks: tasksExport as unknown as (req: NextRequest) => Promise<Response>,
  viewings: viewingsExport as unknown as (req: NextRequest) => Promise<Response>,
  properties: propertiesExport,
};
const TABLE: Record<Route, string> = {
  pipeline: "deals",
  contacts: "contacts",
  leads: "leads",
  keys: "property_keys",
  tasks: "tasks",
  viewings: "viewings",
  properties: "properties",
};

// ---------------------------------------------------------------------------
// The session's transport: every GET recorded; one chosen GET or the audit
// insert can be answered 500 (the database never sees it).
// ---------------------------------------------------------------------------
const steer = {
  gets: [] as string[],
  failGet: null as null | { match: RegExp; nth: number; seen: number },
  failAudit: false,
  auditAttempts: 0,
};
const injected500 = () =>
  new Response(JSON.stringify({ code: "XX000", message: "injected by the test", details: null, hint: null }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });

async function sessionClient(user: TestUser): Promise<SupabaseClient> {
  const s = (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET" && url.includes("/rest/v1/")) {
          steer.gets.push(url);
          const f = steer.failGet;
          if (f && f.match.test(url) && ++f.seen === f.nth) return injected500();
        }
        if (method === "POST" && /\/rest\/v1\/events\b/.test(url)) {
          steer.auditAttempts++;
          if (steer.failAudit) return injected500();
        }
        return fetch(input, init);
      },
    },
  });
  const { error } = await c.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  return c;
}

type Answer = {
  status: number;
  type: string;
  cacheControl: string;
  disposition: string;
  body: string;
  rows: Record<string, string>[];
  header: string[];
  json: { error?: string; reason?: string } | null;
};

async function exportAs(user: TestUser, route: Route, query: Record<string, string> = {}): Promise<Answer> {
  const url = new URL(`http://localhost/${route}/export`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const client = await sessionClient(user);
  steer.gets = [];
  const res = await ctx.als.run(client, () => HANDLERS[route](new NextRequest(url)));
  // bytes, not res.text(): the WHATWG decoder strips the BOM this file checks for
  const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  const csv = type.startsWith("text/csv") ? parseCsvTable(body) : { header: [], rows: [] };
  return {
    status: res.status,
    type,
    cacheControl: res.headers.get("cache-control") ?? "",
    disposition: res.headers.get("content-disposition") ?? "",
    body,
    header: csv.header,
    rows: csv.rows,
    json: type.includes("application/json") ? (JSON.parse(body) as Answer["json"]) : null,
  };
}

/** The `offset`/`limit` of every GET on one table during the last export. */
function pagesOf(table: string): { offset: number; limit: number }[] {
  return steer.gets
    .filter((u) => new URL(u).pathname === `/rest/v1/${table}`)
    .map((u) => {
      const p = new URL(u).searchParams;
      return { offset: Number(p.get("offset") ?? 0), limit: Number(p.get("limit") ?? NaN) };
    });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let agent: TestUser;
let outsider: TestUser;
let sizer: TestUser;
const userIds: string[] = [];
/** Whose organisation an export audits. */
const ORG_OF = new Map<TestUser, string>();

/** What the CSV writer does to a cell (csv.ts): formula-leading values get a `'`. parseCsvTable trims. */
const cell = (v: string | null) => {
  const s = v ?? "";
  return (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).trim();
};

async function column(sql: string, params: unknown[]): Promise<string[]> {
  const { rows } = await pg.query<{ v: string | null }>(sql, params);
  return rows.map((r) => cell(r.v));
}

async function exportedEvents(org: string): Promise<{ count: number; last: { list: string; count: number } | null }> {
  const { rows } = await pg.query<{ payload: { list: string; count: number } }>(
    `select payload from events where org_id = $1 and entity_type = 'export' and event_type = 'exported'
      order by occurred_at desc, id desc`,
    [org],
  );
  return { count: rows.length, last: rows[0]?.payload ?? null };
}

/** PostgREST's row cap, set in the database and confirmed by a real read before it is relied on. */
async function setServerCap(cap: number | null): Promise<void> {
  if (cap === null) await pg.query("alter role authenticator reset pgrst.db_max_rows");
  else await pg.query(`alter role authenticator set pgrst.db_max_rows = '${cap}'`);
  await pg.query("notify pgrst, 'reload config'");
  const want = cap ?? 1000;
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/contacts?select=id&org_id=eq.${ORG}&order=id`, {
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, Range: "0-9999" },
    });
    const got = ((await res.json()) as unknown[]).length;
    if (got === want) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`PostgREST did not take max_rows = ${want}`);
}

async function seedSizeOrg(n: number): Promise<void> {
  await pg.query("delete from contacts where org_id = $1", [SIZE_ORG]);
  await pg.query(
    `insert into contacts (org_id, first_name, created_at)
     select $1::uuid, format('SZ%s-%s', $2::text, lpad(g::text, 5, '0')), $3::timestamptz
       from generate_series(1, $4::int) g`,
    [SIZE_ORG, TAG, TIED, n],
  );
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  // a cap left lowered by an interrupted run of this file
  await pg.query("alter role authenticator reset pgrst.db_max_rows");
  await pg.query("notify pgrst, 'reload config'");

  await ensureTestOrg(svc, ORG, `List export ${RUN}`, SLUG);
  await ensureTestOrg(svc, OTHER_ORG, `List export other ${RUN}`, `${SLUG}-other`);
  await ensureTestOrg(svc, SIZE_ORG, `List export size ${RUN}`, `${SLUG}-size`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `lx-admin-${RUN}@test.local`, "admin", ORG);
  agent = await createTestUser(svc, `lx-agent-${RUN}@test.local`, "agent", ORG);
  outsider = await createTestUser(svc, `lx-other-${RUN}@test.local`, "admin", OTHER_ORG);
  sizer = await createTestUser(svc, `lx-size-${RUN}@test.local`, "admin", SIZE_ORG);
  userIds.push(admin.id, agent.id, outsider.id, sizer.id);
  ORG_OF.set(admin, ORG).set(agent, ORG).set(outsider, OTHER_ORG).set(sizer, SIZE_ORG);

  // Every list in ORG over max_rows, every sort key TIED; the same lists in
  // OTHER_ORG, newest of all, so a leak would surface on page one.
  for (const [org, mark, at] of [
    [ORG, "", TIED],
    [OTHER_ORG, "X", "2026-06-01 09:00:00+00"],
  ] as const) {
    const m = `${mark}${TAG}`;
    const owner = org === ORG ? admin.id : outsider.id;
    // contacts: active, archived, and two that the CSV writer must escape
    await pg.query(
      `insert into contacts (org_id, first_name, contact_types, created_at)
       select $1::uuid, format('CT%s-%s', $2::text, lpad(g::text, 5, '0')),
              case when g % 3 = 0 then array['seller'] else array['buyer','investor'] end, ${VARIED("g", "$3")}
         from generate_series(1, $4::int) g`,
      [org, m, at, N],
    );
    await pg.query(
      `insert into contacts (org_id, first_name, is_archived, created_at)
       select $1::uuid, format('CA%s-%s', $2::text, lpad(g::text, 5, '0')), true, $3::timestamptz
         from generate_series(1, 150) g`,
      [org, m, at],
    );
    await pg.query(
      `insert into contacts (org_id, first_name, created_at) values
         ($1::uuid, '=1+2 CF' || $2::text, $3::timestamptz),
         ($1::uuid, 'Comma, "Quoted" CQ' || $2::text, $3::timestamptz)`,
      [org, m, at],
    );

    // deals: sale (open, won with a final value, won with final 0, won with none), rental decoys
    const { rows: stages } = await pg.query<{ id: string; deal_type: string; is_won: boolean; is_lost: boolean }>(
      "select id, deal_type, is_won, is_lost from deal_stages where org_id = $1 order by sort_order",
      [org],
    );
    const stage = (type: string, kind: "open" | "won") =>
      stages.find((s) => s.deal_type === type && (kind === "won" ? s.is_won : !s.is_won && !s.is_lost))!.id;
    await pg.query(
      `insert into deals (org_id, deal_type, stage_id, title, status, expected_value, final_value, won_at,
                          agent_id, created_at)
       select $1::uuid, 'sale', case when g % 10 = 0 then $3::uuid else $4::uuid end,
              format('DL%s-%s', $2::text, lpad(g::text, 5, '0')),
              (case when g % 10 = 0 then 'won' else 'open' end)::deal_status,
              (g * 1000)::numeric(14,2),
              case when g % 30 = 0 then 0 when g % 30 = 10 then null when g % 10 = 0 then (g * 900)::numeric(14,2) end,
              case when g % 10 = 0 then $5::timestamptz end,
              case when g % 2 = 0 then $6::uuid end,
              ${VARIED("g", "$5")}
         from generate_series(1, $7::int) g`,
      [org, m, stage("sale", "won"), stage("sale", "open"), at, org === ORG ? agent.id : null, N],
    );
    await pg.query(
      `insert into deals (org_id, deal_type, stage_id, title, created_at)
       select $1::uuid, 'rental', $3::uuid, format('DR%s-%s', $2::text, lpad(g::text, 5, '0')), $4::timestamptz
         from generate_series(1, 25) g`,
      [org, m, stage("rental", "open"), at],
    );

    // leads: six statuses in turn, never 'website' (crons act on those)
    await pg.query(
      `insert into leads (org_id, source, channel, status, message, received_at)
       select $1::uuid, 'phone', 'phone',
              (array['new','contacted','qualified','converted','lost','spam']::lead_status[])[1 + g % 6],
              format('LD%s-%s', $2::text, lpad(g::text, 5, '0')), ${VARIED("g", "$3")}
         from generate_series(1, $4::int) g`,
      [org, m, at, N],
    );

    // properties: listings (some villas), retired ones; keys and viewings hang off three of them
    await pg.query(
      `insert into properties (org_id, reference, property_type, created_at)
       select $1::uuid, format('PR%s-%s', $2::text, lpad(g::text, 5, '0')),
              (case when g % 4 = 0 then 'villa' else 'apartment' end)::property_type, ${VARIED("g", "$3")}
         from generate_series(1, $4::int) g`,
      [org, m, at, N],
    );
    await pg.query(
      `insert into properties (org_id, reference, property_type, status, created_at)
       select $1::uuid, format('PW%s-%s', $2::text, lpad(g::text, 5, '0')), 'apartment', 'withdrawn', $3::timestamptz
         from generate_series(1, 120) g`,
      [org, m, at],
    );
    const { rows: props } = await pg.query<{ id: string }>(
      "select id from properties where org_id = $1 order by reference limit 3",
      [org],
    );
    await pg.query(
      `insert into property_keys (org_id, property_id, key_code, status, created_at)
       select $1::uuid, ($3::uuid[])[1 + g % 3], format('KY%s-%s', $2::text, lpad(g::text, 5, '0')),
              (array['in_office','checked_out','with_owner','lost']::key_status[])[1 + g % 4], ${VARIED("g", "$4")}
         from generate_series(1, $5::int) g`,
      [org, m, props.map((p) => p.id), at, N],
    );

    // mandates: ORG — 1100 active, so the `mandates_safe!inner` embed is paged past max_rows;
    // OTHER_ORG — 30, so its "no mandate" export carries a short exclusion list
    await pg.query(
      `insert into mandates (org_id, property_id, type, status)
       select $1::uuid, p.id, 'exclusive', 'active'
         from (select id from properties where org_id = $1 and reference like 'PR%' order by reference limit $2) p`,
      [org, org === ORG ? 1100 : 30],
    );

    // viewings: one attendee; the duration is each row's identity
    const {
      rows: [attendee],
    } = await pg.query<{ id: string }>(
      "insert into contacts (org_id, first_name, created_at) values ($1, 'Attendee ' || $2::text, $3) returning id",
      [org, m, at],
    );
    await pg.query(
      `insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at, duration_min)
       select $1::uuid, $2::uuid, $3::uuid, $4::uuid, ${VARIED("g", "$5")}, g from generate_series(1, $6::int) g`,
      [org, props[0]!.id, attendee!.id, owner, at, N],
    );

    // tasks: the exporter's own — half undated, half on ONE tied due date — and a colleague's
    await pg.query(
      `insert into tasks (org_id, title, assignee_id, due_at, created_by)
       select $1::uuid, format('TK%s-%s', $2::text, lpad(g::text, 5, '0')), $3::uuid,
              case when g % 2 = 0 then ${VARIED("g", "$4")} end, $3::uuid
         from generate_series(1, $5::int) g`,
      [org, m, owner, at, N],
    );
    if (org === ORG) {
      await pg.query(
        `insert into tasks (org_id, title, assignee_id, due_at, created_by)
         select $1::uuid, format('TA%s-%s', $2::text, lpad(g::text, 5, '0')), $3::uuid, $4::timestamptz, $3::uuid
           from generate_series(1, 1200) g`,
        [org, m, agent.id, at],
      );
    }
  }
}, 600_000);

afterEach(() => {
  steer.failGet = null;
  steer.failAudit = false;
  steer.auditAttempts = 0;
});

afterAll(async () => {
  await pg.query("alter role authenticator reset pgrst.db_max_rows");
  await pg.query("notify pgrst, 'reload config'");
  for (const t of ["tasks", "viewings", "property_keys", "mandates", "leads", "deals", "price_history"]) {
    await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
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
// The authorised matching set, as postgres, in the route's order
// ---------------------------------------------------------------------------
const EXPECTED = {
  dealsOf: (type: string, agentId?: string) =>
    column(
      `select title as v from deals where org_id = $1 and deal_type = $2::deal_type
         and ($3::uuid is null or agent_id = $3 or created_by = $3)
       order by created_at desc, id`,
      [ORG, type, agentId ?? null],
    ),
  contacts: (archived: boolean, type?: string) =>
    column(
      `select display_name as v from contacts where org_id = $1 and is_archived = $2
         and ($3::text is null or contact_types @> array[$3])
       order by created_at desc, id`,
      [ORG, archived, type ?? null],
    ),
  leads: (statuses: string[] | null) =>
    column(
      `select message as v from leads where org_id = $1 and ($2::text[] is null or status::text = any($2))
       order by received_at desc, id`,
      [ORG, statuses],
    ),
  keys: (status: string | null) =>
    column(
      `select key_code as v from property_keys where org_id = $1 and ($2::text is null or status::text = $2)
       order by created_at desc, id`,
      [ORG, status],
    ),
  tasks: (assignee: string) =>
    column(
      `select title as v from tasks where org_id = $1 and assignee_id = $2
       order by due_at asc nulls last, id`,
      [ORG, assignee],
    ),
  viewings: () =>
    column(`select duration_min::text as v from viewings where org_id = $1 order by scheduled_at desc, id`, [ORG]),
  properties: (scope: "default" | "archived", type?: string) =>
    column(
      `select reference as v from properties where org_id = $1 and kind <> 'unit'
         and case when $2 = 'archived' then (status = 'withdrawn' or visibility = 'archived')
                  else status <> 'withdrawn' and visibility <> 'archived' end
         and ($3::text is null or property_type::text = $3)
       order by created_at desc, id`,
      [ORG, scope, type ?? null],
    ),
};

const IDENTITY: Record<Route, string> = {
  pipeline: "Title",
  contacts: "Name",
  leads: "Message",
  keys: "Key code",
  tasks: "Title",
  viewings: "Duration (min)",
  properties: "Reference",
};

/** The CSV's records against the authorised set: same rows, same order, none missing, none repeated. */
async function expectComplete(
  label: string,
  user: TestUser,
  route: Route,
  query: Record<string, string>,
  expected: string[],
): Promise<Answer> {
  const before = await exportedEvents(ORG_OF.get(user) ?? ORG);
  const a = await exportAs(user, route, query);
  const got = a.rows.map((r) => r[IDENTITY[route]] ?? "");
  const gotSet = new Set(got);
  const missing = expected.filter((v) => !gotSet.has(v));
  const repeated = got.length - gotSet.size;
  const after = await exportedEvents(ORG_OF.get(user) ?? ORG);
  console.log(
    `[evidence] ${label}: status ${a.status}, expected ${expected.length}, csv ${got.length}, missing ${missing.length}` +
      ` (e.g. ${missing.slice(0, 2).join(" ") || "-"}), repeated ${repeated}, pages ${pagesOf(TABLE[route]).length},` +
      ` audit count ${after.count > before.count ? after.last?.count : "none"}`,
  );
  expect(a.status, `${label}: ${a.body.slice(0, 200)}`).toBe(200);
  expect(a.type).toContain("text/csv");
  expect(a.cacheControl).toBe("no-store");
  expect(a.body.charCodeAt(0), "UTF-8 BOM").toBe(0xfeff);
  expect(missing, `${label}: records missing from the CSV`).toEqual([]);
  expect(got, `${label}: the CSV is not exactly the authorised set in the route's order`).toEqual(expected);
  expect(after.count, `${label}: one audit line per export`).toBe(before.count + 1);
  expect(after.last).toMatchObject({ count: expected.length });
  return a;
}
describe("every list export holds the whole authorised set past max_rows", () => {
  it("the stack's PostgREST caps a response below the sets used here (measured)", async () => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/contacts?select=id&org_id=eq.${ORG}&order=id`, {
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Range: "0-9999",
        Prefer: "count=exact",
      },
    });
    const range = res.headers.get("content-range");
    console.log(`[evidence] max_rows: Range 0-9999 → ${res.status}, Content-Range ${range}`);
    expect(res.status).toBe(206);
    expect(range).toMatch(/^0-999\/\d+$/);
  });

  it("deals (sale, every status): all rows, ordered, the money columns raw and separate", async () => {
    const a = await expectComplete("deals sale/admin", admin, "pipeline", { type: "sale" }, await EXPECTED.dealsOf("sale"));
    expect(a.header.slice(0, 6)).toEqual(["Title", "Type", "Stage", "Status", "Expected value", "Final value"]);
    const row = (g: number) => a.rows.find((r) => r.Title === `DL${TAG}-${String(g).padStart(5, "0")}`)!;
    expect(row(2490)).toMatchObject({ Status: "won", "Expected value": "2490000", "Final value": "0" }); // a confirmed zero stays 0
    expect(row(2470)).toMatchObject({ Status: "won", "Expected value": "2470000", "Final value": "" }); // absent stays blank
    expect(row(2480)).toMatchObject({ Status: "won", "Expected value": "2480000", "Final value": "2232000" });
    expect(row(2499)).toMatchObject({ Status: "open", "Expected value": "2499000", "Final value": "" });
    expect(a.body).not.toContain(`DLX${TAG}`);
  });

  it("deals: the type filter, an empty type, and an agent's own deals past the cap", async () => {
    await expectComplete("deals rental (smaller set)", admin, "pipeline", { type: "rental" }, await EXPECTED.dealsOf("rental"));
    const empty = await expectComplete("deals advisory (empty)", admin, "pipeline", { type: "advisory" }, []);
    expect(empty.body.replace(/^﻿/, "")).toMatch(/^Title,Type,Stage,[^\r\n]*\r\n$/);
    const own = await EXPECTED.dealsOf("sale", agent.id);
    expect(own.length).toBeGreaterThan(1000);
    await expectComplete("deals sale/agent (RLS: own deals)", agent, "pipeline", { type: "sale" }, own);
  });

  it("contacts: the default scope, the archived scope, a type filter; escaping and formulas hold", async () => {
    const a = await expectComplete("contacts active", admin, "contacts", {}, await EXPECTED.contacts(false));
    expect(a.body).toContain(`"Comma, ""Quoted"" CQ${TAG}"`);
    expect(a.rows.some((r) => r.Name === `'=1+2 CF${TAG}`)).toBe(true);
    expect(a.body).not.toContain(`CTX${TAG}`);
    await expectComplete("contacts archived", admin, "contacts", { archived: "1" }, await EXPECTED.contacts(true));
    await expectComplete("contacts type=buyer", admin, "contacts", { type: "buyer" }, await EXPECTED.contacts(false, "buyer"));
  });

  it("leads: all statuses, and the open scope", async () => {
    await expectComplete("leads all", admin, "leads", { status: "all" }, await EXPECTED.leads(null));
    await expectComplete(
      "leads open",
      admin,
      "leads",
      { status: "open" },
      await EXPECTED.leads(["new", "contacted", "qualified"]),
    );
  });

  it("keys: all, and one status", async () => {
    await expectComplete("keys all", admin, "keys", {}, await EXPECTED.keys(null));
    await expectComplete("keys checked_out", admin, "keys", { status: "checked_out" }, await EXPECTED.keys("checked_out"));
    // a search that matches only through the property REFERENCE (a lookup first, then
    // `property_id.in.(…)` inside the .or()) — reapplied on every page
    const term = `PR${TAG}-0000`;
    const byReference = await column(
      `select k.key_code as v from property_keys k join properties p on p.org_id = k.org_id and p.id = k.property_id
        where k.org_id = $1 and (k.key_code ilike '%' || $2 || '%' or k.description ilike '%' || $2 || '%'
              or k.current_holder_name ilike '%' || $2 || '%' or p.reference ilike '%' || $2 || '%')
        order by k.created_at desc, k.id`,
      [ORG, term],
    );
    expect(byReference.length).toBeGreaterThan(1000);
    await expectComplete("keys q=<property reference>", admin, "keys", { q: term }, byReference);
  });

  it("tasks: every one of MY tasks — undated last, ties broken — and none of a colleague's", async () => {
    const mine = await EXPECTED.tasks(admin.id);
    const a = await expectComplete("tasks admin", admin, "tasks", {}, mine);
    expect(a.body).not.toContain(`TA${TAG}`);
    expect(a.rows.at(-1)!.Due, "undated tasks come last").toBe("");
    await expectComplete("tasks agent", agent, "tasks", {}, await EXPECTED.tasks(agent.id));
  });

  it("viewings: every viewing, all time", async () => {
    const a = await expectComplete("viewings", admin, "viewings", {}, await EXPECTED.viewings());
    expect(new Set(a.rows.map((r) => r.Attendee))).toEqual(new Set([`Attendee ${TAG}`]));
  });

  it("properties: the default scope, the archived scope, a type filter", async () => {
    const a = await expectComplete("properties default", admin, "properties", {}, await EXPECTED.properties("default"));
    expect(a.body).not.toContain(`PRX${TAG}`);
    await expectComplete("properties archived", admin, "properties", { scope: "archived" }, await EXPECTED.properties("archived"));
    await expectComplete("properties villa", admin, "properties", { type: "villa" }, await EXPECTED.properties("default", "villa"));
  });

  it("properties: the mandate filters — an !inner embed paged past the cap, and an exclusion list", async () => {
    const active = await column(
      `select p.reference as v from properties p where p.org_id = $1 and p.kind <> 'unit'
         and p.status <> 'withdrawn' and p.visibility <> 'archived'
         and exists (select 1 from mandates m where m.property_id = p.id and m.status = 'active')
       order by p.created_at desc, p.id`,
      [ORG],
    );
    expect(active).toHaveLength(1100);
    const a = await expectComplete("properties mandate=active", admin, "properties", { mandate: "active" }, active);
    expect(new Set(a.rows.map((r) => r.Mandate))).toEqual(new Set(["exclusive"]));
    const none = await column(
      `select p.reference as v from properties p where p.org_id = $1 and p.kind <> 'unit'
         and p.status <> 'withdrawn' and p.visibility <> 'archived'
         and not exists (select 1 from mandates m where m.property_id = p.id and m.status in ('active', 'expired'))
       order by p.created_at desc, p.id`,
      [OTHER_ORG],
    );
    expect(none.length).toBeGreaterThan(1000);
    await expectComplete("properties mandate=none (other org's own admin)", outsider, "properties", { mandate: "none" }, none);
  });
});

describe("the ceiling: complete up to 10,000, refused past it", () => {
  it.each([0, 999, 1000, 1001, 2501, 10_000])("%i matching contacts export completely", async (n) => {
    await seedSizeOrg(n);
    const expected = await column(
      "select display_name as v from contacts where org_id = $1 and not is_archived order by created_at desc, id",
      [SIZE_ORG],
    );
    expect(expected).toHaveLength(n);
    await expectComplete(`size ${n}`, sizer, "contacts", {}, expected);
    expect(Math.max(0, ...pagesOf("contacts").map((p) => p.offset + p.limit))).toBeLessThanOrEqual(10_001);
  }, 120_000);

  it("10,001 matching contacts: refused with a reason — nothing downloaded, nothing audited", async () => {
    await seedSizeOrg(10_001);
    const before = await exportedEvents(SIZE_ORG);
    const a = await exportAs(sizer, "contacts");
    const after = await exportedEvents(SIZE_ORG);
    const pages = pagesOf("contacts");
    console.log(
      `[evidence] size 10001: status ${a.status}, reason ${a.json?.reason}, csv rows ${a.rows.length},` +
        ` pages ${pages.length}, furthest row asked ${Math.max(...pages.map((p) => p.offset + p.limit))}, audit lines +${after.count - before.count}`,
    );
    expect(a.status).toBe(422);
    expect(a.type).toContain("application/json");
    expect(a.cacheControl).toBe("no-store");
    expect(a.json?.reason).toBe("too_many");
    expect(a.json?.error).toMatch(/More than 10,000 records match/);
    expect(a.disposition).toBe("");
    expect(after.count).toBe(before.count);
    // the bound: never more than ONE row past the ceiling
    expect(Math.max(...pages.map((p) => p.offset + p.limit))).toBe(10_001);
  }, 120_000);
});

describe("a list with no filters past the ceiling", () => {
  it("10,001 of MY tasks: refused, and not told to narrow filters it does not have", async () => {
    await pg.query(
      `insert into tasks (org_id, title, assignee_id, created_by)
       select $1::uuid, format('TS%s-%s', $2::text, lpad(g::text, 5, '0')), $3::uuid, $3::uuid
         from generate_series(1, 10001) g`,
      [SIZE_ORG, TAG, sizer.id],
    );
    try {
      const before = await exportedEvents(SIZE_ORG);
      const a = await exportAs(sizer, "tasks");
      console.log(`[evidence] 10001 tasks: status ${a.status}, reason ${a.json?.reason}, message "${a.json?.error}"`);
      expect(a.status).toBe(422);
      expect(a.json?.reason).toBe("too_many");
      expect(a.json?.error).toMatch(/no filters to narrow it/);
      expect((await exportedEvents(SIZE_ORG)).count).toBe(before.count);
    } finally {
      await pg.query("delete from tasks where org_id = $1", [SIZE_ORG]);
    }
  }, 120_000);
});

describe("a server capped BELOW the page size still yields every row", () => {
  it.each([300, 750])("max_rows = %i", async (cap) => {
    try {
      await setServerCap(cap);
      await expectComplete(`contacts at max_rows ${cap}`, admin, "contacts", {}, await EXPECTED.contacts(false));
      await expectComplete(`tasks at max_rows ${cap}`, admin, "tasks", {}, await EXPECTED.tasks(admin.id));
      await seedSizeOrg(10_001);
      const over = await exportAs(sizer, "contacts");
      console.log(`[evidence] 10001 at max_rows ${cap}: status ${over.status}, reason ${over.json?.reason}`);
      expect(over.status).toBe(422);
    } finally {
      await setServerCap(null);
    }
  }, 180_000);
});

describe("a failure releases no CSV", () => {
  const ALL: [Route, Record<string, string>][] = [
    ["pipeline", { type: "sale" }],
    ["contacts", {}],
    ["leads", { status: "all" }],
    ["keys", {}],
    ["tasks", {}],
    ["viewings", {}],
    ["properties", {}],
  ];

  it.each(ALL)("%s: the second page fails → 500, no CSV, no audit line", async (route, query) => {
    steer.failGet = { match: new RegExp(`/rest/v1/${TABLE[route]}\\?`), nth: 2, seen: 0 };
    const before = await exportedEvents(ORG);
    const a = await exportAs(admin, route, query);
    const after = await exportedEvents(ORG);
    console.log(`[evidence] ${route} page 2 fails: status ${a.status}, reason ${a.json?.reason}, csv rows ${a.rows.length}`);
    expect(steer.failGet.seen, "the export read a second page").toBeGreaterThanOrEqual(2);
    expect(a.status).toBe(500);
    expect(a.type).toContain("application/json");
    expect(a.json?.reason).toBe("failed");
    expect(a.rows).toEqual([]);
    expect(a.disposition).toBe("");
    expect(after.count).toBe(before.count);
  }, 60_000);

  it.each(ALL)("%s: the audit line cannot be written → no CSV", async (route, query) => {
    steer.failAudit = true;
    const before = await exportedEvents(ORG);
    let a: Answer | null = null;
    let thrown: unknown = null;
    try {
      a = await exportAs(admin, route, query); // ONLY the call: an assertion must never land in the catch
    } catch (e) {
      thrown = e;
    }
    const outcome = a ? `answered ${a.status} ${a.type}` : `threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
    console.log(`[evidence] ${route} audit fails: ${outcome}`);
    expect(a?.type ?? "", "a CSV left without its audit line").not.toContain("text/csv");
    expect(a?.status ?? 500).not.toBe(200);
    expect(steer.auditAttempts, "the audit insert was attempted").toBeGreaterThanOrEqual(1);
    expect((await exportedEvents(ORG)).count).toBe(before.count);
  }, 60_000);

  it("keys: the property-reference lookup cannot be read → 500 with the reason, never a narrower CSV", async () => {
    steer.failGet = { match: /\/rest\/v1\/properties\?select=id&reference=ilike/, nth: 1, seen: 0 };
    const before = await exportedEvents(ORG);
    const a = await exportAs(admin, "keys", { q: `PR${TAG}-0000` });
    console.log(`[evidence] keys reference lookup fails: status ${a.status}, reason ${a.json?.reason}`);
    expect(steer.failGet.seen).toBe(1);
    expect(a.status).toBe(500);
    expect(a.json?.reason).toBe("failed");
    expect((await exportedEvents(ORG)).count).toBe(before.count);
  }, 60_000);

  it("properties: the mandate exclusion cannot be read → 500 with the reason, no CSV", async () => {
    steer.failGet = { match: /\/rest\/v1\/mandates_safe\?/, nth: 1, seen: 0 };
    const before = await exportedEvents(OTHER_ORG);
    const a = await exportAs(outsider, "properties", { mandate: "none" });
    console.log(`[evidence] properties mandate lookup fails: status ${a.status}, reason ${a.json?.reason}`);
    expect(steer.failGet.seen).toBe(1);
    expect(a.status).toBe(500);
    expect(a.json?.reason).toBe("failed");
    expect((await exportedEvents(OTHER_ORG)).count).toBe(before.count);
  }, 60_000);

  it.each([
    ["pipeline", { type: "sale" }],
    ["contacts", {}],
    ["leads", { status: "all" }],
  ] as [Route, Record<string, string>][])(
    "%s: the Agent names cannot be read → 500, never a CSV with every Agent cell blank",
    async (route, query) => {
      steer.failGet = { match: /\/rest\/v1\/profiles\?select=id%2Cfull_name%2Cis_active/, nth: 1, seen: 0 };
      const before = await exportedEvents(ORG);
      const a = await exportAs(admin, route, query);
      console.log(`[evidence] ${route} agent names fail: status ${a.status}, csv rows ${a.rows.length}`);
      expect(steer.failGet.seen).toBe(1);
      expect(a.status).toBe(500);
      expect(a.json?.reason).toBe("failed");
      expect((await exportedEvents(ORG)).count).toBe(before.count);
    },
    60_000,
  );
});
