import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isValidElement, type ReactElement } from "react";
import { zonedParts, zonedWallClockToUtc } from "@/lib/utils/tz";
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
 * The dashboard's My day and Team sections and its split activity feed (A01),
 * through the REAL server components against a REAL PostgREST, with each
 * session's RLS and aal2 token.
 *
 * WHAT IT PINS
 *   1. An admin's page renders, in this order: the alert banners, My day, Team,
 *      the admin KPIs — and an agent's page renders no Team section at all.
 *   2. My day (the admin's OWN day): a no-contact nudge due today opens its
 *      deal, a feedback nudge opens its viewing, both labelled by kind; the
 *      badge is the exact count; a colleague's task is not here.
 *   3. My open leads: 'qualified' counts as open (it was missing), unanswered
 *      first, an unanswered lead opens the inbox and an answered one its person;
 *      closed leads and other agents' leads are absent; exact badge.
 *   4. Team: unassigned open leads and everyone else's overdue tasks, NULL
 *      assignee included, each badge equal to `select count(*)` as postgres;
 *      the admin's own, done and not-yet-due tasks are not counted; nothing of
 *      another organisation's.
 *   5. The feed: a config change is absent from "Latest sales activity" and
 *      present under "Settings & admin changes", and the sales card still holds
 *      the 10 newest sales events.
 *   6. An agent's My day holds their own task, opening its record, and not the
 *      admin's.
 *   7. A count that comes back without a count is the page's failure — never a
 *      zero and never the length of the list.
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const RUN = Date.now().toString(36);
const ORG = randomUUID();
const OTHER = randomUUID();
const ORGS = [ORG, OTHER];
const DAY = 86_400_000;

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
// the page's words, from the English catalogue, through next-intl's own ICU
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const en = (await import("@/messages/en.json")).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: "en", messages: en as never, namespace: namespace as never }),
  };
});

import DashboardPage from "@/app/(app)/dashboard/page";
import { AdminDashboard } from "@/components/features/dashboard/admin-dashboard";
import { AgentDashboard } from "@/components/features/dashboard/agent-dashboard";
import { Card, CardEmpty } from "@/components/features/dashboard/card";
import { CronHealth } from "@/components/features/dashboard/cron-health";
import { HotIdleCard } from "@/components/features/dashboard/hot-idle-card";
import { LeadRowList } from "@/components/features/dashboard/lead-row-list";
import { ListingHealth } from "@/components/features/dashboard/listing-health";
import { MyDay } from "@/components/features/dashboard/my-day";
import { TaskRowList } from "@/components/features/dashboard/task-row-list";
import { TeamCards } from "@/components/features/dashboard/team-cards";
import { EventTimeline } from "@/components/features/shared/event-timeline";

// ---------------------------------------------------------------------------
// Sessions: a real client per user; one chosen request can be answered instead
// ---------------------------------------------------------------------------
interface Steer {
  match: (method: string, url: string) => boolean;
  respond: () => Response;
  hits: number;
}
type Session = { client: SupabaseClient; steer: Steer | null };
const sessions = new Map<string, Session>();

async function session(user: TestUser): Promise<Session> {
  const known = sessions.get(user.id);
  if (known) return known;
  const s = (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const state: Session = { client: undefined as unknown as SupabaseClient, steer: null };
  state.client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = decodeURIComponent(raw);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.includes("/rest/v1/") && state.steer?.match(method, url)) {
          state.steer.hits++;
          return state.steer.respond();
        }
        return fetch(input, init);
      },
    },
  });
  const { error } = await state.client.auth.setSession({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
  });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  sessions.set(user.id, state);
  return state;
}

async function as<T>(user: TestUser, fn: () => Promise<T> | T): Promise<T> {
  const { client } = await session(user);
  return ctx.als.run(client, fn);
}

// ---------------------------------------------------------------------------
// Reading what a component returned — its element tree, expanding only this
// file's own synchronous presentational components
// ---------------------------------------------------------------------------
type Element = ReactElement<Record<string, unknown>>;
const EXPAND = new Set<unknown>([Card, CardEmpty, TaskRowList, LeadRowList]);

function* walk(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!isValidElement(node)) return;
  const el = node as Element;
  yield el;
  if (EXPAND.has(el.type)) {
    yield* walk((el.type as (p: unknown) => unknown)(el.props));
    return;
  }
  yield* walk(el.props.children);
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    const el = node as Element;
    if (EXPAND.has(el.type)) return textOf((el.type as (p: unknown) => unknown)(el.props));
    return textOf(el.props.children);
  }
  return "";
}

interface CardView {
  title: string;
  count: number | undefined;
  level: number | undefined;
  /** every link inside the card: [href, text] */
  links: [string, string][];
  text: string;
}

function cardsOf(tree: unknown): CardView[] {
  return [...walk(tree)]
    .filter((e) => e.type === Card)
    .map((card) => ({
      title: String(card.props.title),
      count: card.props.count as number | undefined,
      level: card.props.level as number | undefined,
      links: [...walk(card.props.children)]
        .filter((e) => typeof e.props.href === "string")
        .map((e) => [String(e.props.href), textOf(e.props.children)] as [string, string]),
      text: textOf(card.props.children),
    }));
}

const card = (cards: CardView[], title: string): CardView => {
  const found = cards.find((c) => c.title === title);
  if (!found) throw new Error(`no card "${title}" among: ${cards.map((c) => c.title).join(" | ")}`);
  return found;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let agent: TestUser;
const userIds: string[] = [];

const id: Record<string, string> = {};
const TITLE = {
  dealNudge: `MD ${RUN} no contact nudge`,
  feedback: `MD ${RUN} log feedback`,
  adminOverdue: `MD ${RUN} admin own overdue`,
  agentOverdue: `MD ${RUN} agent overdue`,
  unassignedOverdue: `MD ${RUN} unassigned overdue`,
  agentFuture: `MD ${RUN} agent not yet due`,
  agentDone: `MD ${RUN} agent done overdue`,
  otherOrg: `MD ${RUN} other org overdue`,
};

/** The next Cyprus midnight, as My day computes it (via the next day KEY, not +24h). */
function nextCyprusMidnight(): Date {
  const todayKey = zonedParts(new Date()).dayKey;
  const nextKey = new Date(new Date(`${todayKey}T00:00:00Z`).getTime() + DAY).toISOString().slice(0, 10);
  return zonedWallClockToUtc(`${nextKey}T00:00`);
}

async function one(sql: string, params: unknown[]): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(sql, params);
  return rows[0]!.id;
}

const task = (
  org: string,
  title: string,
  dueAt: Date,
  assignee: string | null,
  cols: Record<string, string | boolean | null> = {},
) => {
  const names = ["org_id", "title", "due_at", "assignee_id", ...Object.keys(cols)];
  const values = [org, title, dueAt.toISOString(), assignee, ...Object.values(cols)];
  return one(
    `insert into tasks (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    values,
  );
};

const lead = (org: string, cols: Record<string, string | null>) => {
  const names = ["org_id", "source", ...Object.keys(cols)];
  const values = [org, "website", ...Object.values(cols)];
  return one(
    `insert into leads (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    values,
  );
};

/** One event per statement, so each has its own now() and the feed order is the insert order. */
const event = (org: string, entityType: string, eventType: string, actor: string | null, entityId: string | null) =>
  one(
    `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
     values ($1, $2, $3, $4, $5, '{}'::jsonb) returning id::text`,
    [org, actor, entityType, entityId, eventType],
  );

beforeAll(async () => {
  // the hot-buyers card's last-touched read runs on the service-role client
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= SERVICE_ROLE_KEY;

  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `My day ${RUN}`, `my-day-${RUN}`);
  await ensureTestOrg(svc, OTHER, `My day other ${RUN}`, `my-day-other-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `mday-a-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agent = await createTestUser(svc, `mday-g-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);

  const now = Date.now();
  const todayKey = zonedParts(new Date()).dayKey;
  const tonight = zonedWallClockToUtc(`${todayKey}T23:59`); // a nudge's Cyprus EOD stamp

  id.property = await one(
    "insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id",
    [ORG, `MD${RUN}`.slice(0, 20)],
  );
  id.contact = await one("insert into contacts (org_id, first_name) values ($1, $2) returning id", [
    ORG,
    `MDBuyer${RUN}`,
  ]);
  const { rows: stage } = await pg.query<{ id: string }>(
    "select id from deal_stages where org_id = $1 and deal_type = 'sale' and not is_won and not is_lost order by sort_order limit 1",
    [ORG],
  );
  id.deal = await one(
    "insert into deals (org_id, deal_type, stage_id, title, agent_id) values ($1, 'sale', $2, $3, $4) returning id",
    [ORG, stage[0]!.id, `MD ${RUN} deal`, admin.id],
  );
  id.viewing = await one(
    `insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at, status)
     values ($1, $2, $3, $4, now(), 'completed') returning id`,
    [ORG, id.property, id.contact, admin.id],
  );

  // the admin's own day
  id.dealNudge = await task(ORG, TITLE.dealNudge, tonight, admin.id, { kind: "deal_no_contact", deal_id: id.deal });
  id.feedback = await task(ORG, TITLE.feedback, new Date(now - DAY), admin.id, {
    kind: "viewing_feedback",
    viewing_id: id.viewing,
    property_id: id.property,
  });
  id.adminOverdue = await task(ORG, TITLE.adminOverdue, new Date(now - 3 * DAY), admin.id);
  // the rest of the team
  id.agentOverdue = await task(ORG, TITLE.agentOverdue, new Date(now - 2 * DAY), agent.id, {
    property_id: id.property,
  });
  id.unassignedOverdue = await task(ORG, TITLE.unassignedOverdue, new Date(now - 4 * DAY), null, {
    contact_id: id.contact,
  });
  id.agentFuture = await task(ORG, TITLE.agentFuture, new Date(now + 5 * DAY), agent.id);
  id.agentDone = await task(ORG, TITLE.agentDone, new Date(now - 2 * DAY), agent.id, { is_done: true });
  // another organisation's overdue, unassigned task — RLS must keep it out
  await task(OTHER, TITLE.otherOrg, new Date(now - 2 * DAY), null);

  // leads
  const ago = (ms: number) => new Date(now - ms).toISOString();
  id.leadUnanswered = await lead(ORG, { assigned_agent_id: admin.id, status: "new", received_at: ago(3_600_000) });
  // 'qualified' is open, and this one was answered and has a person
  id.leadQualified = await lead(ORG, {
    assigned_agent_id: admin.id,
    status: "qualified",
    received_at: ago(600_000),
    first_response_at: ago(300_000),
    contact_id: id.contact,
  });
  id.leadLost = await lead(ORG, { assigned_agent_id: admin.id, status: "lost", received_at: ago(60_000) });
  id.leadAgents = await lead(ORG, { assigned_agent_id: agent.id, status: "new", received_at: ago(60_000) });
  id.leadUnassignedOld = await lead(ORG, { status: "contacted", received_at: ago(2 * DAY), first_response_at: ago(DAY) });
  id.leadUnassignedNew = await lead(ORG, { status: "new", received_at: ago(120_000) });
  id.leadUnassignedClosed = await lead(ORG, { status: "converted", received_at: ago(DAY) });
  await lead(OTHER, { status: "new", received_at: ago(60_000) });

  // the feed: twelve sales events, then the newest of all a config change
  for (let i = 0; i < 12; i++) {
    id[`sale${i}`] = await event(ORG, "property", "updated", admin.id, id.property);
  }
  id.configEvent = await event(ORG, "config", "locations_updated", admin.id, null);
  id.otherConfigEvent = await event(OTHER, "config", "locations_updated", null, null);
}, 300_000);

afterAll(async () => {
  if (pg) {
    for (const t of ["tasks", "viewings", "leads", "deals", "contacts", "properties"]) {
      await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
    }
    for (const u of userIds) await svc.auth.admin.deleteUser(u);
    for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
      await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
    }
    await pg.query("delete from organizations where id = any($1::uuid[])", [ORGS]);
    await pg.end();
  }
}, 300_000);

// ---------------------------------------------------------------------------

describe("the dashboard page, by role", () => {
  it("an admin's page is banners → My day → Team → the admin KPIs, in that order", async () => {
    const tree = await as(admin, () => DashboardPage());
    const order = [...walk(tree)]
      .map((e) => e.type)
      .filter((t) => [CronHealth, ListingHealth, MyDay, TeamCards, AdminDashboard].includes(t as never));
    expect(order).toEqual([CronHealth, ListingHealth, MyDay, TeamCards, AdminDashboard]);
    const headings = [...walk(tree)].filter((e) => e.type === "h2").map((e) => textOf(e.props.children));
    expect(headings).toEqual(["My day", "Team"]);
    const myDay = [...walk(tree)].find((e) => e.type === MyDay)!;
    expect(myDay.props.profileId).toBe(admin.id);
    expect(myDay.props.level).toBe(3); // its cards sit under the "My day" h2
  });

  it("an agent's page has no Team section and no admin KPIs — only the agent dashboard", async () => {
    const tree = await as(agent, () => DashboardPage());
    const types = [...walk(tree)].map((e) => e.type);
    expect(types).toContain(AgentDashboard);
    for (const t of [TeamCards, AdminDashboard, CronHealth, ListingHealth, MyDay]) expect(types).not.toContain(t);
    const inner = await as(agent, () => AgentDashboard({ profileId: agent.id }));
    const myDay = [...walk(inner)].find((e) => e.type === MyDay)!;
    expect(myDay.props.profileId).toBe(agent.id);
    expect(myDay.props.level).toBeUndefined();
  });
});

describe("My day — the admin's own", () => {
  it("lists today's and overdue tasks linked to their records, labelled by kind, with an exact badge", async () => {
    const cards = cardsOf(await as(admin, () => MyDay({ profileId: admin.id, level: 3 })));
    const tasks = card(cards, "Tasks due today & overdue");
    expect(tasks.level).toBe(3);
    // the admin's three open tasks due before Cyprus midnight — exact, as postgres counts them
    const { rows } = await pg.query<{ n: string }>(
      `select count(*)::text as n from tasks where org_id = $1 and assignee_id = $2 and not is_done
         and due_at < $3`,
      [ORG, admin.id, nextCyprusMidnight().toISOString()],
    );
    expect(tasks.count).toBe(3);
    expect(String(tasks.count)).toBe(rows[0]!.n);
    const href = (title: string) => tasks.links.find(([, text]) => text.includes(title))?.[0];
    expect(href(TITLE.dealNudge)).toBe(`/deals/${id.deal}`);
    expect(href(TITLE.feedback)).toBe(`/viewings/${id.viewing}`);
    expect(href(TITLE.adminOverdue)).toBe("/tasks"); // links nothing: stays on the list
    expect(tasks.links.find(([, t]) => t.includes(TITLE.dealNudge))?.[1]).toContain("No contact");
    expect(tasks.links.find(([, t]) => t.includes(TITLE.feedback))?.[1]).toContain("Feedback due");
    // a colleague's and an unassigned task are not "my" day
    for (const t of [TITLE.agentOverdue, TITLE.unassignedOverdue, TITLE.otherOrg]) expect(tasks.text).not.toContain(t);
    console.log(`[evidence] My day tasks: badge ${tasks.count} = count(*) ${rows[0]!.n}; links ${JSON.stringify(tasks.links.map(([h]) => h))}`);
  });

  it("lists today's viewing, and the hot-buyers card is still there", async () => {
    const tree = await as(admin, () => MyDay({ profileId: admin.id }));
    const viewings = card(cardsOf(tree), "Today's viewings");
    expect(viewings.count).toBe(1);
    expect(viewings.links.map(([h]) => h)).toEqual([`/viewings/${id.viewing}`]);
    const hot = [...walk(tree)].find((e) => e.type === HotIdleCard);
    expect(hot?.props.profileId).toBe(admin.id);
  });

  it("puts unanswered leads first, counts 'qualified' as open, and links each where its next step is", async () => {
    const leads = card(cardsOf(await as(admin, () => MyDay({ profileId: admin.id }))), "My open leads");
    expect(leads.count).toBe(2); // new + qualified; not the lost one, not the agent's
    expect(leads.text).toContain("1 unanswered");
    expect(leads.links.map(([h]) => h)).toEqual(["/leads", `/contacts/${id.contact}`]);
    console.log(`[evidence] My open leads: badge ${leads.count}, order ${JSON.stringify(leads.links.map(([h]) => h))}`);
  });
});

describe("Team — admin only", () => {
  it("counts every open unassigned lead exactly, oldest first, and nothing closed or foreign", async () => {
    const team = cardsOf(await as(admin, () => TeamCards({ profileId: admin.id, level: 3 })));
    const leads = card(team, "Unassigned open leads");
    const { rows } = await pg.query<{ n: string }>(
      `select count(*)::text as n from leads where org_id = $1 and assigned_agent_id is null
         and status in ('new','contacted','qualified')`,
      [ORG],
    );
    expect(leads.count).toBe(2);
    expect(String(leads.count)).toBe(rows[0]!.n);
    // the older first; neither has a person to open, so both open the inbox
    expect(leads.links.map(([h]) => h)).toEqual(["/leads", "/leads"]);
    expect(leads.links).toHaveLength(2);
    console.log(`[evidence] Unassigned open leads: badge ${leads.count} = count(*) ${rows[0]!.n}`);
  });

  it("counts everyone else's overdue work exactly — the NULL assignee included, mine, done and future excluded", async () => {
    const overdue = card(cardsOf(await as(admin, () => TeamCards({ profileId: admin.id }))), "Overdue across the team");
    const { rows } = await pg.query<{ n: string }>(
      `select count(*)::text as n from tasks where org_id = $1 and not is_done and due_at < now()
         and (assignee_id is null or assignee_id <> $2)`,
      [ORG, admin.id],
    );
    expect(overdue.count).toBe(2);
    expect(String(overdue.count)).toBe(rows[0]!.n);
    const row = (title: string) => overdue.links.find(([, text]) => text.includes(title));
    // oldest first: the unassigned one is four days late, the agent's two
    expect(overdue.links.map(([, text]) => text.includes(TITLE.unassignedOverdue))).toEqual([true, false]);
    expect(row(TITLE.unassignedOverdue)?.[0]).toBe(`/contacts/${id.contact}`);
    expect(row(TITLE.unassignedOverdue)?.[1]).toContain("Unassigned");
    expect(row(TITLE.agentOverdue)?.[0]).toBe(`/properties/${id.property}`);
    expect(row(TITLE.agentOverdue)?.[1]).toContain(`Test agent mday-g-${RUN}@test.local`);
    for (const t of [TITLE.adminOverdue, TITLE.agentDone, TITLE.agentFuture, TITLE.otherOrg, TITLE.dealNudge]) {
      expect(overdue.text).not.toContain(t);
    }
    console.log(`[evidence] Overdue across the team: badge ${overdue.count} = count(*) ${rows[0]!.n}`);
  });
});

describe("the admin feed, split", () => {
  it("keeps a config change out of the sales feed and shows it under settings & admin changes", async () => {
    const tree = await as(admin, () => AdminDashboard({ orgId: ORG }));
    const feeds = [...walk(tree)].filter((e) => e.type === Card);
    const feedOf = (title: string) => {
      const c = feeds.find((f) => f.props.title === title);
      if (!c) throw new Error(`no "${title}" card`);
      const tl = [...walk(c.props.children)].find((e) => e.type === EventTimeline);
      return (tl!.props.events as { id: string | number; entity_type: string; event_type: string }[]).map((e) => ({
        id: String(e.id),
        entity_type: e.entity_type,
        event_type: e.event_type,
      }));
    };
    expect(feeds.map((f) => f.props.title)).not.toContain("Latest events");
    const sales = feedOf("Latest sales activity");
    const adminFeed = feedOf("Settings & admin changes");

    // the ten NEWEST sales events, though a config change is newer than all of them
    expect(sales.map((e) => e.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => id[`sale${11 - i}`]),
    );
    expect(sales.every((e) => e.entity_type === "property")).toBe(true);
    // newest first; whatever else the fixtures' setup wrote there is admin-typed too
    expect(adminFeed[0]).toEqual({ id: id.configEvent, entity_type: "config", event_type: "locations_updated" });
    expect(adminFeed.every((e) => ["organization", "user", "config", "export"].includes(e.entity_type))).toBe(true);
    expect(adminFeed.map((e) => e.id)).not.toContain(id.otherConfigEvent);
    expect(sales.map((e) => e.id)).not.toContain(id.configEvent);
    console.log(`[evidence] sales feed ${sales.length} property events; admin feed ${JSON.stringify(adminFeed)}`);
  });
});

describe("an agent's My day", () => {
  it("holds the agent's own overdue task, opening its record, and nothing of the admin's", async () => {
    const tasks = card(cardsOf(await as(agent, () => MyDay({ profileId: agent.id }))), "Tasks due today & overdue");
    expect(tasks.count).toBe(1);
    expect(tasks.links).toHaveLength(1);
    expect(tasks.links[0]![0]).toBe(`/properties/${id.property}`);
    expect(tasks.links[0]![1]).toContain(TITLE.agentOverdue);
    for (const t of [TITLE.dealNudge, TITLE.feedback, TITLE.adminOverdue, TITLE.unassignedOverdue]) {
      expect(tasks.text).not.toContain(t);
    }
  });

  it("cannot see the admin's tasks even when it asks for them by assignee (RLS, not the page)", async () => {
    const { client } = await session(agent);
    const { data, error } = await client.from("tasks").select("id").eq("assignee_id", admin.id);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

describe("a count that does not come back is a failure, never a zero", () => {
  /** rows, but no Content-Range — postgrest-js then answers count: null */
  const uncounted = () =>
    new Response("[]", { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });

  async function thrownBy(user: TestUser, match: Steer["match"], render: () => Promise<unknown>) {
    const s = await session(user);
    s.steer = { match, respond: uncounted, hits: 0 };
    try {
      await as(user, render);
      return { thrown: null as string | null, hits: s.steer.hits };
    } catch (e) {
      return { thrown: e instanceof Error ? e.message : String(e), hits: s.steer.hits };
    } finally {
      s.steer = null;
    }
  }

  it("My day's task badge", async () => {
    const r = await thrownBy(
      admin,
      (m, u) => m === "GET" && u.includes("/rest/v1/tasks?") && u.includes("due_at=lt.") && u.includes(`assignee_id=eq.${admin.id}`),
      () => MyDay({ profileId: admin.id }),
    );
    expect(r.hits).toBe(1);
    expect(r.thrown).toMatch(/^Query failed \(tasks due today\): no count returned/);
  });

  it("My day's lead badge", async () => {
    const r = await thrownBy(
      admin,
      (m, u) => m === "GET" && u.includes("/rest/v1/leads?") && u.includes("first_response_at=is.null"),
      () => MyDay({ profileId: admin.id }),
    );
    expect(r.hits).toBe(1);
    expect(r.thrown).toMatch(/^Query failed \(my unanswered leads\): no count returned/);
  });

  it("Team's overdue badge", async () => {
    const r = await thrownBy(
      admin,
      (m, u) => m === "GET" && u.includes("/rest/v1/tasks?") && u.includes("assignee_id.is.null"),
      () => TeamCards({ profileId: admin.id }),
    );
    expect(r.hits).toBe(1);
    expect(r.thrown).toMatch(/^Query failed \(team overdue tasks\): no count returned/);
  });

  it("Team's unassigned-leads badge", async () => {
    const r = await thrownBy(
      admin,
      (m, u) => m === "GET" && u.includes("/rest/v1/leads?") && u.includes("assigned_agent_id=is.null"),
      () => TeamCards({ profileId: admin.id }),
    );
    expect(r.hits).toBe(1);
    expect(r.thrown).toMatch(/^Query failed \(unassigned open leads\): no count returned/);
  });
});
