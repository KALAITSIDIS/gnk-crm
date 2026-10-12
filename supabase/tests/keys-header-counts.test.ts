import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
 * The Keys page header ("N registered · M out") and its Export button tell the
 * truth: a count that could not be read is the page's load failure, never a
 * zero — through the REAL page server component against a REAL PostgREST, with
 * the session's RLS and aal2 token (T-keys-header-counts).
 *
 * At 547df43 the page read both register-wide counts as `count ?? 0` and never
 * looked at `.error`, and the Export button renders only when the registered
 * count is above 0. So a failed count painted "0 registered" (or "0 out") over a
 * register that had keys, and hid Export. Now both go through `unwrapCount`,
 * which throws to the segment's error boundary — on an error, AND on a
 * response with no count at all (postgrest-js answers a HEAD request's 404 with
 * `status 204, error null, count null`).
 *
 * WHAT IT PINS (each case prints one `[evidence]` line):
 *   1. real counts: the header equals the database's register-wide counts (a
 *      search does not narrow it) and Export is offered, carrying the search;
 *   2. genuine zeros stay valid: an organisation with keys but none out says
 *      "N registered · 0 out" with Export; one with no keys says
 *      "0 registered · 0 out", "No keys registered yet." and offers no Export;
 *   3. a failed registered count, a failed checked-out count, both, and a count
 *      response with no count (the 404 shape) each make the page throw
 *      "Query failed (…)" — never render a header;
 *   4. those requests really are the counts: the failure is injected into
 *      exactly the HEAD request it names, and the page's other reads succeed.
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
/** keys, some out */
const FULL = randomUUID();
/** keys, none out */
const IDLE = randomUUID();
/** no keys at all */
const EMPTY = randomUUID();
const ORGS = [FULL, IDLE, EMPTY];

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
import { KeysRegister } from "@/components/features/keys/keys-register";
import { ExportCsvButton } from "@/components/features/shared/export-csv-button";

type Params = Record<string, string>;

// ---------------------------------------------------------------------------
// A real session per user; every REST request it sends is recorded with its
// method, and one chosen request can be answered instead of sent
// ---------------------------------------------------------------------------
interface Steer {
  /** which request: method + URL */
  match: (method: string, url: string) => boolean;
  /** the answer: a HEAD failure has no body, as from PostgREST */
  respond: () => Response;
  hits: number;
}
type Session = { client: SupabaseClient; sent: { method: string; url: string }[]; steer: Steer | null };
const sessions = new Map<TestUser, Session>();

async function session(user: TestUser): Promise<Session> {
  const known = sessions.get(user);
  if (known) return known;
  const s = (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const state: Session = { client: undefined as unknown as SupabaseClient, sent: [], steer: null };
  state.client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.includes("/rest/v1/")) {
          state.sent.push({ method, url });
          if (state.steer?.match(method, url)) {
            state.steer.hits++;
            return state.steer.respond();
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

interface Header {
  /** "N registered · M out" */
  header: string;
  /** the Export button's href, or null when none is offered */
  exportHref: string | null;
  emptyText: string;
  rows: number;
}

async function show(user: TestUser, params: Params = {}): Promise<Header> {
  const { client } = await session(user);
  const root = (await ctx.als.run(client, () => KeysPage({ searchParams: Promise.resolve({ ...params }) }))) as ReactNode;
  const els = [...walk(root)];
  const header = els.find((e) => e.type === "p" && /registered ·/.test(textOf(e)));
  const exportButton = els.find((e) => e.type === ExportCsvButton);
  const register = els.find((e) => e.type === KeysRegister);
  if (!register) throw new Error("the keys page rendered no register");
  return {
    header: header ? textOf(header) : "",
    exportHref: exportButton ? String(exportButton.props.href) : null,
    emptyText: String(register.props.emptyText),
    rows: (register.props.keys as unknown[]).length,
  };
}

/** The page's outcome: what it rendered, or the error it threw. */
async function outcome(user: TestUser, params: Params = {}): Promise<{ rendered: Header | null; thrown: string | null }> {
  try {
    return { rendered: await show(user, params), thrown: null };
  } catch (e) {
    return { rendered: null, thrown: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let full: TestUser;
let idle: TestUser;
let empty: TestUser;
const userIds: string[] = [];

async function seedKeys(org: string, n: number, out: number): Promise<void> {
  const { rows } = await pg.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id",
    [org, `KH${TAG}-${org.slice(0, 4)}`],
  );
  await pg.query(
    `insert into property_keys (org_id, property_id, key_code, status, current_holder_name)
     select $1::uuid, $2::uuid, format('KH%s-%s', $3::text, lpad(g::text, 4, '0')),
            (case when g <= $5::int then 'checked_out' else 'in_office' end)::key_status,
            case when g <= $5::int then 'A holder' end
       from generate_series(1, $4::int) g`,
    [org, rows[0]!.id, TAG, n, out],
  );
}

const registerCounts = async (org: string): Promise<string> => {
  const { rows } = await pg.query<{ n: string; out: string }>(
    "select count(*) as n, count(*) filter (where status = 'checked_out') as out from property_keys where org_id = $1",
    [org],
  );
  return `${rows[0]!.n} registered · ${rows[0]!.out} out`;
};

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  for (const [org, name] of [[FULL, "full"], [IDLE, "idle"], [EMPTY, "empty"]] as const) {
    await ensureTestOrg(svc, org, `Keys header ${name} ${RUN}`, `keys-header-${name}-${RUN}`);
  }
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  full = await createTestUser(svc, `khc-full-${RUN}@test.local`, "admin", FULL);
  userIds.push(full.id);
  idle = await createTestUser(svc, `khc-idle-${RUN}@test.local`, "admin", IDLE);
  userIds.push(idle.id);
  empty = await createTestUser(svc, `khc-empty-${RUN}@test.local`, "admin", EMPTY);
  userIds.push(empty.id);
  await seedKeys(FULL, 40, 7);
  await seedKeys(IDLE, 12, 0);
}, 300_000);

afterAll(async () => {
  await pg.query("delete from property_keys where org_id = any($1::uuid[])", [ORGS]);
  await pg.query("delete from properties where org_id = any($1::uuid[])", [ORGS]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
  await pg.query("delete from organizations where id = any($1::uuid[])", [ORGS]);
  await pg.end();
}, 300_000);

// the two register-wide counts, as the page sends them
const isRegisteredCount = (method: string, url: string) =>
  method === "HEAD" && /\/rest\/v1\/property_keys\?select=id$/.test(url);
const isCheckedOutCount = (method: string, url: string) =>
  method === "HEAD" && /\/rest\/v1\/property_keys\?select=id&status=eq\.checked_out$/.test(url);
/** A HEAD failure as PostgREST sends it: a status, no body. */
const failWith = (status: number) => () => new Response(null, { status });

// ---------------------------------------------------------------------------
describe("the keys page header states the register's counts, or fails", () => {
  it("real counts: the register-wide figures, unchanged by a search, and Export (carrying the search)", async () => {
    const want = await registerCounts(FULL);
    const plain = await show(full);
    const searched = await show(full, { q: `KH${TAG}-000`, status: "in_office" });
    console.log(`[evidence] keys header (40 keys, 7 out): "${plain.header}" export ${plain.exportHref}; searched "${searched.header}" export ${searched.exportHref}, ${searched.rows} rows`);
    expect(want).toBe("40 registered · 7 out");
    expect(plain.header).toBe(want);
    expect(plain.exportHref).toBe("/keys/export");
    expect(searched.header, "a search never narrows the header").toBe(want);
    expect(searched.exportHref).toBe(`/keys/export?q=KH${TAG}-000&status=in_office`);
    // the page sent both counts as HEAD requests — the shapes the failure cases steer
    const { sent } = await session(full);
    expect(sent.some((r) => isRegisteredCount(r.method, r.url)), "the registered count's request").toBe(true);
    expect(sent.some((r) => isCheckedOutCount(r.method, r.url)), "the checked-out count's request").toBe(true);
  }, 60_000);

  it("genuine zeros stay valid: keys but none out; no keys at all", async () => {
    const some = await show(idle);
    const none = await show(empty);
    console.log(`[evidence] keys header (12 keys, 0 out): "${some.header}" export ${some.exportHref}; (no keys): "${none.header}" export ${none.exportHref} "${none.emptyText}"`);
    expect(some.header).toBe(await registerCounts(IDLE));
    expect(some.header).toBe("12 registered · 0 out");
    expect(some.exportHref).toBe("/keys/export");
    expect(none.header).toBe("0 registered · 0 out");
    expect(none.exportHref, "nothing to export").toBeNull();
    expect(none.emptyText).toBe("No keys registered yet.");
    expect(none.rows).toBe(0);
  }, 60_000);

  const FAILURES: [string, (m: string, u: string) => boolean, () => Response, RegExp][] = [
    ["the registered count fails (500)", isRegisteredCount, failWith(500), /^Query failed \(key count\): HTTP 500$/],
    ["the registered count is refused (401)", isRegisteredCount, failWith(401), /^Query failed \(key count\): HTTP 401$/],
    ["the checked-out count fails (500)", isCheckedOutCount, failWith(500), /^Query failed \(checked-out key count\): HTTP 500$/],
    // 502, not 503: postgrest-js retries a HEAD's 503/520 three times with backoff
    ["both counts fail", (m, u) => isRegisteredCount(m, u) || isCheckedOutCount(m, u), failWith(502), /^Query failed \(key count\): HTTP 502$/],
    // postgrest-js turns a HEAD 404 into status 204, error null, count null
    ["the registered count answers 404 (no count, no error)", isRegisteredCount, failWith(404), /^Query failed \(key count\): no count returned \(HTTP 204\)$/],
    ["the checked-out count answers without a count", isCheckedOutCount, () => new Response(null, { status: 200 }), /^Query failed \(checked-out key count\): no count returned \(HTTP 200\)$/],
    // what PostgREST sends when it computed no count: postgrest-js parses the "*" as NaN
    ["the registered count answers an uncounted range (*/*)", isRegisteredCount,
      () => new Response(null, { status: 200, headers: { "content-range": "*/*" } }),
      /^Query failed \(key count\): no count returned \(HTTP 200\)$/],
  ];

  it.each(FAILURES)("%s → the page's load failure, never a header", async (label, match, respond, says) => {
    const s = await session(full);
    s.steer = { match, respond, hits: 0 };
    try {
      const o = await outcome(full);
      console.log(`[evidence] keys header, ${label}: ${o.thrown ? `threw "${o.thrown}"` : `RENDERED "${o.rendered?.header}" export ${o.rendered?.exportHref}`}`);
      expect(s.steer.hits, "the steered count was requested").toBeGreaterThanOrEqual(1);
      expect(o.rendered, "nothing rendered over a failed count").toBeNull();
      expect(o.thrown).toMatch(says);
    } finally {
      s.steer = null;
    }
  }, 60_000);

  it("after a failure the same session renders again — the failure was the count, not the session", async () => {
    const again = await show(full);
    expect(again.header).toBe(await registerCounts(FULL));
  }, 60_000);
});
