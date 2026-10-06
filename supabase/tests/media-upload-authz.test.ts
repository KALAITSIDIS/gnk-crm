import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import sharp from "sharp";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  ANON_KEY,
  SERVICE_ROLE_KEY,
  SUPABASE_URL,
  TEST_PASSWORD,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * Property-media uploads through the REAL server action, against the REAL
 * stack: PostgREST, RLS, the events chain, and Storage (T-media-upload-authz).
 *
 * Only the Next.js plumbing is stubbed (deal-close-actions / price-uplift
 * shape): `createClient` hands the action a supabase-js client signed in as a
 * fixture user, and `createAdminClient` a real service-role client. Both run
 * over a fetch the test can steer, which is how failures are injected WHERE
 * THEY HAPPEN — an upload refused, thrown, slow, or stored with its answer
 * lost; an insert whose answer is lost; a read-back that fails; a cleanup the
 * store will not do; an event write that fails. What is left behind is read
 * from `storage.objects` and the tables as postgres, never from the action.
 *
 * WHAT IT PINS:
 *   1. the database: property reads are organisation-wide, media inserts are
 *      admin / listing manager / the assigned agent — and the action's own
 *      check (`mayInsertPropertyMedia`) gives the same answer for every role;
 *   2. who reaches the service role: admin, listing manager and the assigned
 *      agent upload; a same-organisation agent who can READ the listing,
 *      another organisation's admin, an aal1 session and a deactivated agent
 *      cause NO storage request at all;
 *   3. a failed original or rendition — refused, thrown, slow, or stored with
 *      a lost answer — leaves none of the attempt's objects and no row;
 *   4. a reassignment while the upload is in flight is refused by RLS at the
 *      insert, and the attempt's objects are removed;
 *   5. a lost insert answer never deletes the files of a committed row;
 *   6. a cleanup the store refuses is reported, not claimed;
 *   7. after the row commits, a failed event write leaves row and files and
 *      does not report a failure;
 *   8. a partly failed batch keeps — and counts — what it committed;
 *   9. controls: a photograph and a floor plan land where they always have,
 *      and nothing above touched another attempt's objects.
 *
 * A THROWAWAY ORGANISATION (plus another as the isolation control), deleted
 * at the end as postgres, objects and events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const RUN = Date.now().toString(36);

// ---------------------------------------------------------------------------
// Harness: which session an action gets, and the steerable fetches.
// ---------------------------------------------------------------------------
type Step = "pass" | "fail500" | "throw" | "drop" | { delayMs: number };
type Rule = (method: string, url: string) => Step | "hold";

const h = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    als: new AsyncLocalStorage<unknown>(),
    storageRule: null as null | ((method: string, url: string) => unknown),
    storageLog: [] as { method: string; url: string }[],
    sentry: [] as string[],
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: (m: string) => void h.sentry.push(m),
  captureException: () => {},
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = h.als.getStore();
    if (!c) throw new Error("test harness: no session bound for this action");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const helpers = await import("./helpers");
  const { createClient: make } = await import("@supabase/supabase-js");
  return {
    createAdminClient: () =>
      make(helpers.SUPABASE_URL, helpers.SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const method = (init?.method ?? "GET").toUpperCase();
            if (url.includes("/storage/v1/")) h.storageLog.push({ method, url });
            const step = (h.storageRule?.(method, url) ?? "pass") as Step;
            return steer(step, input, init);
          },
        },
      }),
  };
});

async function steer(step: Step, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  if (typeof step === "object") {
    await new Promise((r) => setTimeout(r, step.delayMs));
    return fetch(input, init);
  }
  switch (step) {
    case "fail500":
      return new Response(JSON.stringify({ statusCode: "500", error: "injected", message: "injected failure", code: "" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    case "throw":
      throw new TypeError("fetch failed (test: the request never left)");
    case "drop": {
      const res = await fetch(input, init);
      await res.text(); // the server has done it; the answer never arrives
      throw new TypeError("fetch failed (test: the answer was lost after the server replied)");
    }
    default:
      return fetch(input, init);
  }
}

import { uploadPropertyMedia, type MediaActionState } from "@/lib/actions/media";
import { mayInsertPropertyMedia } from "@/lib/services/media-upload";

// ---------------------------------------------------------------------------
// Session clients whose PostgREST traffic the test can steer and hold.
// ---------------------------------------------------------------------------
let sessionRule: Rule | null = null;
const held: { arrived: boolean; release: (() => void) | null } = { arrived: false, release: null };

function sessionFetch(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const step = sessionRule?.(method, url) ?? "pass";
    if (step === "hold") {
      held.arrived = true;
      await new Promise<void>((r) => (held.release = r));
      return fetch(input, init);
    }
    return steer(step, input, init);
  };
}

async function sessionOf(user: TestUser): Promise<SupabaseClient> {
  const { data } = await user.client.auth.getSession();
  if (!data.session) throw new Error(`no session for ${user.email}`);
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: sessionFetch() },
  });
  const { error } = await c.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  return c;
}

const isMediaInsert = (m: string, u: string) => m === "POST" && /\/rest\/v1\/property_media(\?|$)/.test(u);
const isMediaReadBack = (m: string, u: string) => m === "GET" && /\/rest\/v1\/property_media\?(.*&)?id=eq\./.test(u);
const isEventInsert = (m: string, u: string) => m === "POST" && /\/rest\/v1\/events(\?|$)/.test(u);
const isUpload = (m: string, u: string) => m === "POST" && /\/storage\/v1\/object\/(media|documents)\//.test(u);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser, manager: TestUser, agent: TestUser, otherAgent: TestUser;
let foreignAdmin: TestUser, deactAgent: TestUser, aal1Admin: TestUser;
const userIds: string[] = [];
let P1: string; // assigned to `agent`
let P2: string; // assigned to `deactAgent`, who is then deactivated

const photo = await sharp({
  create: { width: 64, height: 48, channels: 3, background: { r: 180, g: 60, b: 30 } },
})
  .jpeg()
  .toBuffer();

async function newProperty(assignee: string | null): Promise<string> {
  const ref = `MU${RUN}${Math.floor(Math.random() * 1e6)}`.slice(0, 20);
  const { rows } = await pg.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type, assigned_agent_id) values ($1, $2, 'apartment', $3) returning id",
    [ORG, ref, assignee],
  );
  return rows[0]!.id;
}

type Outcome = { result: MediaActionState | null; thrown: string | null };

async function act(
  user: TestUser,
  propertyId: string,
  opts: { kind?: "photo" | "floor_plan"; files?: number } = {},
): Promise<Outcome> {
  const client = await sessionOf(user);
  const fd = new FormData();
  fd.set("property_id", propertyId);
  fd.set("kind", opts.kind ?? "photo");
  for (let i = 0; i < (opts.files ?? 1); i++) {
    fd.append("files", new File([photo], `synthetic-${i}.jpg`, { type: "image/jpeg" }));
  }
  try {
    const result = await h.als.run(client, () => uploadPropertyMedia({ error: null, savedAt: null }, fd));
    return { result, thrown: null };
  } catch (e) {
    return { result: null, thrown: e instanceof Error ? e.message : String(e) };
  }
}

/** Every object under this listing, as storage itself records it. */
async function objectsOf(propertyId: string): Promise<string[]> {
  const { rows } = await pg.query<{ k: string }>(
    "select bucket_id || '/' || name as k from storage.objects where name like $1 order by 1",
    [`properties/${propertyId}/%`],
  );
  return rows.map((r) => r.k);
}
async function rowsOf(propertyId: string) {
  const { rows } = await pg.query<{
    id: string;
    kind: string;
    storage_path_original: string;
    path_thumb: string;
    path_card: string;
    path_full: string;
    path_jpeg: string | null;
    is_cover: boolean;
  }>("select * from property_media where property_id = $1 order by sort_order", [propertyId]);
  return rows;
}
async function uploadEventsOf(propertyId: string): Promise<number> {
  const { rows } = await pg.query<{ n: number }>(
    "select count(*)::int as n from events where entity_id = $1 and event_type = 'media_uploaded'",
    [propertyId],
  );
  return rows[0]!.n;
}
const newSince = (before: string[], after: string[]) => after.filter((k) => !before.includes(k));
function evidence(label: string, detail: unknown) {
  console.log(`[evidence] ${label}: ${JSON.stringify(detail)}`);
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Media upload ${RUN}`, `media-upload-${RUN}`);
  await ensureTestOrg(svc, OTHER_ORG, `Media upload other ${RUN}`, `media-upload-other-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `mu-admin-${RUN}@test.local`, "admin", ORG);
  manager = await createTestUser(svc, `mu-lm-${RUN}@test.local`, "listing_manager", ORG);
  agent = await createTestUser(svc, `mu-agent-${RUN}@test.local`, "agent", ORG);
  otherAgent = await createTestUser(svc, `mu-agent2-${RUN}@test.local`, "agent", ORG);
  deactAgent = await createTestUser(svc, `mu-agent3-${RUN}@test.local`, "agent", ORG);
  foreignAdmin = await createTestUser(svc, `mu-foreign-${RUN}@test.local`, "admin", OTHER_ORG);
  userIds.push(admin.id, manager.id, agent.id, otherAgent.id, deactAgent.id, foreignAdmin.id);
  // the same admin, signed in again WITHOUT the second factor: aal1
  const c = anonClient();
  const { error } = await c.auth.signInWithPassword({ email: admin.email, password: TEST_PASSWORD });
  if (error) throw new Error(`aal1 sign-in: ${error.message}`);
  aal1Admin = { ...admin, client: c };

  P1 = await newProperty(agent.id);
  P2 = await newProperty(deactAgent.id);
  // deactivated with a LIVE session: the JWT still verifies
  await pg.query("update profiles set is_active = false where id = $1", [deactAgent.id]);
}, 180_000);

afterEach(() => {
  h.storageRule = null;
  sessionRule = null;
  held.arrived = false;
  held.release?.();
  held.release = null;
});

afterAll(async () => {
  if (!pg) return;
  // storage refuses SQL deletes: list as postgres, remove through the API
  const { rows: leftover } = await pg.query<{ bucket_id: string; name: string }>(
    "select bucket_id, name from storage.objects where name like any (select 'properties/' || id || '/%' from properties where org_id = $1)",
    [ORG],
  );
  for (const bucket of ["media", "documents"]) {
    const names = leftover.filter((o) => o.bucket_id === bucket).map((o) => o.name);
    if (names.length) await svc.storage.from(bucket).remove(names);
  }
  for (const org of [ORG, OTHER_ORG]) {
    await pg.query("delete from property_media where org_id = $1", [org]);
    await pg.query("delete from properties where org_id = $1", [org]);
  }
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const org of [ORG, OTHER_ORG]) {
    await pg.query("delete from profiles where org_id = $1", [org]);
    await pg.query("delete from events where org_id = $1", [org]);
    await pg.query("delete from events_chain_checkpoint where org_id = $1", [org]);
    await pg.query("delete from chain_checks where org_id = $1", [org]);
    await pg.query("delete from deal_stages where org_id = $1", [org]);
    await pg.query("delete from districts where org_id = $1", [org]);
    await pg.query("delete from organizations where id = $1", [org]);
  }
  await pg.end();
}, 120_000);

// ---------------------------------------------------------------------------
describe("1. the database's rule, and the action's copy of it", () => {
  it("a property READ is organisation-wide; a media INSERT is not — and mayInsertPropertyMedia agrees for every role", async () => {
    const cases: [string, TestUser, boolean][] = [
      ["admin", admin, true],
      ["listing manager", manager, true],
      ["assigned agent", agent, true],
      ["same-org agent, not assigned", otherAgent, false],
      ["another organisation's admin", foreignAdmin, false],
      ["aal1 admin", aal1Admin, false],
    ];
    const table: Record<string, unknown> = {};
    for (const [label, user, expected] of cases) {
      const c = await sessionOf(user);
      const { data: readable } = await c.from("properties").select("id, org_id, assigned_agent_id").eq("id", P1).maybeSingle();
      const id = randomUUID();
      const { error } = await c.from("property_media").insert({
        id,
        org_id: ORG,
        property_id: P1,
        kind: "photo",
        storage_path_original: `properties/${P1}/original/${id}.jpg`,
        path_thumb: `properties/${P1}/${id}_thumb.webp`,
        sort_order: 900,
        created_by: user.id,
      });
      const dbAllows = !error;
      await pg.query("delete from property_media where id = $1", [id]);
      const { rows } = await pg.query<{ org_id: string; role: string }>("select org_id, role from profiles where id = $1", [user.id]);
      const appAllows = mayInsertPropertyMedia(
        { id: user.id, orgId: rows[0]!.org_id, role: rows[0]!.role as "admin" },
        { org_id: ORG, assigned_agent_id: agent.id },
      );
      table[label] = { readable: Boolean(readable), dbAllows, appAllows, code: error?.code ?? null };
      expect(dbAllows, `${label}: database`).toBe(expected);
      // aal1 is refused by require_aal2, which the action meets one step
      // earlier (getCurrentProfile reads nothing); the role rule itself is
      // the admin's
      if (label !== "aal1 admin") expect(appAllows, `${label}: application`).toBe(expected);
    }
    evidence("permission matrix on P1", table);
    expect((table["same-org agent, not assigned"] as { readable: boolean }).readable, "the read that used to stand in for permission").toBe(true);
  });
});

describe("2. who reaches the service role", () => {
  it.each([
    ["admin", () => admin, () => P1],
    ["listing manager", () => manager, () => P1],
    ["assigned agent", () => agent, () => P1],
  ])("%s uploads: five objects, one row, one event", async (label, who, prop) => {
    const p = prop();
    const before = await objectsOf(p);
    const rowsBefore = (await rowsOf(p)).length;
    const eventsBefore = await uploadEventsOf(p);
    const out = await act(who(), p);
    const added = newSince(before, await objectsOf(p));
    evidence(`authorised ${label}`, { out, added: added.length });
    expect(out.thrown).toBeNull();
    expect(out.result?.error).toBeNull();
    expect(added).toHaveLength(5);
    expect((await rowsOf(p)).length).toBe(rowsBefore + 1);
    expect(await uploadEventsOf(p)).toBe(eventsBefore + 1);
  });

  it.each([
    ["same-org agent who can read the listing", () => otherAgent, () => P1],
    ["another organisation's admin", () => foreignAdmin, () => P1],
    ["aal1 session", () => aal1Admin, () => P1],
    ["deactivated assigned agent", () => deactAgent, () => P2],
  ])("%s: refused with NO storage request at all", async (label, who, prop) => {
    const p = prop();
    const before = await objectsOf(p);
    const rowsBefore = (await rowsOf(p)).length;
    h.storageLog.length = 0;
    const out = await act(who(), p);
    evidence(`refused ${label}`, { out, storageRequests: h.storageLog.length });
    expect(out.thrown, "a refusal must be a result, not a throw").toBeNull();
    expect(out.result?.error).toBeTruthy();
    expect(h.storageLog, "the service role touched storage for a caller who may not upload").toEqual([]);
    expect(await objectsOf(p)).toEqual(before);
    expect((await rowsOf(p)).length).toBe(rowsBefore);
  });
});

describe("3. a failed upload leaves nothing of its attempt", () => {
  const targets = ["/original/", "_thumb.webp", "_card.webp", "_full.webp", "_jpeg.jpg"];

  it.each(targets)("%s refused by the store (500)", async (which) => {
    const before = await objectsOf(P1);
    const rowsBefore = (await rowsOf(P1)).length;
    h.storageRule = (m, u) => (isUpload(m, u) && u.includes(which) ? "fail500" : "pass");
    const out = await act(admin, P1);
    const left = newSince(before, await objectsOf(P1));
    evidence(`500 on ${which}`, { error: out.result?.error ?? out.thrown, left });
    expect(out.result?.error).toBeTruthy();
    expect(left).toEqual([]);
    expect((await rowsOf(P1)).length).toBe(rowsBefore);
  });

  it.each([
    ["thrown before sending", "throw"],
    ["stored, answer lost", "drop"],
  ] as const)("a rendition %s", async (label, step) => {
    const before = await objectsOf(P1);
    h.storageRule = (m, u) => (isUpload(m, u) && u.includes("_card.webp") ? step : "pass");
    const out = await act(admin, P1);
    const left = newSince(before, await objectsOf(P1));
    evidence(`rendition ${label}`, { error: out.result?.error ?? out.thrown, left });
    expect(out.thrown).toBeNull();
    expect(out.result?.error).toBeTruthy();
    expect(left).toEqual([]);
  });

  it("a SLOW sibling of a thrown upload is waited for, then removed — nothing lands afterwards", async () => {
    const before = await objectsOf(P1);
    h.storageRule = (m, u) =>
      isUpload(m, u) && u.includes("_thumb.webp")
        ? "throw"
        : isUpload(m, u) && u.includes("_full.webp")
          ? { delayMs: 400 }
          : "pass";
    const out = await act(admin, P1);
    await new Promise((r) => setTimeout(r, 800));
    const left = newSince(before, await objectsOf(P1));
    evidence("slow sibling", { error: out.result?.error ?? out.thrown, left });
    expect(out.thrown).toBeNull();
    expect(left).toEqual([]);
  });

  it("a cleanup the store refuses is REPORTED, never claimed", async () => {
    const before = await objectsOf(P1);
    h.sentry.length = 0;
    h.storageRule = (m, u) =>
      isUpload(m, u) && u.includes("_jpeg.jpg")
        ? "fail500"
        : m === "DELETE" && u.includes("/storage/v1/object/")
          ? "fail500"
          : "pass";
    const out = await act(admin, P1);
    const left = newSince(before, await objectsOf(P1));
    evidence("cleanup refused", { error: out.result?.error, left: left.length, sentry: h.sentry });
    expect(out.result?.error).toMatch(/could not be removed/i);
    expect(left.length).toBeGreaterThan(0);
    expect(h.sentry.some((m) => /cleanup could not be verified/.test(m))).toBe(true);
    // the test's own cleanup of what the action could not remove
    h.storageRule = null;
    await svc.storage.from("media").remove(left.filter((k) => k.startsWith("media/")).map((k) => k.slice(6)));
    await svc.storage.from("documents").remove(left.filter((k) => k.startsWith("documents/")).map((k) => k.slice(10)));
  });
});

describe("4–7. the media row", () => {
  it("4. reassigned while the upload is in flight: RLS refuses the row, the attempt's objects are removed", async () => {
    const P3 = await newProperty(agent.id);
    sessionRule = (m, u) => (isMediaInsert(m, u) ? "hold" : "pass");
    const pending = act(agent, P3);
    const t0 = Date.now();
    while (!held.arrived) {
      if (Date.now() - t0 > 20_000) throw new Error("the insert never arrived");
      await new Promise((r) => setTimeout(r, 25));
    }
    const midFlight = await objectsOf(P3);
    await pg.query("update properties set assigned_agent_id = $1 where id = $2", [otherAgent.id, P3]);
    held.release!();
    const out = await pending;
    const after = await objectsOf(P3);
    evidence("reassigned mid-flight", { error: out.result?.error, midFlight: midFlight.length, after });
    expect(midFlight).toHaveLength(5);
    expect(out.result?.error).toMatch(/not allowed/i);
    expect(after).toEqual([]);
    expect(await rowsOf(P3)).toEqual([]);
  });

  it("5. the insert's answer is LOST but the row committed: read back, kept, reported as saved", async () => {
    const before = await objectsOf(P1);
    const eventsBefore = await uploadEventsOf(P1);
    sessionRule = (m, u) => (isMediaInsert(m, u) ? "drop" : "pass");
    const out = await act(admin, P1);
    const added = newSince(before, await objectsOf(P1));
    evidence("lost insert answer, committed", { out, added: added.length });
    expect(out.result?.error).toBeNull();
    expect(added).toHaveLength(5);
    expect(await uploadEventsOf(P1)).toBe(eventsBefore + 1);
  });

  it("6. the answer is lost AND the read-back fails: the committed row keeps its files; the outcome is reported unknown", async () => {
    const before = await objectsOf(P1);
    const rowsBefore = await rowsOf(P1);
    h.sentry.length = 0;
    sessionRule = (m, u) => (isMediaInsert(m, u) ? "drop" : isMediaReadBack(m, u) ? "fail500" : "pass");
    const out = await act(admin, P1);
    const rowsAfter = await rowsOf(P1);
    const added = newSince(before, await objectsOf(P1));
    const committed = rowsAfter.filter((r) => !rowsBefore.some((b) => b.id === r.id));
    evidence("lost insert answer, unconfirmed", { error: out.result?.error, committed: committed.length, added: added.length, sentry: h.sentry });
    expect(out.result?.error).toMatch(/could not confirm/i);
    expect(committed, "the insert did commit in the database").toHaveLength(1);
    // every path the committed row names still exists
    const row = committed[0]!;
    for (const p of [row.storage_path_original, row.path_thumb, row.path_card, row.path_full, row.path_jpeg]) {
      expect(added.some((k) => k.endsWith(p!)), `committed row lost ${p}`).toBe(true);
    }
    expect(h.sentry.some((m) => /outcome unknown/.test(m))).toBe(true);
  });

  it("7. the event write fails AFTER the commit: row and files stay, the upload is not a failure", async () => {
    const before = await objectsOf(P1);
    const rowsBefore = (await rowsOf(P1)).length;
    const eventsBefore = await uploadEventsOf(P1);
    sessionRule = (m, u) => (isEventInsert(m, u) ? "fail500" : "pass");
    const out = await act(admin, P1);
    evidence("event failed after commit", { out });
    expect(out.thrown).toBeNull();
    expect(out.result?.error).toBeNull();
    expect(out.result?.warning).toMatch(/timeline/i);
    expect(newSince(before, await objectsOf(P1))).toHaveLength(5);
    expect((await rowsOf(P1)).length).toBe(rowsBefore + 1);
    expect(await uploadEventsOf(P1)).toBe(eventsBefore);
  });
});

describe("8–9. batches, controls, scope", () => {
  it("8. a two-file batch whose second file fails: the first stays, counted", async () => {
    const P4 = await newProperty(agent.id);
    let originals = 0;
    h.storageRule = (m, u) => {
      if (isUpload(m, u) && u.includes("/original/")) originals++;
      return isUpload(m, u) && originals === 2 && u.includes("_card.webp") ? "fail500" : "pass";
    };
    const out = await act(admin, P4, { files: 2 });
    const rows = await rowsOf(P4);
    const objects = await objectsOf(P4);
    evidence("batch, second fails", { out, rows: rows.length, objects: objects.length });
    expect(out.result?.error).toMatch(/1 of 2 saved/);
    expect(out.result?.saved).toBe(1);
    expect(rows).toHaveLength(1);
    expect(objects).toHaveLength(5);
  });

  it("9a. a photograph: public renditions (with the portal JPEG), private original, row = attempt id", async () => {
    const P5 = await newProperty(null);
    const out = await act(admin, P5);
    expect(out.result?.error).toBeNull();
    const [row] = await rowsOf(P5);
    const objects = await objectsOf(P5);
    expect(row!.is_cover).toBe(true);
    expect(row!.path_jpeg).toMatch(/_jpeg\.jpg$/);
    expect(objects).toEqual(
      [
        `documents/${row!.storage_path_original}`,
        `media/${row!.path_card}`,
        `media/${row!.path_full}`,
        `media/${row!.path_jpeg}`,
        `media/${row!.path_thumb}`,
      ].sort(),
    );
    expect(row!.path_full).toContain(row!.id);
    const pub = await fetch(svc.storage.from("media").getPublicUrl(row!.path_full).data.publicUrl);
    const orig = await fetch(svc.storage.from("documents").getPublicUrl(row!.storage_path_original).data.publicUrl);
    evidence("photo control", { objects, publicFull: pub.status, publicOriginal: orig.status });
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-type")).toBe("image/webp");
    expect(orig.ok, "the EXIF-bearing original is publicly fetchable").toBe(false);
  });

  it("9b. a floor plan: private renditions, no JPEG, not publicly fetchable", async () => {
    const P6 = await newProperty(null);
    const out = await act(manager, P6, { kind: "floor_plan" });
    expect(out.result?.error).toBeNull();
    const [row] = await rowsOf(P6);
    const objects = await objectsOf(P6);
    expect(row!.path_jpeg).toBeNull();
    expect(row!.is_cover).toBe(false);
    expect(objects.every((k) => k.startsWith("documents/"))).toBe(true);
    expect(objects).toHaveLength(4);
    const pub = await fetch(svc.storage.from("media").getPublicUrl(row!.path_full).data.publicUrl);
    evidence("floor plan control", { objects, publicFull: pub.status });
    expect(pub.ok).toBe(false);
  });

  it("9c. scope: every committed row on P1 still has every object it names", async () => {
    const objects = await objectsOf(P1);
    const rows = await rowsOf(P1);
    const missing = rows.flatMap((r) =>
      [
        `documents/${r.storage_path_original}`,
        ...[r.path_thumb, r.path_card, r.path_full, r.path_jpeg].filter(Boolean).map((p) => `media/${p}`),
      ].filter((k) => !objects.includes(k)),
    );
    const orphans = objects.filter((k) => !rows.some((r) => k.includes(r.id)));
    evidence("scope on P1", { rows: rows.length, objects: objects.length, missing, orphans });
    expect(missing).toEqual([]);
    expect(orphans, "an object with no row survived a failed attempt").toEqual([]);
  });
});

// keep the imported constant referenced (the admin mock builds its own client)
void SERVICE_ROLE_KEY;
