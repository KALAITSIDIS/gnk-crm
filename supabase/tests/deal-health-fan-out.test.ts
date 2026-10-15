import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
 * The deal-health fan-out runs AS THE SYSTEM, inside the saved row's own
 * organisation (T-lm-health-recompute) — the REAL property legal save, the
 * REAL contact KYC save, the REAL mandate activation and the REAL
 * recomputeDealsFor, against the REAL local stack, with two throwaway
 * organisations.
 *
 * THE DEFECT (operator decision, BACKLOG "External audit — 2026-10-14"). A
 * property's title-deed status and a buyer's KYC are deal-health factors, so
 * `updatePropertySection` (legal) and `updateContactSection` (kyc_banking)
 * recompute every open deal on the property / of the buyer once their own
 * write is proven. They did it on the caller's SESSION client, so a stored
 * score depended on who saved:
 *   - a listing manager may update the property, but `deals_update` (0100)
 *     has no listing-manager arm: the recompute's PATCH matched 0 rows,
 *     silently, on every open deal of the property;
 *   - the property's (or the contact's) assigned agent never even SELECTED a
 *     deal another agent owns: `deals_select` filters it out;
 * so the deal kept its old title-deed / KYC factor and score until a
 * deal-side save by someone who may update the deal.
 *
 * THE FIX. The fan-out reads the saved row's `org_id` on the caller's own
 * session (RLS: the row it just wrote), then selects, reads and writes the
 * open deals with the service-role client, every query filtered to that
 * organisation explicitly — the admin client has no RLS to do it. The write
 * touches only `health` / `health_score`, keeps T-deal-health-race's
 * `updated_at` predicate and retry, and writes no event (derived state, T3.3).
 *
 * THE SECURITY CLAIM, pinned in scenario 5: the service role is not a
 * cross-organisation channel. Organisation A's rows are planted to link INTO
 * B — a deal of A on B's property (`deals.property_id` is a single-column key,
 * so a plain service-role insert stores it) and a deal of A whose buyer is
 * B's contact (`deals_buyer_contact_id_fkey` is (org_id, buyer_contact_id)
 * since 0139, so it is planted PAST the keys, in replica mode, as
 * contact-merge-org-isolation.test.ts does) — and B's deals are planted to
 * link OUT to A's property and contact. B's saves must recompute B's deals and
 * read nothing of A's, and must leave A's deals byte for byte — and no request
 * the system sends, nor any answer it gets, may name A's organisation, A's
 * deals or A's mandate (its traffic is logged, not inferred from the rows).
 *
 * Every scenario that could pass by doing NOTHING carries a positive control:
 * a deal of B owned by someone other than the saver, which must move. On
 * 115bedc (session client) none of them moves — that is the RED.
 *
 * Nothing below the actions is stubbed except the Next.js request plumbing:
 * `createClient` hands each action a signed-in aal2 client, and
 * `createAdminClient` is the real service client behind a probe that logs
 * (and, in scenario 6, holds) its requests on deals. Only `revalidatePath` is
 * a stub. Sentry's captureMessage is spied, not silenced, so a fan-out that
 * failed and only reported it cannot pass as one that worked.
 *
 * Both organisations are deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
/** the organisation whose rows the fan-out must never touch */
const ORG_A = randomUUID();
/** where the saves happen */
const ORG_B = randomUUID();
const RUN = Date.now().toString(36);

const state = vi.hoisted(() => ({
  queue: [] as unknown[],
  /** builds the "service-role client" createAdminClient hands out — a probe, see adminProbe */
  admin: null as null | (() => unknown),
  reports: [] as { message: string; tags?: Record<string, string> }[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = state.queue.shift();
    if (!c) throw new Error("test harness: no client queued for this action");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("./helpers");
  return { createAdminClient: () => (state.admin ? state.admin() : h.serviceClient()) };
});
vi.mock("@sentry/nextjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  captureMessage: (message: string, ctx?: { tags?: Record<string, string> }) => {
    state.reports.push({ message, tags: ctx?.tags });
  },
}));

import { updatePropertySection } from "@/lib/actions/properties";
import { updateContactSection } from "@/lib/actions/contacts";
import { setMandateStatus } from "@/lib/actions/mandates";
import { HEALTH_WEIGHTS, recomputeDealsFor, type HealthFactor } from "@/lib/services/health-score";
import { KYC_ITEMS } from "@/lib/constants/checklists";

// ---------------------------------------------------------------------------
// Probes: clients that log their requests on deals, and can hold PATCHes
// ---------------------------------------------------------------------------
type Gate = { arrived: Promise<void>; arrive: () => void; released: Promise<void>; release: () => void };

function gate(): Gate {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((r) => (arrive = r));
  const released = new Promise<void>((r) => (release = r));
  return { arrived, arrive, released, release };
}

/**
 * `deals`: the METHOD of every request on deals, in order. `seen`: every
 * PostgREST exchange, any table — the request line and the answer's body —
 * so a test can ask whether a client was ever asked for, or answered with,
 * a row it should never touch.
 */
type Log = { deals: string[]; gates: Gate[]; seen: string[] };

const emptyLog = (gates: Gate[] = []): Log => ({ deals: [], gates, seen: [] });

/** "GET deals", "PATCH deals", "GET mandates", … — the method and table of each exchange in `log` */
const exchanges = (log: Log) =>
  log.seen.map((s) => {
    const [method, url] = s.split(/[ \n]/, 2);
    return `${method} ${new URL(url!).pathname.replace("/rest/v1/", "")}`;
  });

/** A fetch that logs every PostgREST exchange, the METHOD of every request on /rest/v1/deals, and holds the first `gates.length` PATCHes on deals. */
function loggingFetch(log: Log): typeof fetch {
  let patches = 0;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (/\/rest\/v1\/deals(\?|$)/.test(url)) {
      log.deals.push(method);
      if (method === "PATCH") {
        const g = log.gates[patches];
        patches += 1;
        if (g) {
          g.arrive();
          await g.released;
        }
      }
    }
    const res = await fetch(input, init);
    if (url.includes("/rest/v1/")) log.seen.push(`${method} ${url}\n${await res.clone().text()}`);
    return res;
  };
}

/** What the "system" sent and got in this scenario — every client createAdminClient built shares it. */
let systemLog: Log = emptyLog();

function adminProbe(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: loggingFetch(systemLog) },
  });
}

/** A fresh session client for `user` (aal2: the fixture's session), logging its requests on deals. */
async function sessionProbe(user: TestUser): Promise<{ client: SupabaseClient; log: Log }> {
  const { data } = await user.client.auth.getSession();
  const s = data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const log = emptyLog();
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: loggingFetch(log) },
  });
  const { error } = await client.auth.setSession({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
  });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  return { client, log };
}

// ---------------------------------------------------------------------------
// The two saves, as their forms post them
// ---------------------------------------------------------------------------
async function saveLegal(user: TestUser, propertyId: string, titleDeed: string) {
  const s = await sessionProbe(user);
  state.queue.push(s.client);
  const fd = new FormData();
  fd.set("property_id", propertyId);
  fd.set("section", "legal");
  fd.set("title_deed_status", titleDeed);
  fd.set("permit_status", "unknown");
  return { session: s.log, running: updatePropertySection({ error: null, savedAt: null }, fd) };
}

async function saveKyc(user: TestUser, contactId: string, done: number) {
  const s = await sessionProbe(user);
  state.queue.push(s.client);
  const fd = new FormData();
  fd.set("contact_id", contactId);
  fd.set("section", "kyc_banking");
  for (const [key] of KYC_ITEMS.slice(0, done)) fd.set(`kyc_${key}_done`, "on");
  return { session: s.log, running: updateContactSection({ error: null, savedAt: null }, fd) };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
/** B's admin: mandates are admin-only (setMandateStatus) */
let adminB: TestUser;
/** B's listing manager */
let lmB: TestUser;
/** B's agent assigned to the saved properties and contacts — never the deals' owner */
let saverB: TestUser;
/** B's agent who owns the deals */
let ownerB: TestUser;
/** B's agent assigned to nothing */
let strangerB: TestUser;
/** A's agent who owns A's deals */
let ownerA: TestUser;
const userIds: string[] = [];
const stageOf: Record<string, string> = {};
let n = 0;

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await svc.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table} fixture: ${error.message}`);
  return (data as { id: string }).id;
}

async function property(org: string, opts: { assigned?: string; titleDeed?: string } = {}) {
  n += 1;
  return ins("properties", {
    org_id: org,
    reference: `ZZFO${RUN}${n}`.slice(0, 20),
    property_type: "apartment",
    status: "available",
    assigned_agent_id: opts.assigned ?? null,
    title_deed_status: opts.titleDeed ?? "unknown",
  });
}

const kycWith = (done: number) =>
  Object.fromEntries(KYC_ITEMS.slice(0, done).map(([key]) => [key, { done: true }]));

async function contact(org: string, opts: { assigned?: string; kycDone?: number } = {}) {
  n += 1;
  return ins("contacts", {
    org_id: org,
    first_name: `ZZTEST fan-out ${RUN} ${n}`,
    contact_types: ["buyer"],
    assigned_agent_id: opts.assigned ?? null,
    kyc: kycWith(opts.kycDone ?? 0),
  });
}

type DealOpts = { owner: string; propertyId?: string; buyerId?: string; status?: "open" | "lost" };

const dealRow = (org: string, o: DealOpts) => {
  n += 1;
  return {
    org_id: org,
    deal_type: "sale",
    stage_id: stageOf[org],
    title: `ZZTEST fan-out ${RUN} ${n}`,
    agent_id: o.owner,
    created_by: o.owner,
    property_id: o.propertyId ?? null,
    buyer_contact_id: o.buyerId ?? null,
    status: o.status ?? "open",
  };
};

/** A deal through the service role: the keys apply (a deal of A on B's property passes — property_id is single-column). */
async function deal(org: string, o: DealOpts): Promise<string> {
  return ins("deals", dealRow(org, o));
}

/**
 * A deal naming ANOTHER organisation's contact, written PAST the keys:
 * replica mode skips the foreign-key triggers (since 0139 nothing else can
 * store it). Committed — the fan-out reads through PostgREST, which cannot
 * see an open transaction — and removed by afterAll.
 */
async function dealPastKeys(org: string, o: DealOpts): Promise<string> {
  const row = dealRow(org, o);
  const cols = Object.keys(row);
  await pg.query("begin");
  try {
    await pg.query("set local session_replication_role = replica");
    const { rows } = await pg.query<{ id: string }>(
      `insert into public.deals (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(row),
    );
    await pg.query("commit");
    return rows[0]!.id;
  } catch (e) {
    await pg.query("rollback");
    throw e;
  }
}

type HealthRow = {
  org_id: string;
  health: Record<string, unknown>;
  health_score: number;
  updated_at: string;
};

/** What the database holds — read as postgres; updated_at as text keeps its microseconds. */
async function healthRow(id: string): Promise<HealthRow> {
  const { rows } = await pg.query<HealthRow>(
    "select org_id, health, health_score, updated_at::text as updated_at from deals where id = $1",
    [id],
  );
  return rows[0]!;
}

/** Several rows, one query at a time (one pg client). */
async function healthRows(ids: string[]): Promise<HealthRow[]> {
  const out: HealthRow[] = [];
  for (const id of ids) out.push(await healthRow(id));
  return out;
}

const factor = (row: HealthRow, key: HealthFactor["key"]) =>
  ((row.health.factors ?? []) as HealthFactor[]).find((f) => f.key === key);

/** Events naming the deal — a recompute writes none (T3.3). */
async function dealEvents(id: string): Promise<number> {
  const { rows } = await pg.query<{ n: string }>("select count(*) as n from events where entity_id = $1", [id]);
  return Number(rows[0]!.n);
}

const healthReports = () => state.reports.filter((r) => r.message.startsWith("[health]"));

function evidence(label: string, data: Record<string, unknown>) {
  console.log(
    `[evidence] ${label}\n${Object.entries(data)
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join("\n")}`,
  );
}

/** title deed known (15) + activity within seven days (30, the fixture's last_activity_at is now()) */
const TITLE_AND_ACTIVITY = HEALTH_WEIGHTS.title_deed + HEALTH_WEIGHTS.activity;
/** buyer KYC ≥ 50% (15) + activity (30) */
const KYC_AND_ACTIVITY = HEALTH_WEIGHTS.kyc + HEALTH_WEIGHTS.activity;
/** an active mandate on the deal's property (15) + activity (30) */
const MANDATE_AND_ACTIVITY = HEALTH_WEIGHTS.mandate + HEALTH_WEIGHTS.activity;

async function stage(org: string): Promise<string> {
  const { data, error } = await svc
    .from("deal_stages")
    .select("id")
    .eq("org_id", org)
    .eq("deal_type", "sale")
    .eq("sort_order", 1)
    .single();
  if (error || !data) throw new Error(`stage fixture: ${error?.message ?? "missing"}`);
  return (data as { id: string }).id;
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG_A, `Fan-out A ${RUN}`, `fan-out-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `Fan-out B ${RUN}`, `fan-out-b-${RUN}`);
  stageOf[ORG_A] = await stage(ORG_A);
  stageOf[ORG_B] = await stage(ORG_B);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  adminB = await createTestUser(svc, `fo-admin-b-${RUN}@test.local`, "admin", ORG_B);
  lmB = await createTestUser(svc, `fo-lm-b-${RUN}@test.local`, "listing_manager", ORG_B);
  saverB = await createTestUser(svc, `fo-saver-b-${RUN}@test.local`, "agent", ORG_B);
  ownerB = await createTestUser(svc, `fo-owner-b-${RUN}@test.local`, "agent", ORG_B);
  strangerB = await createTestUser(svc, `fo-stranger-b-${RUN}@test.local`, "agent", ORG_B);
  ownerA = await createTestUser(svc, `fo-owner-a-${RUN}@test.local`, "agent", ORG_A);
  userIds.push(adminB.id, lmB.id, saverB.id, ownerB.id, strangerB.id, ownerA.id);
});

afterEach(() => {
  // a failed scenario must not leave a write parked at the gate
  for (const g of systemLog.gates) g.release();
  systemLog = emptyLog();
  state.admin = null;
  state.queue.length = 0;
  state.reports.length = 0;
});

afterAll(async () => {
  const orgs = [ORG_A, ORG_B];
  await pg.query("delete from tasks where org_id = any($1::uuid[])", [orgs]);
  await pg.query("delete from deals where org_id = any($1::uuid[])", [orgs]);
  await pg.query("delete from mandates where org_id = any($1::uuid[])", [orgs]);
  await pg.query("delete from properties where org_id = any($1::uuid[])", [orgs]);
  await pg.query("delete from contacts where org_id = any($1::uuid[])", [orgs]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  await pg.query("delete from profiles where org_id = any($1::uuid[])", [orgs]);
  await pg.query("delete from events where org_id = any($1::uuid[])", [orgs]);
  await pg.query("delete from events_chain_checkpoint where org_id = any($1::uuid[])", [orgs]);
  await pg.query("delete from chain_checks where org_id = any($1::uuid[])", [orgs]);
  await pg.query("delete from deal_stages where org_id = any($1::uuid[])", [orgs]);
  await pg.query("delete from districts where org_id = any($1::uuid[])", [orgs]);
  await pg.query("delete from organizations where id = any($1::uuid[])", [orgs]);
  await pg.end();
});

// ---------------------------------------------------------------------------
describe("a save fans out its deal-health recompute as the system", () => {
  it("1. a listing manager's legal save moves the title-deed factor of an agent's open deal", async () => {
    state.admin = adminProbe;
    const propertyId = await property(ORG_B);
    const dealId = await deal(ORG_B, { owner: ownerB.id, propertyId });
    const before = await healthRow(dealId);

    const { session, running } = await saveLegal(lmB, propertyId, "separate");
    expect(await running, "the save itself").toMatchObject({ error: null });

    const after = await healthRow(dealId);
    evidence("1. listing manager, legal", {
      session: session.deals,
      system: systemLog.deals,
      before: before.health_score,
      after: { score: after.health_score, title_deed: factor(after, "title_deed") },
    });
    expect(factor(after, "title_deed"), "the title deed the listing manager just saved").toMatchObject({
      points: HEALTH_WEIGHTS.title_deed,
      detail: "known",
    });
    expect(after.health_score).toBe(TITLE_AND_ACTIVITY);
    expect(after.updated_at).not.toBe(before.updated_at);
    expect(session.deals, "the caller's session never touched deals").toEqual([]);
    expect(systemLog.deals, "the system: the selection, the read, the write").toEqual(["GET", "GET", "PATCH"]);
    expect(await dealEvents(dealId), "derived state: no event for the deal (T3.3)").toBe(0);
    expect(healthReports()).toEqual([]);
  });

  it("2. the property's assigned agent's legal save moves a deal ANOTHER agent owns", async () => {
    state.admin = adminProbe;
    const propertyId = await property(ORG_B, { assigned: saverB.id });
    const dealId = await deal(ORG_B, { owner: ownerB.id, propertyId });
    // a closed deal on the same property is left as it is (open deals only, as before)
    const lostId = await deal(ORG_B, { owner: ownerB.id, propertyId, status: "lost" });
    const lostBefore = await healthRow(lostId);

    const { session, running } = await saveLegal(saverB, propertyId, "pending");
    expect(await running).toMatchObject({ error: null });

    const after = await healthRow(dealId);
    evidence("2. assigned agent, someone else's deal", {
      session: session.deals,
      system: systemLog.deals,
      after: { score: after.health_score, title_deed: factor(after, "title_deed") },
    });
    expect(factor(after, "title_deed")).toMatchObject({ points: HEALTH_WEIGHTS.title_deed, detail: "known" });
    expect(after.health_score).toBe(TITLE_AND_ACTIVITY);
    expect(await healthRow(lostId), "the lost deal is not recomputed").toEqual(lostBefore);
    expect(session.deals).toEqual([]);
    expect(healthReports()).toEqual([]);
  });

  it("3. a KYC save by the contact's assigned agent moves the KYC factor of a deal another agent owns", async () => {
    state.admin = adminProbe;
    const buyerId = await contact(ORG_B, { assigned: saverB.id });
    const dealId = await deal(ORG_B, { owner: ownerB.id, buyerId });

    const { session, running } = await saveKyc(saverB, buyerId, 3);
    expect(await running).toMatchObject({ error: null });

    const after = await healthRow(dealId);
    evidence("3. KYC", {
      session: session.deals,
      system: systemLog.deals,
      after: { score: after.health_score, kyc: factor(after, "kyc") },
    });
    expect(factor(after, "kyc"), "3 of 6 ticked: the 50% bar").toMatchObject({
      points: HEALTH_WEIGHTS.kyc,
      detail: "50% complete",
    });
    expect(after.health_score).toBe(KYC_AND_ACTIVITY);
    expect(session.deals).toEqual([]);
    expect(systemLog.deals).toEqual(["GET", "GET", "PATCH"]);
    expect(await dealEvents(dealId)).toBe(0);
    expect(healthReports()).toEqual([]);
  });

  it("3b. an admin's mandate activation (setMandateStatus → recomputeScores) moves the mandate factor of an agent's open deal", async () => {
    // mandates.ts' way into the fan-out, and the factor it is there to
    // refresh. mandates.ts is not changed by T-lm-health-recompute: its
    // recomputeScores hands the helper the admin's session, and the helper
    // reads the property's org on it and recomputes as the system. Until this
    // scenario no test, unit or DB, showed the system path FINDING an active
    // mandate (review, 2026-10-15).
    state.admin = adminProbe;
    const propertyId = await property(ORG_B);
    const owner = await contact(ORG_B);
    const mandateId = await ins("mandates", {
      org_id: ORG_B,
      property_id: propertyId,
      owner_contact_id: owner,
      type: "exclusive",
      status: "draft",
    });
    const dealId = await deal(ORG_B, { owner: ownerB.id, propertyId });
    const before = await healthRow(dealId);

    const s = await sessionProbe(adminB);
    state.queue.push(s.client);
    expect(await setMandateStatus(mandateId, "active"), "the activation itself").toEqual({ error: null });

    const after = await healthRow(dealId);
    evidence("3b. admin, mandate activation", {
      session: s.log.deals,
      system: systemLog.deals,
      before: before.health_score,
      after: { score: after.health_score, mandate: factor(after, "mandate") },
    });
    expect(factor(after, "mandate"), "the mandate the admin just activated").toMatchObject({
      points: HEALTH_WEIGHTS.mandate,
      detail: "active",
    });
    expect(after.health_score).toBe(MANDATE_AND_ACTIVITY);
    expect(after.updated_at).not.toBe(before.updated_at);
    expect(s.log.deals, "the admin's session never touched deals").toEqual([]);
    expect(systemLog.deals, "the system: the selection, the read, the write").toEqual(["GET", "GET", "PATCH"]);
    expect(await dealEvents(dealId), "derived state: no event for the deal (T3.3)").toBe(0);
    expect(healthReports()).toEqual([]);
  });

  it("4. a REFUSED save fans out nothing: the deal stays byte for byte, stale score and all", async () => {
    state.admin = adminProbe;
    // stale on purpose: a recompute now WOULD change these rows (title deed
    // known, KYC 100%), so a fan-out that ran despite the refusal would show
    const propertyId = await property(ORG_B, { assigned: saverB.id, titleDeed: "separate" });
    const buyerId = await contact(ORG_B, { assigned: saverB.id, kycDone: 6 });
    const onProperty = await deal(ORG_B, { owner: ownerB.id, propertyId });
    const ofBuyer = await deal(ORG_B, { owner: ownerB.id, buyerId });
    const propertyBefore = await healthRow(onProperty);
    const buyerBefore = await healthRow(ofBuyer);

    // an agent assigned to nothing: properties_update refuses
    const legal = await saveLegal(strangerB, propertyId, "pending");
    expect((await legal.running).error, "refused, and said so").toMatch(/Nothing was saved/);
    // a listing manager: contacts_update has no listing-manager arm
    const kyc = await saveKyc(lmB, buyerId, 1);
    expect((await kyc.running).error).toMatch(/permission/);

    evidence("4. refused saves", { system: systemLog.deals });
    expect(await healthRow(onProperty)).toEqual(propertyBefore);
    expect(await healthRow(ofBuyer)).toEqual(buyerBefore);
    expect(systemLog.deals, "the system was never asked").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("the system recomputes inside the saved row's organisation, and nowhere else", () => {
  it("5. B's saves move B's deals, read nothing of A's, and leave A's deals byte for byte — hand-planted cross-organisation links included", async () => {
    state.admin = adminProbe;
    // ---- A: a known title deed with an active mandate, a fully-KYC'd buyer
    const propertyA = await property(ORG_A, { titleDeed: "separate" });
    const mandateA = await ins("mandates", { org_id: ORG_A, property_id: propertyA, type: "exclusive", status: "active" });
    const buyerA = await contact(ORG_A, { kycDone: 6 });
    // ---- B: what B's saver works on — B's property mandated too, the
    // positive control for the mandate factor: without it, "none active" on
    // A's property below could only say that no mandate is ever read
    const propertyB = await property(ORG_B, { assigned: saverB.id });
    await ins("mandates", { org_id: ORG_B, property_id: propertyB, type: "exclusive", status: "active" });
    const buyerB = await contact(ORG_B, { assigned: saverB.id });

    // B's deals: the positive controls, two of them linking OUT to A
    const bOnProperty = await deal(ORG_B, { owner: ownerB.id, propertyId: propertyB });
    const bOnPropertyBuyerA = await dealPastKeys(ORG_B, { owner: ownerB.id, propertyId: propertyB, buyerId: buyerA });
    const bOfBuyerPropertyA = await deal(ORG_B, { owner: ownerB.id, buyerId: buyerB, propertyId: propertyA });
    // A's deals: two linking IN to B's rows, two plain ones on A's own rows
    const aOnPropertyB = await deal(ORG_A, { owner: ownerA.id, propertyId: propertyB });
    const aOfBuyerB = await dealPastKeys(ORG_A, { owner: ownerA.id, buyerId: buyerB });
    const aOnPropertyA = await deal(ORG_A, { owner: ownerA.id, propertyId: propertyA });
    const aOfBuyerA = await deal(ORG_A, { owner: ownerA.id, buyerId: buyerA });
    const aDeals = [aOnPropertyB, aOfBuyerB, aOnPropertyA, aOfBuyerA];

    // the plants are what this scenario says they are
    for (const [id, org] of [
      [bOnPropertyBuyerA, ORG_B],
      [aOnPropertyB, ORG_A],
      [aOfBuyerB, ORG_A],
    ] as const) {
      expect((await healthRow(id)).org_id).toBe(org);
    }
    const aBefore = await healthRows(aDeals);

    // ---- B's saver saves the title deed on B's property
    const legal = await saveLegal(saverB, propertyB, "separate");
    expect(await legal.running).toMatchObject({ error: null });
    const afterLegal = { bOnProperty: await healthRow(bOnProperty), bOnPropertyBuyerA: await healthRow(bOnPropertyBuyerA) };

    // ---- and the KYC on B's contact
    const kyc = await saveKyc(saverB, buyerB, 3);
    expect(await kyc.running).toMatchObject({ error: null });
    const afterKyc = await healthRow(bOfBuyerPropertyA);

    // ---- B's session handing the fan-out A's rows directly: the anchor is read under B's RLS
    const bSession = await sessionProbe(saverB);
    const bOfBuyerPropertyABefore = await healthRow(bOfBuyerPropertyA);
    await expect(recomputeDealsFor(bSession.client as never, { propertyId: propertyA })).resolves.toBeUndefined();
    await expect(recomputeDealsFor(bSession.client as never, { buyerContactId: buyerA })).resolves.toBeUndefined();

    const aAfter = await healthRows(aDeals);
    evidence("5. two organisations", {
      bOnProperty: {
        score: afterLegal.bOnProperty.health_score,
        title: factor(afterLegal.bOnProperty, "title_deed")?.detail,
        mandate: factor(afterLegal.bOnProperty, "mandate")?.detail,
      },
      bOnPropertyBuyerA: {
        score: afterLegal.bOnPropertyBuyerA.health_score,
        title: factor(afterLegal.bOnPropertyBuyerA, "title_deed")?.detail,
        kyc: factor(afterLegal.bOnPropertyBuyerA, "kyc")?.detail,
      },
      bOfBuyerPropertyA: {
        score: afterKyc.health_score,
        kyc: factor(afterKyc, "kyc")?.detail,
        title: factor(afterKyc, "title_deed")?.detail,
        mandate: factor(afterKyc, "mandate")?.detail,
      },
      aScores: aAfter.map((r) => r.health_score),
      reports: healthReports(),
      systemExchanges: exchanges(systemLog),
    });

    // B's deals moved (the positive controls — none moves on a session-client fan-out)
    expect(factor(afterLegal.bOnProperty, "title_deed")).toMatchObject({ points: HEALTH_WEIGHTS.title_deed, detail: "known" });
    expect(
      factor(afterLegal.bOnProperty, "mandate"),
      "B's own active mandate IS read, as the system: the control for 'none active' below",
    ).toMatchObject({ points: HEALTH_WEIGHTS.mandate, detail: "active" });
    expect(afterLegal.bOnProperty.health_score).toBe(TITLE_AND_ACTIVITY + HEALTH_WEIGHTS.mandate);
    expect(factor(afterLegal.bOnPropertyBuyerA, "title_deed")).toMatchObject({ detail: "known" });
    // …and read nothing of A's: A's contact is 100% KYC'd, its property's title deed is known and mandated
    expect(
      factor(afterLegal.bOnPropertyBuyerA, "kyc"),
      "A's buyer, planted on B's deal, is not read: no KYC points from another organisation",
    ).toMatchObject({ points: 0, detail: "no buyer linked" });
    expect(afterLegal.bOnPropertyBuyerA.health_score, "title deed + B's mandate + activity, no KYC").toBe(
      TITLE_AND_ACTIVITY + HEALTH_WEIGHTS.mandate,
    );
    expect(factor(afterKyc, "kyc"), "B's own buyer was read").toMatchObject({ points: HEALTH_WEIGHTS.kyc, detail: "50% complete" });
    expect(
      factor(afterKyc, "title_deed"),
      "A's property, planted on B's deal, is not read: its known title deed scores nothing here",
    ).toMatchObject({ points: 0, detail: "no property linked" });
    expect(
      factor(afterKyc, "mandate"),
      "nor A's active mandate — while B's own, above, is found by the same read",
    ).toMatchObject({ points: 0, detail: "none active" });
    expect(afterKyc.health_score).toBe(KYC_AND_ACTIVITY);

    // The system's own traffic never touched A: no request it sent and no
    // answer it got carries A's organisation id, one of A's deals or A's
    // mandate. A's deals staying byte for byte (below) cannot say this alone:
    // a selection and a deal read without their org filters SELECT and READ
    // A's deal on B's property and A's deal of B's buyer, and the write's own
    // filter then matches 0 rows — nothing written, so only the report list
    // used to fail (review, 2026-10-15). The URLs DO name A's property and
    // contact — B's planted deals point at them — and the answers about them
    // are empty: the factors above say so.
    const aIds = [ORG_A, ...aDeals, mandateA];
    expect(
      systemLog.seen.filter((s) => s.includes(bOnProperty)).length,
      "the log saw the fan-out (it is not empty by accident)",
    ).toBeGreaterThan(0);
    expect(
      systemLog.seen.filter((s) => aIds.some((id) => s.includes(id))),
      "nothing the system asked for or was answered with names A's organisation, deals or mandate",
    ).toEqual([]);

    // A's deals: byte for byte — the two planted INTO B's rows, and the two
    // that B's session named directly
    expect(aAfter, "not one of A's deals was written").toEqual(aBefore);
    expect(
      healthReports().map((r) => `${r.tags?.step}:${r.tags?.code}`),
      "B's saves reported nothing; each direct call stopped at the anchor, which B's session cannot see",
    ).toEqual(["anchor:not_visible", "anchor:not_visible"]);
    expect(await healthRow(bOfBuyerPropertyA), "the direct calls ran nothing").toEqual(bOfBuyerPropertyABefore);
    for (const id of aDeals) expect(await dealEvents(id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("the system path keeps T-deal-health-race's guard", () => {
  it("6. hold the system's write, move the row, release: the retry computes from the moved row", async () => {
    systemLog = emptyLog([gate()]);
    state.admin = adminProbe;
    const propertyId = await property(ORG_B);
    const dealId = await deal(ORG_B, { owner: ownerB.id, propertyId });

    const { running } = await saveLegal(lmB, propertyId, "separate");
    const g = systemLog.gates[0]!;
    const reached = await Promise.race([
      g.arrived.then(() => "held" as const),
      running.then(
        () => "finished" as const,
        () => "finished" as const,
      ),
    ]);
    expect(reached, "the fan-out's write, as the system, is held at the gate").toBe("held");

    // the system has READ the deal; now its own agent ticks the budget flag
    // directly — no trailing recompute, so health_score stays as it was
    const { data: patched, error } = await ownerB.client
      .from("deals")
      .update({ health: { budget_confirmed: true } })
      .eq("id", dealId)
      .select("id");
    expect(error).toBeNull();
    expect(patched).toHaveLength(1);
    const moved = await healthRow(dealId);

    g.release();
    expect(await running, "the save is unaffected by the race").toMatchObject({ error: null });

    const after = await healthRow(dealId);
    evidence("6. race on the system path", {
      system: systemLog.deals,
      moved: { flag: moved.health.budget_confirmed, score: moved.health_score },
      after: { flag: after.health.budget_confirmed, score: after.health_score },
    });
    expect(after.health.budget_confirmed, "the flag set under the held write survives").toBe(true);
    expect(after.health_score, "budget + title deed + activity: the retry read both").toBe(
      HEALTH_WEIGHTS.budget + TITLE_AND_ACTIVITY,
    );
    expect(factor(after, "budget")).toMatchObject({ points: HEALTH_WEIGHTS.budget, detail: "confirmed" });
    expect(factor(after, "title_deed")).toMatchObject({ points: HEALTH_WEIGHTS.title_deed, detail: "known" });
    expect(after.updated_at, "the retry wrote the row").not.toBe(moved.updated_at);
    expect(systemLog.deals, "selection, read, the held write (matched nothing), re-read, write").toEqual([
      "GET",
      "GET",
      "PATCH",
      "GET",
      "PATCH",
    ]);
    expect(healthReports()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("the chains", () => {
  it("7. verify for both organisations after everything above", async () => {
    for (const org of [ORG_A, ORG_B]) {
      const { rows } = await pg.query("select ok, reason from verify_events_chain($1::uuid, null::bigint)", [org]);
      expect(rows[0], org).toMatchObject({ ok: true });
    }
  });
});
