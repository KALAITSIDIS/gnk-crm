import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
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
 * A deal's health shows its activity AS OF NOW — through the REAL pipeline
 * and deal page server components, against a REAL PostgREST, with the
 * session's RLS and aal2 token (A09).
 *
 * At 66a4f09 both pages rendered `deals.health_score` and the stored
 * `health.factors` as the last recompute left them. Every deal-side recompute
 * runs straight after a write that stamps `last_activity_at = now()` and
 * nothing recomputes as time passes, so the stored activity factor was
 * nearly always 30/30 "0d since last activity": a deal idle for three weeks
 * showed 100 and a green dot. Now each reader re-scores the activity factor
 * against its own clock (liveHealth) and says when the rest was assessed.
 *
 * WHAT IT PINS
 *   1. the board: an open deal stored at 100 and idle 20 days shows 70 with
 *      "Recent activity 0/30 · 20d since last activity" and the line
 *      "Checklist assessed <time> · activity as of now"; idle 10 days, 85;
 *      active yesterday, 100;
 *   2. a won deal on the board keeps its stored 100 however long ago its last
 *      activity, and says it is not re-scored; an open deal with no snapshot
 *      keeps its stored score with no breakdown and no line;
 *   3. the deal page: the header dot and the Health panel show the same live
 *      score, breakdown and line; the deal's own agent sees what the admin
 *      sees;
 *   4. NO WRITE ON GET: after every render the deals' `health`,
 *      `health_score` and `updated_at` are byte-identical, the organisation
 *      has no new event, and neither the session nor the system client sent
 *      anything but reads to deals or events;
 *   5. F01's handoff: the deal page's Costs link carries `&property=<id>`
 *      when the deal names a property — the price stays the deal's — and
 *      not otherwise.
 *
 * Nothing below the page is stubbed but the Next.js request plumbing
 * (`createClient` hands the page a real session client; `createAdminClient` a
 * real service client), each logging its requests.
 *
 * A THROWAWAY ORGANISATION, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const DAY = 86_400_000;

type Logged = { method: string; url: string };
const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>(), system: [] as { method: string; url: string }[] };
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
// the system client the deal page's timeline reads with: real, and logged
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => systemClient() }));

import PipelinePage from "@/app/(app)/pipeline/page";
import DealDetailPage from "@/app/(app)/deals/[id]/page";
import { KanbanBoard, type KanbanDeal } from "@/components/features/pipeline/kanban";
import { HealthPanel } from "@/components/features/deals/detail-forms";
import { HealthDot } from "@/components/features/shared/health-dot";
import { computeHealth, type HealthFactor } from "@/lib/services/health-score";
import { formatDateTime } from "@/lib/utils/format";

function loggingFetch(log: Logged[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    log.push({ method: (init?.method ?? "GET").toUpperCase(), url });
    return fetch(input, init);
  };
}

function systemClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: loggingFetch(ctx.system) },
  });
}

// ---------------------------------------------------------------------------
// A real session per user, every request logged
// ---------------------------------------------------------------------------
type Session = { client: SupabaseClient; log: Logged[] };
const sessions = new Map<TestUser, Session>();

async function session(user: TestUser): Promise<Session> {
  const known = sessions.get(user);
  if (known) return known;
  const s = (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const log: Logged[] = [];
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: loggingFetch(log) },
  });
  const { error } = await client.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  const made = { client, log };
  sessions.set(user, made);
  return made;
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

async function board(user: TestUser): Promise<Map<string, KanbanDeal>> {
  const { client } = await session(user);
  const root = (await ctx.als.run(client, () =>
    PipelinePage({ searchParams: Promise.resolve({ type: "sale" }) }),
  )) as ReactNode;
  const el = [...walk(root)].find((e) => e.type === KanbanBoard);
  if (!el) throw new Error("the pipeline page rendered no board");
  return new Map((el.props.deals as KanbanDeal[]).map((d) => [d.id, d]));
}

type DealScreen = {
  panel: { score: number; factors: HealthFactor[] | null; note: string | null };
  headerDot: { score: number; factors: HealthFactor[] | null; note: string | null };
  costsHref: string | null;
};

async function dealPage(user: TestUser, id: string): Promise<DealScreen> {
  const { client } = await session(user);
  const root = (await ctx.als.run(client, () => DealDetailPage({ params: Promise.resolve({ id }) }))) as ReactNode;
  const els = [...walk(root)];
  const panel = els.find((e) => e.type === HealthPanel);
  const dots = els.filter((e) => e.type === HealthDot);
  if (!panel) throw new Error("the deal page rendered no Health panel");
  if (dots.length !== 1) throw new Error(`the deal page rendered ${dots.length} header health dots`);
  const costs = els.find((e) => e.type === Link && String(e.props.href).startsWith("/calculators"));
  const pick = (e: Element) => ({
    score: e.props.score as number,
    factors: (e.props.factors ?? null) as HealthFactor[] | null,
    note: (e.props.note ?? null) as string | null,
  });
  return { panel: pick(panel), headerDot: pick(dots[0]!), costsHref: costs ? String(costs.props.href) : null };
}

const activityOf = (factors: HealthFactor[] | null) => factors?.find((f) => f.key === "activity");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let agent: TestUser;
const userIds: string[] = [];
/** the test's clock: every fixture time is taken from it, as the page takes its own */
const T0 = Date.now();
const ago = (days: number) => new Date(T0 - days * DAY);

const deal: Record<"idle20" | "idle10" | "fresh" | "won" | "nosnap", string> = {
  idle20: "",
  idle10: "",
  fresh: "",
  won: "",
  nosnap: "",
};
let propertyId = "";

/** A snapshot as a recompute stores it right after the deal's last activity: every factor met, 100. */
function snapshotAt(at: Date) {
  const result = computeHealth(
    { budgetConfirmed: true, buyerKycPct: 100, titleDeedKnown: true, mandateActive: true, lastActivityAt: at },
    at,
  );
  return {
    score: result.score,
    health: { budget_confirmed: true, factors: result.factors, computed_at: at.toISOString() },
  };
}

async function plant(row: {
  title: string;
  status?: "open" | "won";
  lastActivity: Date;
  health: unknown;
  healthScore: number;
  expectedValue: number | null;
  property?: string | null;
}): Promise<string> {
  const won = row.status === "won";
  const { rows } = await pg.query<{ id: string }>(
    `insert into deals (org_id, deal_type, stage_id, title, agent_id, created_by, status, won_at,
                        last_activity_at, health, health_score, expected_value, property_id)
     values ($1, 'sale',
             (select id from deal_stages where org_id = $1 and deal_type = 'sale' and is_won = $2 and not is_lost
               order by sort_order limit 1),
             $3, $4, $4, $5::deal_status, case when $2 then $6::timestamptz end,
             $6::timestamptz, $7::jsonb, $8, $9, $10)
     returning id`,
    [
      ORG,
      won,
      `ZZTEST live health ${TAG} ${row.title}`,
      agent.id,
      won ? "won" : "open",
      row.lastActivity.toISOString(),
      JSON.stringify(row.health),
      row.healthScore,
      row.expectedValue,
      row.property ?? null,
    ],
  );
  return rows[0]!.id;
}

type Stored = { id: string; health: unknown; health_score: number; updated_at: string; last_activity_at: string };

/** What the database holds for the planted deals, as postgres; timestamps as text keep their microseconds. */
async function stored(): Promise<Stored[]> {
  const { rows } = await pg.query<Stored>(
    `select id::text, health, health_score, updated_at::text as updated_at, last_activity_at::text as last_activity_at
       from deals where org_id = $1 order by id`,
    [ORG],
  );
  return rows;
}

async function eventCount(): Promise<number> {
  const { rows } = await pg.query<{ n: string }>("select count(*)::text as n from events where org_id = $1", [ORG]);
  return Number(rows[0]!.n);
}

/** Every request the sessions and the system sent that is not a read, to deals or events. */
function writesToDealsOrEvents(): Logged[] {
  const all = [...[...sessions.values()].flatMap((s) => s.log), ...ctx.system];
  return all.filter(
    (r) => !["GET", "HEAD"].includes(r.method) && /\/rest\/v1\/(deals|events)(\?|$)/.test(r.url),
  );
}

let before: Stored[];
let eventsBefore: number;

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();

  await ensureTestOrg(svc, ORG, `Live health ${RUN}`, `live-health-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `lh-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agent = await createTestUser(svc, `lh-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);

  const { rows: prop } = await pg.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id",
    [ORG, `LH${TAG}`],
  );
  propertyId = prop[0]!.id;

  const s20 = snapshotAt(ago(20));
  deal.idle20 = await plant({
    title: "idle 20",
    lastActivity: ago(20),
    health: s20.health,
    healthScore: s20.score,
    expectedValue: 180000,
  });
  const s10 = snapshotAt(ago(10));
  deal.idle10 = await plant({
    title: "idle 10",
    lastActivity: ago(10),
    health: s10.health,
    healthScore: s10.score,
    expectedValue: 250000,
    property: propertyId,
  });
  const s1 = snapshotAt(ago(1));
  deal.fresh = await plant({ title: "fresh", lastActivity: ago(1), health: s1.health, healthScore: s1.score, expectedValue: null });
  // won 20 days ago (inside the board's 30-day closed window), its snapshot from the close
  deal.won = await plant({
    title: "won",
    status: "won",
    lastActivity: ago(20),
    health: s20.health,
    healthScore: s20.score,
    expectedValue: 300000,
  });
  // a row written before snapshots existed: a score, no breakdown
  deal.nosnap = await plant({ title: "no snapshot", lastActivity: ago(20), health: {}, healthScore: 55, expectedValue: null });

  before = await stored();
  eventsBefore = await eventCount();
  expect(before).toHaveLength(5);
  for (const r of before) expect(r.health_score, r.id).toBe(r.id === deal.nosnap ? 55 : 100);
}, 300_000);

afterAll(async () => {
  await pg.query("delete from deals where org_id = $1", [ORG]);
  await pg.query("delete from properties where org_id = $1", [ORG]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = $1`, [ORG]);
  }
  await pg.query("delete from organizations where id = $1", [ORG]);
  await pg.end();
}, 300_000);

describe("A09: health shows activity as of now — and the page writes nothing", () => {
  it("the board re-scores an open deal's activity: 20 days idle 70, 10 days 85, yesterday 100", async () => {
    const cards = await board(admin);

    const idle20 = cards.get(deal.idle20)!;
    expect(idle20.health_score).toBe(70);
    expect(activityOf(idle20.healthFactors)).toEqual({
      key: "activity",
      label: "Recent activity",
      points: 0,
      max: 30,
      detail: "20d since last activity",
    });
    expect(idle20.healthNote).toBe(
      `Checklist assessed ${formatDateTime(ago(20).toISOString())} · activity as of now`,
    );
    // every other factor is the stored one, unchanged
    const storedFactors = (before.find((r) => r.id === deal.idle20)!.health as { factors: HealthFactor[] }).factors;
    expect(idle20.healthFactors!.filter((f) => f.key !== "activity")).toEqual(
      storedFactors.filter((f) => f.key !== "activity"),
    );

    const idle10 = cards.get(deal.idle10)!;
    expect(idle10.health_score).toBe(85);
    expect(activityOf(idle10.healthFactors)).toMatchObject({ points: 15, detail: "10d since last activity" });

    const fresh = cards.get(deal.fresh)!;
    expect(fresh.health_score).toBe(100);
    expect(activityOf(fresh.healthFactors)).toMatchObject({ points: 30, detail: "1d since last activity" });
    console.log(
      `[evidence] board: stored 100/100/100 → shown ${idle20.health_score}/${idle10.health_score}/${fresh.health_score} (20d/10d/1d idle)`,
    );
  });

  it("a won deal keeps its stored score; a deal with no snapshot keeps its score and shows no breakdown", async () => {
    const cards = await board(admin);
    const won = cards.get(deal.won)!;
    expect(won.status).toBe("won");
    expect(won.health_score).toBe(100);
    expect(activityOf(won.healthFactors)).toMatchObject({ points: 30, detail: "0d since last activity" });
    expect(won.healthNote).toBe(
      `Assessed ${formatDateTime(ago(20).toISOString())} · a closed deal is not re-scored over time`,
    );

    const nosnap = cards.get(deal.nosnap)!;
    expect(nosnap.health_score).toBe(55);
    expect(nosnap.healthFactors).toBeNull();
    expect(nosnap.healthNote).toBeNull();
  });

  it("the deal page's header dot and Health panel show the same live health; the deal's agent sees what the admin sees", async () => {
    for (const user of [admin, agent]) {
      const screen = await dealPage(user, deal.idle20);
      for (const shown of [screen.panel, screen.headerDot]) {
        expect(shown.score).toBe(70);
        expect(activityOf(shown.factors)).toMatchObject({ points: 0, max: 30, detail: "20d since last activity" });
        expect(shown.note).toBe(`Checklist assessed ${formatDateTime(ago(20).toISOString())} · activity as of now`);
      }
    }
    const nosnap = await dealPage(admin, deal.nosnap);
    expect(nosnap.panel).toEqual({ score: 55, factors: null, note: null });
  });

  it("F01: Costs opens the calculators at the deal's figure, with the property when the deal names one", async () => {
    expect((await dealPage(admin, deal.idle10)).costsHref).toBe(`/calculators?price=250000&property=${propertyId}`);
    expect((await dealPage(admin, deal.idle20)).costsHref).toBe("/calculators?price=180000");
    // no figure, no Costs
    expect((await dealPage(admin, deal.fresh)).costsHref).toBeNull();
  });

  it("no write on GET: every planted deal is byte-identical, no event was written, nothing but reads went to deals or events", async () => {
    // one more full round, as both users, before the comparison
    await board(admin);
    await board(agent);
    for (const id of Object.values(deal)) await dealPage(admin, id);

    expect(await stored()).toEqual(before);
    expect(await eventCount()).toBe(eventsBefore);
    expect(writesToDealsOrEvents()).toEqual([]);
    // the harness did see the pages' reads — a log that recorded nothing proves nothing
    const reads = [...sessions.values()].flatMap((s) => s.log).filter((r) => /\/rest\/v1\/deals\?/.test(r.url));
    expect(reads.length).toBeGreaterThan(0);
    expect(ctx.system.length).toBeGreaterThan(0);
    console.log(
      `[evidence] ${reads.length} deal reads, ${ctx.system.length} system requests, 0 writes; rows and event count unchanged`,
    );
  });
});
