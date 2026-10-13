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
 * A read whose answer holds no rows array fails the page by name — through the
 * REAL units page and the REAL property page, a real aal2 session, a REAL
 * PostgREST behind the local Kong — instead of rendering "nothing here"
 * (T-null-answer-guard).
 *
 * postgrest-js reports an OK answer with an EMPTY BODY as `data: null, error:
 * null` (measured on 2.110.2, with a 404 with an empty body and a `null` body).
 * At 2ca7b2a `unwrapRows` returned `[]` for it and `fetchAll` stopped on it:
 *   1. the units page's unit read (fetchAll over unwrapRows) — page 2 answered
 *      with an empty body — rendered the first 1,000 of 1,005 units, silently;
 *   2. the property page's keys read (unwrapRows) — answered with an empty
 *      body — said "No keys registered for this property." over a property
 *      with a key.
 * A fault is the only way such an answer arrives, so the test injects it: the
 * session client's `fetch` answers ONE read (matched by its URL) with an
 * empty-bodied 200, and passes every other request to the real stack. Each
 * case has a control render with nothing injected.
 *
 * THROWAWAY ORGANISATION, deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `null-answer-guard-${RUN}`;

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>() };
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
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound for this page");
    return c;
  },
}));

import ProjectUnitsPage from "@/app/(app)/properties/[id]/units/page";
import PropertyDetailPage from "@/app/(app)/properties/[id]/page";
import { UnitsMatrix } from "@/components/features/properties/units-matrix";

// ---------------------------------------------------------------------------
let client: SupabaseClient;
/** The read to answer with an empty body, by its URL — null: none. */
let hollow: ((url: string) => boolean) | null = null;
const hollowed: string[] = [];

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

/** Render a page in the session; what it rendered, or what it threw. */
async function render(page: () => Promise<unknown>, fault: ((url: string) => boolean) | null) {
  hollow = fault;
  hollowed.length = 0;
  try {
    const root = (await ctx.als.run(client, page)) as ReactNode;
    return { root, thrown: null as string | null, hollowed: [...hollowed] };
  } catch (e) {
    return { root: null, thrown: e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : String(e), hollowed: [...hollowed] };
  } finally {
    hollow = null;
  }
}

const unitsPage = (id: string) => () =>
  ProjectUnitsPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
const propertyPage = (id: string) => () =>
  PropertyDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });

/** The units the matrix was given. */
const matrixUnits = (root: ReactNode) => {
  const m = [...walk(root)].find((e) => e.type === UnitsMatrix);
  return m ? (m.props.units as unknown[]).length : null;
};
/** Whether the page said there are no keys. */
const saysNoKeys = (root: ReactNode) =>
  [...walk(root)].some((e) => e.type === "p" && e.props.children === "No keys registered for this property.");
/** Whether the page listed the listing's key by its code. */
const listsKey = (root: ReactNode) => [...walk(root)].some((e) => e.props.children === `K${TAG}`);

/** The units page's own unit read (ordered by block), page 2. */
const unitsPage2 = (url: string) => {
  const u = decodeURIComponent(url);
  return /\/rest\/v1\/properties\?/.test(u) && u.includes("order=block") && /[?&]offset=1000(&|$)/.test(u);
};
/** The property page's keys read. */
const keysRead = (url: string) => /\/rest\/v1\/property_keys\?/.test(decodeURIComponent(url));

// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let projectId = "";
let listingId = "";

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  // both pages also build a service-role client (createAdminClient)
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= SERVICE_ROLE_KEY;

  await ensureTestOrg(svc, ORG, `Null answers ${RUN}`, SLUG);
  admin = await createTestUser(svc, `nag-admin-${RUN}@test.local`, "admin", ORG);
  const s = (await admin.client.auth.getSession()).data.session!;
  client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if ((init?.method ?? "GET").toUpperCase() === "GET" && hollow?.(url)) {
          hollowed.push(url);
          return new Response("", { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
        }
        return fetch(input, init);
      },
    },
  });
  const { error } = await client.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession: ${error.message}`);

  // a project with 1,005 units: the units read takes two pages
  projectId = (await pg.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type, kind, status) values ($1, $2, 'apartment', 'project', 'available') returning id",
    [ORG, `NP${TAG}`],
  )).rows[0]!.id;
  await pg.query(
    `insert into properties (org_id, reference, property_type, kind, parent_id, status, asking_price, block, unit_number)
     select $1::uuid, format('NP%s-%s', $2::text, lpad(g::text, 4, '0')), 'apartment', 'unit', $3::uuid, 'available', 200000,
            'A', lpad(g::text, 4, '0')
       from generate_series(1, 1005) g`,
    [ORG, TAG, projectId],
  );
  // a listing with one key
  listingId = (await pg.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type, kind, status) values ($1, $2, 'apartment', 'standalone', 'available') returning id",
    [ORG, `NL${TAG}`],
  )).rows[0]!.id;
  await pg.query("insert into property_keys (org_id, property_id, key_code) values ($1, $2, $3)", [ORG, listingId, `K${TAG}`]);
  await pg.query("analyze properties; analyze property_keys;");
}, 300_000);

afterAll(async () => {
  await pg.query("delete from events where org_id = $1", [ORG]);
  await pg.query("delete from property_keys where org_id = $1", [ORG]);
  await pg.query("delete from properties where org_id = $1 and kind = 'unit'", [ORG]);
  await pg.query("delete from properties where org_id = $1", [ORG]);
  await svc.auth.admin.deleteUser(admin.id);
  for (const t of ["profiles", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = $1`, [ORG]);
  }
  await pg.query("delete from organizations where id = $1", [ORG]);
  await pg.end();
}, 300_000);

// ---------------------------------------------------------------------------
describe("a page whose read comes back with no rows array fails by name", () => {
  it("the units page: its unit read's second page answered empty — the page throws, never 1,000 of 1,005", async () => {
    const control = await render(unitsPage(projectId), null);
    const r = await render(unitsPage(projectId), unitsPage2);
    console.log(
      `[evidence] units page: control ${control.thrown ?? `${matrixUnits(control.root)} units`}; ` +
        `page 2 empty (${r.hollowed.length} read hollowed) → ${r.thrown ? `THREW ${r.thrown}` : `rendered ${matrixUnits(r.root)} units`}`,
    );
    expect(control.thrown).toBeNull();
    expect(matrixUnits(control.root)).toBe(1005);
    expect(r.hollowed.length, "the fault reached the page's unit read").toBe(1);
    expect(r.thrown).toMatch(/Query failed \(units\): the answer held no rows \(HTTP 200\)/);
  }, 120_000);

  it("the property page: its keys read answered empty — the page throws, never 'No keys registered'", async () => {
    const control = await render(propertyPage(listingId), null);
    const r = await render(propertyPage(listingId), keysRead);
    console.log(
      `[evidence] property page: control ${control.thrown ?? `says no keys: ${saysNoKeys(control.root)}`}; ` +
        `keys read empty (${r.hollowed.length} read hollowed) → ${r.thrown ? `THREW ${r.thrown}` : `rendered, says no keys: ${saysNoKeys(r.root)}`}`,
    );
    expect(control.thrown).toBeNull();
    expect(saysNoKeys(control.root), "the listing has a key").toBe(false);
    expect(listsKey(control.root), "the key is listed").toBe(true);
    expect(r.hollowed.length, "the fault reached the page's keys read").toBe(1);
    expect(r.thrown).toMatch(/Query failed \(property keys\): the answer held no rows \(HTTP 200\)/);
  }, 120_000);
});
