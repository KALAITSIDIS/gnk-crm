import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  ANON_KEY,
  SERVICE_ROLE_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * A project's units page — and its sales-velocity card — holds whatever the
 * number of sold units or sale events: through the REAL units page, against a
 * REAL PostgREST behind the local Kong, with a real aal2 session
 * (T-velocity-id-lists).
 *
 * At b6be170 `fetchProjectVelocity` read the project's units in one unpaged
 * request, then the sold units' sale events with every sold unit's id in the
 * URL (`.in("entity_id", soldIds)`), also unpaged:
 *   1. past about 204 sold units the gateway answered 414 — and the units page
 *      awaits the card, so the whole page fell over (matrix, price lists, the
 *      reprice form);
 *   2. past 1,000 events PostgREST's max_rows cut the read silently, and the
 *      sold units whose events were cut were reported "sold, no date";
 *   3. past 1,000 units the unit read itself was cut silently.
 *
 * WHAT IT PINS (each case prints one `[evidence]` line):
 *   1. 230 units, 215 sold, each with its sale event: the page renders and the
 *      card counts 230 units, 215 sold, every one dated;
 *   2. 150 sold units with ten earlier events each (1,650 events; 1,100 in the first slice of 100): every sale
 *      still dated;
 *   3. 1,005 units: the card counts 1,005;
 *   4. no request carries an id list longer than a bounded slice, and every
 *      request the service role sends carries the organisation — a second
 *      organisation holds an EARLIER "sold" event for every one of A's units,
 *      so a slice or page that lost the filter would date those sales years ago.
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const FOREIGN = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `velocity-id-lists-${RUN}`;

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  /** every GET the service-role client sends (the event read runs on it) */
  const adminGets: string[] = [];
  return { als: new AsyncLocalStorage<unknown>(), adminGets };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound()");
  },
  redirect: (to: string) => {
    throw new Error(`redirect(${to})`);
  },
}));
// the real service-role client, its GETs recorded
vi.mock("@/lib/supabase/admin", async () => {
  const { createClient: make } = await import("@supabase/supabase-js");
  const h = await import("./helpers");
  return {
    createAdminClient: () =>
      make(h.SUPABASE_URL, h.SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if ((init?.method ?? "GET").toUpperCase() === "GET") ctx.adminGets.push(url);
            return fetch(input, init);
          },
        },
      }),
  };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound for this page");
    return c;
  },
}));

import ProjectUnitsPage from "@/app/(app)/properties/[id]/units/page";
import { SalesVelocityCard } from "@/components/features/properties/sales-velocity-card";
import type { VelocityResult } from "@/lib/services/sales-velocity";

// ---------------------------------------------------------------------------
let client: SupabaseClient;
const gets: string[] = [];

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

/** The card's numbers from the real units page, or what the page threw. */
async function velocityOf(projectId: string) {
  gets.length = 0;
  ctx.adminGets.length = 0;
  try {
    const root = (await ctx.als.run(client, () =>
      ProjectUnitsPage({ params: Promise.resolve({ id: projectId }), searchParams: Promise.resolve({}) }),
    )) as ReactNode;
    const card = [...walk(root)].find((e) => e.type === SalesVelocityCard);
    if (!card) throw new Error("the page rendered no velocity card");
    return { v: card.props.velocity as VelocityResult, thrown: null as string | null };
  } catch (e) {
    return { v: null, thrown: e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e) };
  }
}

// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
const projects: Record<"A" | "B" | "C", string> = { A: "", B: "", C: "" };

/** A project with `n` units, the first `sold` of them sold. */
async function project(code: string, n: number, sold: number): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type, kind, status) values ($1, $2, 'apartment', 'project', 'available') returning id",
    [ORG, `V${code}${TAG}`],
  );
  const pid = rows[0]!.id;
  await pg.query(
    `insert into properties (org_id, reference, property_type, kind, parent_id, status, asking_price)
     select $1::uuid, format('V%s%s-%s', $2::text, $3::text, lpad(g::text, 4, '0')), 'apartment', 'unit', $4::uuid,
            case when g <= $6::int then 'sold' else 'available' end::property_status, 200000
       from generate_series(1, $5::int) g`,
    [ORG, code, TAG, pid, n, sold],
  );
  return pid;
}

/** For each sold unit of `projectId`: `noise` earlier non-status events, then its sale event. */
async function saleEvents(projectId: string, noise: number) {
  if (noise > 0) {
    await pg.query(
      `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
       select $1::uuid, null, 'property', u.id, 'updated', jsonb_build_object('changed', jsonb_build_object('notes', jsonb_build_object('to', g)))
         from properties u, generate_series(1, $3::int) g
        where u.parent_id = $2 and u.status = 'sold'`,
      [ORG, projectId, noise],
    );
  }
  await pg.query(
    `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
     select $1::uuid, null, 'property', u.id, 'status_changed', '{"from":"available","to":"sold"}'::jsonb
       from properties u where u.parent_id = $2 and u.status = 'sold'`,
    [ORG, projectId],
  );
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  // the units page's event read runs on the service-role client (createAdminClient)
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= SERVICE_ROLE_KEY;

  await ensureTestOrg(svc, ORG, `Velocity ${RUN}`, SLUG);
  admin = await createTestUser(svc, `vel-admin-${RUN}@test.local`, "admin", ORG);
  const s = (await admin.client.auth.getSession()).data.session!;
  client = createClient(SUPABASE_URL, ANON_KEY, {
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
  if (error) throw new Error(`setSession: ${error.message}`);

  // A: past the ~204 ids one URL took
  projects.A = await project("A", 230, 215);
  await saleEvents(projects.A, 0);
  // another organisation's events about the same ids, three years EARLIER: the
  // earliest sale wins, so any unscoped read moves those sales out of the series
  await ensureTestOrg(svc, FOREIGN, `Velocity foreign ${RUN}`, `${SLUG}-foreign`);
  await pg.query(
    `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload, occurred_at)
     select $1::uuid, null, 'property', u.id, 'status_changed', '{"from":"available","to":"sold"}'::jsonb,
            now() - interval '3 years'
       from properties u where u.parent_id = $2 and u.status = 'sold'`,
    [FOREIGN, projects.A],
  );
  // B: under that, but 1,650 events — 1,100 in the first slice of 100 sold units, past PostgREST's 1,000 rows; the sale
  // events are the LATEST, so a read cut at 1,000 in time order loses them
  projects.B = await project("B", 160, 150);
  await saleEvents(projects.B, 10);
  // C: 1,005 units, none sold — past 1,000 on the unit read itself
  projects.C = await project("C", 1005, 0);
  await pg.query("analyze properties; analyze events;");
}, 300_000);

afterAll(async () => {
  await pg.query("delete from events where org_id = any($1::uuid[])", [[ORG, FOREIGN]]);
  await pg.query("delete from properties where org_id = $1 and kind = 'unit'", [ORG]);
  await pg.query("delete from properties where org_id = $1", [ORG]);
  await svc.auth.admin.deleteUser(admin.id);
  for (const t of ["profiles", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [[ORG, FOREIGN]]);
  }
  await pg.query("delete from organizations where id = any($1::uuid[])", [[ORG, FOREIGN]]);
  await pg.end();
}, 300_000);

// ---------------------------------------------------------------------------
describe("the units page's sales velocity holds at any size", () => {
  it("230 units, 215 sold: the page renders and every sale is counted and dated", async () => {
    const { v, thrown } = await velocityOf(projects.A);
    const longest = Math.max(0, ...[...gets, ...ctx.adminGets].map((u) => decodeURIComponent(u).length));
    console.log(`[evidence] 215 sold: ${thrown ? `THREW ${thrown}` : `units ${v!.totalUnits}, sold ${v!.soldTotal}, dated ${v!.soldDated}, undated ${v!.soldUndated}, in the last 12 months ${v!.soldLast12}`}; longest GET ${longest} chars`);
    expect(thrown).toBeNull();
    expect(v!.totalUnits).toBe(230);
    expect(v!.soldTotal).toBe(215);
    expect(v!.soldDated).toBe(215);
    expect(v!.soldUndated).toBe(0);
    // dated by THIS organisation's events, not the other one's three years earlier
    expect(v!.soldLast12).toBe(215);
  }, 120_000);

  it("150 sold units with 1,650 events: every sale still dated", async () => {
    const events = Number((await pg.query<{ n: string }>(
      "select count(*) as n from events e join properties u on u.id = e.entity_id where u.parent_id = $1",
      [projects.B],
    )).rows[0]!.n);
    expect(events).toBe(150 * 11);
    const { v, thrown } = await velocityOf(projects.B);
    console.log(`[evidence] ${events} events: ${thrown ? `THREW ${thrown}` : `sold ${v!.soldTotal}, dated ${v!.soldDated}, undated ${v!.soldUndated}`}`);
    expect(thrown).toBeNull();
    expect(v!.soldTotal).toBe(150);
    expect(v!.soldDated).toBe(150);
    expect(v!.soldUndated).toBe(0);
  }, 120_000);

  it("1,005 units: the card counts every one", async () => {
    const { v, thrown } = await velocityOf(projects.C);
    console.log(`[evidence] 1,005 units: ${thrown ? `THREW ${thrown}` : `units ${v!.totalUnits}`}`);
    expect(thrown).toBeNull();
    expect(v!.totalUnits).toBe(1005);
  }, 120_000);

  it("no request carries an id list longer than a bounded slice; every sold unit is asked about, within the organisation", async () => {
    const { thrown } = await velocityOf(projects.A);
    const decoded = ctx.adminGets.map((u) => decodeURIComponent(u));
    const lists = decoded
      .map((u) => /entity_id=in\.\(([^)]*)\)/.exec(u)?.[1])
      .filter((x): x is string => x !== undefined)
      .map((x) => x.split(","));
    const asked = new Set(lists.flat());
    const unscoped = decoded.filter((u) => !u.includes(`org_id=eq.${ORG}`)).length;
    console.log(`[evidence] event reads by id: ${lists.length}, ids per read ${lists.map((l) => l.length).join("/")}; distinct ids ${asked.size}; service-role GETs ${decoded.length}, without the organisation ${unscoped}`);
    expect(thrown).toBeNull();
    expect(lists.length, "the sold units' events are read").toBeGreaterThan(0);
    expect(Math.max(...lists.map((l) => l.length)), "a bounded slice of the ids per request").toBeLessThanOrEqual(150);
    expect(asked.size, "every sold unit asked about").toBe(215);
    expect(lists.length, "every service-role GET is an event read").toBe(decoded.length);
    expect(unscoped, "the service role has no RLS: every request carries the organisation").toBe(0);
  }, 120_000);
});
