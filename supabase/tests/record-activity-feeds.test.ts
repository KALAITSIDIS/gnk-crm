import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * A06 step 5 — the PROPERTY and DEAL pages' Activity is the combined feed
 * (`readEntityTimelines` → `ActivityFeed`), through the REAL pages against a
 * REAL PostgREST + Postgres, as aal2 sessions (an admin, an agent, a listing
 * manager):
 *
 *   1. a viewing's events show on its property's feed — with the "Viewing"
 *      chip — including a viewing that is in neither of the page's display
 *      lists (a completed one: the property's card lists upcoming ones); the
 *      property's own and its key's events are still there; another
 *      property's viewing and another organisation's event naming the same
 *      viewing id never are;
 *   2. a signed slip's names: an admin's feed keeps "Viewing slip signed by
 *      …"; an agent's and a listing manager's say "Viewing slip signed", and
 *      neither name is anywhere in what the page hands the feed or in what
 *      the feed renders;
 *   3. the deal page: the deal's, its offer's and its viewings' events in one
 *      feed — a viewing past the Viewings card's newest ten included — with
 *      the same redaction for the deal's own agent.
 *
 * The page, the ids it reads on the session and the reader are real; only
 * Next's request plumbing is stubbed (`createClient` is the acting user's
 * session, `createAdminClient` the real service client, next-intl's
 * getTranslations the English catalogue). Throwaway organisations, deleted at
 * the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const ORG_X = randomUUID();
const ORGS = [ORG, ORG_X];
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SIGNER = `Zenobia Signer${TAG}`;
const SECOND = `Philippos Attendee${TAG}`;

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
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/services/site-revalidate", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifySiteAfter: vi.fn(),
  notifySiteIfPublic: vi.fn(async () => {}),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("./helpers");
  return { createAdminClient: () => h.serviceClient() };
});
// the feed's words, from the English catalogue, through next-intl's own ICU
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const en = (await import("@/messages/en.json")).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: "en", messages: en as never, namespace: namespace as never }),
  };
});

import PropertyDetailPage from "@/app/(app)/properties/[id]/page";
import DealDetailPage from "@/app/(app)/deals/[id]/page";
import { ActivityFeed } from "@/components/features/shared/event-timeline";

// ---------------------------------------------------------------------------
let o: Client;
let svc: SupabaseClient;
let admin: TestUser;
let agent: TestUser;
let lm: TestUser;
const userIds: string[] = [];

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

/** A render's words: React's text-node separators dropped, tags read as spaces. */
const plain = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

type FeedRow = { id: string | number; entity_type: string; entity_id: string | null; event_type: string; payload: unknown };
type FeedProps = {
  timeline: { rows: FeedRow[]; incomplete: boolean; truncated: boolean };
  pageEntityType: string;
};

/** What the page hands its Activity feed, and what that feed renders, as `user`. */
async function feedOf(user: TestUser, page: "property" | "deal", id: string) {
  const root = (await ctx.als.run(user.client, () =>
    page === "property"
      ? PropertyDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })
      : DealDetailPage({ params: Promise.resolve({ id }) }),
  )) as ReactNode;
  const feeds = [...walk(root)].filter((e) => e.type === ActivityFeed);
  expect(feeds, `the ${page} page renders ONE Activity feed`).toHaveLength(1);
  const props = feeds[0]!.props as unknown as FeedProps;
  const html = renderToStaticMarkup((await ActivityFeed(props as never)) as ReactElement);
  return { props, ids: props.timeline.rows.map((r) => String(r.id)), text: plain(html), json: JSON.stringify(props) };
}

async function one<T = { id: string }>(sql: string, args: unknown[] = []): Promise<T> {
  return (await o.query(sql, args)).rows[0] as T;
}

/** an event as a definer or the app writes one — postgres, explicit actor; one per statement, so each has its own now() */
async function plant(org: string, actor: string | null, entityType: string, entityId: string, eventType: string, payload: object) {
  return (
    await one<{ id: string }>(
      "insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload) values ($1, $2, $3, $4, $5, $6) returning id::text as id",
      [org, actor, entityType, entityId, eventType, JSON.stringify(payload)],
    )
  ).id;
}

// fixtures
let property = "";
let elsewhere = "";
let deal = "";
let pastViewing = "";
let otherViewing = "";
const ev: Record<string, string> = {};

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `Record feeds ${RUN}`, `record-feeds-${RUN}`);
  await ensureTestOrg(svc, ORG_X, `Record feeds X ${RUN}`, `record-feeds-x-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `rf-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agent = await createTestUser(svc, `rf-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);
  lm = await createTestUser(svc, `rf-lm-${RUN}@test.local`, "listing_manager", ORG);
  userIds.push(lm.id);

  const buyer = (await one("insert into contacts (org_id, first_name) values ($1, $2) returning id", [ORG, `RFBuyer${TAG}`])).id;
  property = (
    await one(
      "insert into properties (org_id, reference, property_type, status) values ($1, $2, 'apartment', 'available') returning id",
      [ORG, `RF${TAG}1`],
    )
  ).id;
  elsewhere = (
    await one(
      "insert into properties (org_id, reference, property_type, status) values ($1, $2, 'apartment', 'available') returning id",
      [ORG, `RF${TAG}2`],
    )
  ).id;
  const stage = (
    await one(
      "select id from deal_stages where org_id = $1 and deal_type = 'sale' and not is_won and not is_lost order by sort_order limit 1",
      [ORG],
    )
  ).id;
  deal = (
    await one(
      `insert into deals (org_id, deal_type, stage_id, title, agent_id, created_by, buyer_contact_id, property_id)
       values ($1, 'sale', $2, $3, $4, $4, $5, $6) returning id`,
      [ORG, stage, `RF deal ${TAG}`, agent.id, buyer, property],
    )
  ).id;
  const offer = (
    await one("insert into offers (org_id, deal_id, contact_id, amount, created_by) values ($1, $2, $3, 250000, $4) returning id", [
      ORG,
      deal,
      buyer,
      agent.id,
    ])
  ).id;
  const key = (
    await one("insert into property_keys (org_id, property_id, key_code) values ($1, $2, $3) returning id", [ORG, property, `K${TAG}`])
  ).id;
  // completed ten days ago, linked to the deal: in neither display list —
  // the property's card is UPCOMING scheduled viewings, and the deal's card
  // is its newest ten, which the eleven below fill
  pastViewing = (
    await one(
      `insert into viewings (org_id, property_id, contact_id, agent_id, deal_id, scheduled_at, status)
       values ($1, $2, $3, $4, $5, now() - interval '10 days', 'completed') returning id`,
      [ORG, property, buyer, agent.id, deal],
    )
  ).id;
  await o.query(
    `insert into viewings (org_id, property_id, contact_id, agent_id, deal_id, scheduled_at)
     select $1, $2, $3, $4, $5, now() + make_interval(days => g) from generate_series(1, 11) g`,
    [ORG, property, buyer, agent.id, deal],
  );
  otherViewing = (
    await one(
      "insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at) values ($1, $2, $3, $4, now() + interval '3 days') returning id",
      [ORG, elsewhere, buyer, agent.id],
    )
  ).id;

  ev.property = await plant(ORG, admin.id, "property", property, "updated", { section: "details" });
  ev.key = await plant(ORG, agent.id, "key", key, "created", {});
  ev.deal = await plant(ORG, agent.id, "deal", deal, "updated", {});
  ev.offer = await plant(ORG, agent.id, "offer", offer, "created", { amount: 250000 });
  ev.viewingCreated = await plant(ORG, agent.id, "viewing", pastViewing, "created", {});
  // the shape signViewingSlip writes (viewing-slips.ts): the hash-chained names
  ev.slip = await plant(ORG, agent.id, "viewing", pastViewing, "viewing_slip_signed", {
    sha256: "a".repeat(64),
    pdf_sha256: "b".repeat(64),
    signer_name: SIGNER,
    second_attendee: SECOND,
    geotagged: false,
  });
  ev.otherViewing = await plant(ORG, agent.id, "viewing", otherViewing, "created", {});
  // another organisation's event naming THIS viewing's id: the reader's org filter is the boundary
  ev.foreign = await plant(ORG_X, null, "viewing", pastViewing, "viewing_slip_signed", { signer_name: `Foreign${TAG}` });
}, 300_000);

afterAll(async () => {
  if (!o) return;
  for (const t of ["offers", "tasks", "viewings", "property_keys", "deals", "properties", "contacts"]) {
    await o.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await o.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
  await o.query("delete from organizations where id = any($1::uuid[])", [ORGS]);
  await o.end();
}, 120_000);

// ---------------------------------------------------------------------------
describe("the property page's Activity: the property, its keys and its viewings", () => {
  it("an admin: the viewing's events with their chip, the slip's signer named; nothing of another property or organisation", async () => {
    const f = await feedOf(admin, "property", property);
    console.log(`[evidence] property feed (admin): ${JSON.stringify(f.props.timeline.rows.map((r) => [r.entity_type, r.event_type]))}`);
    expect(f.props.pageEntityType).toBe("property");
    expect(f.props.timeline.incomplete).toBe(false);
    expect(f.props.timeline.truncated).toBe(false);
    // newest first: the viewing's two, then the key's, then the property's own
    expect(f.ids).toEqual([ev.slip, ev.viewingCreated, ev.key, ev.property]);
    for (const absent of [ev.otherViewing, ev.foreign, ev.deal, ev.offer]) expect(f.ids).not.toContain(absent);
    const viewingRows = f.props.timeline.rows.filter((r) => r.entity_type === "viewing");
    expect(viewingRows.map((r) => r.entity_id)).toEqual([pastViewing, pastViewing]);
    // rendered: the viewing's lines under their "Viewing" chip, the signer named for an admin
    expect(f.text).toContain(`Viewing Viewing slip signed by ${SIGNER}`);
    expect(f.text).toContain("Viewing Viewing scheduled");
    expect(f.text).toContain("Key Created");
    expect(f.text).not.toContain(`Foreign${TAG}`);
  });

  for (const who of ["agent", "listing_manager"] as const) {
    it(`${who === "agent" ? "an agent" : "a listing manager"}: the viewing's events show, and neither slip name is anywhere`, async () => {
      const f = await feedOf(who === "agent" ? agent : lm, "property", property);
      expect(f.ids).toEqual([ev.slip, ev.viewingCreated, ev.key, ev.property]);
      for (const absent of [ev.otherViewing, ev.foreign]) expect(f.ids).not.toContain(absent);
      const slip = f.props.timeline.rows.find((r) => String(r.id) === ev.slip)!;
      expect(slip.payload).not.toHaveProperty("signer_name");
      expect(slip.payload).not.toHaveProperty("second_attendee");
      // the neutral line, still marked as the viewing's
      expect(f.text).toContain("Viewing Viewing slip signed");
      expect(f.text).not.toContain("slip signed by");
      for (const name of [SIGNER, SECOND, "Zenobia", "Philippos", `Foreign${TAG}`]) {
        expect(f.json, `${name} in what the page hands the feed`).not.toContain(name);
        expect(f.text, `${name} on the rendered feed`).not.toContain(name);
      }
    });
  }
});

describe("the deal page's Activity: the deal, its offers and its viewings", () => {
  it("the deal's own agent: a viewing past the card's newest ten is on the feed, its slip unnamed", async () => {
    // the fixture's premise: the past viewing is not among the Viewings card's ten
    const { rows: card } = await o.query<{ id: string }>(
      "select id from viewings where deal_id = $1 order by scheduled_at desc limit 10",
      [deal],
    );
    expect(card.map((r) => r.id)).not.toContain(pastViewing);

    const f = await feedOf(agent, "deal", deal);
    console.log(`[evidence] deal feed (agent): ${JSON.stringify(f.props.timeline.rows.map((r) => [r.entity_type, r.event_type]))}`);
    expect(f.props.pageEntityType).toBe("deal");
    expect(f.props.timeline.incomplete).toBe(false);
    expect(f.ids).toEqual([ev.slip, ev.viewingCreated, ev.offer, ev.deal]);
    for (const absent of [ev.otherViewing, ev.foreign, ev.property, ev.key]) expect(f.ids).not.toContain(absent);
    expect(f.text).toContain("Viewing Viewing slip signed");
    expect(f.text).toContain("Viewing Viewing scheduled");
    for (const name of [SIGNER, SECOND, `Foreign${TAG}`]) {
      expect(f.json).not.toContain(name);
      expect(f.text).not.toContain(name);
    }
  });

  it("an admin's deal feed keeps the signer's name", async () => {
    const f = await feedOf(admin, "deal", deal);
    expect(f.ids).toEqual([ev.slip, ev.viewingCreated, ev.offer, ev.deal]);
    expect(f.text).toContain(`Viewing slip signed by ${SIGNER}`);
  });
});
