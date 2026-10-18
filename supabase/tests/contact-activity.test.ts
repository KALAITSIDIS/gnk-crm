import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * A06 against the REAL stack (PostgREST, RLS, the events chain, the lead-SLA
 * sweep): a customer's combined Activity, its summary strip, and the rule the
 * item was validated against — a WhatsApp or Telegram click never stops the
 * response clock.
 *
 *   1. THE CLOCK. The real `logChatLinkOpened`, as the lead's agent, on a
 *      website lead an hour past its SLA: `first_response_at` stays null, the
 *      status stays `new`, the `lead_unanswered` task stays open through the
 *      sweep (0098), and the buyer's deal keeps its `last_contact_at`. No
 *      trigger stamps anything either. The contrast: the real `markContacted`
 *      stamps it and the next sweep closes the task.
 *   2. THE FEED, read as a non-admin COLLEAGUE through `readEntityTimelines`
 *      with ids read on their own session the way the contact page reads them:
 *      the lead's call and click arrive, with the author named; delivery
 *      telemetry does not; a signed slip's names do not (an admin's feed keeps
 *      them); a deal they may not read contributes nothing; another
 *      organisation's event naming the same contact id never appears.
 *   3. THE STRIP: "Last logged contact" is the call, not the newer chat click,
 *      which is "Last chat opened"; the next task is the viewer's OWN (a
 *      colleague's earlier task and its title stay hidden), an admin's is the
 *      earliest of all; the next viewing is the scheduled one.
 *   4. A DEVELOPER WITH 250 DEALS (A06 review): the page's history ids are
 *      every deal (`readContactHistoryIds`), not the Deals tab's newest 50,
 *      and the readers send them in slices — one `.in()` of all 250 is a 414
 *      from this gateway — so a call logged on a deal outside the tab's 50 is
 *      still the strip's "Last logged contact" and on the feed.
 *
 * Nothing below the services is stubbed but the Next.js request plumbing:
 * `createClient` is the acting user's aal2 session, `createAdminClient` the
 * real service client. Throwaway organisations, deleted at the end as
 * postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const ORG_X = randomUUID();
const RUN = Date.now().toString(36);

const state = vi.hoisted(() => ({ queue: [] as unknown[] }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = state.queue.shift();
    if (!c) throw new Error("test harness: no client queued for this action");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("./helpers");
  return { createAdminClient: () => h.serviceClient() };
});

import { logChatLinkOpened, markContacted } from "@/lib/actions/leads";
import { CUSTOMER_FEED_SKIPPED_TYPES, readEntityTimelines } from "@/lib/services/entity-timeline";
import { readContactActivitySummary } from "@/lib/services/contact-activity-summary";
import { readContactHistoryIds } from "@/lib/queries/contact-history";

let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let agentA: TestUser;
let agentB: TestUser;
const userIds: string[] = [];
let contact: string;
let property: string;
let deal: string;
let viewing: string;
let clockLead: string;
let phoneLead: string;
let foreignEvent: number;

async function one<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T> {
  return (await pg.query(sql, args)).rows[0] as T;
}

/** an event as the database or a definer writes one — postgres, explicit actor */
async function plant(org: string, actor: string | null, entityType: string, entityId: string, eventType: string, payload: object) {
  return (
    await one<{ id: string }>(
      "insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload) values ($1, $2, $3, $4, $5, $6) returning id",
      [org, actor, entityType, entityId, eventType, JSON.stringify(payload)],
    )
  ).id;
}

const sweep = async () => (await one<{ n: number }>("select public.raise_lead_sla_tasks($1, 60) as n", [ORG])).n;
const slaTask = async () =>
  one<{ open: number; done: number }>(
    "select count(*) filter (where not is_done)::int as open, count(*) filter (where is_done)::int as done from tasks where lead_id = $1 and kind = 'lead_unanswered'",
    [clockLead],
  );
const leadRow = async (id: string) =>
  one<{ status: string; first_response_at: Date | null; first_call_at: Date | null }>(
    "select status::text as status, first_response_at, first_call_at from leads where id = $1",
    [id],
  );

/** The contact page's own reads, on the viewer's session: the ids its reader may be handed. */
async function idsAs(user: TestUser) {
  const leads = await user.client.from("leads").select("id").eq("contact_id", contact);
  const deals = await user.client.from("deals").select("id").or(`buyer_contact_id.eq.${contact},seller_contact_id.eq.${contact}`);
  const viewings = await user.client.from("viewings").select("id").eq("contact_id", contact);
  for (const r of [leads, deals, viewings]) if (r.error || !Array.isArray(r.data)) throw new Error(`ids read: ${r.error?.message}`);
  return {
    leadIds: (leads.data ?? []).map((r) => r.id as string),
    dealIds: (deals.data ?? []).map((r) => r.id as string),
    viewingIds: (viewings.data ?? []).map((r) => r.id as string),
  };
}

async function feedAs(user: TestUser, role: string) {
  const ids = await idsAs(user);
  return readEntityTimelines({
    orgId: ORG,
    viewerRole: role,
    viewer: user.client as never,
    sources: [
      { entityType: "contact", entityIds: [contact] },
      { entityType: "lead", entityIds: ids.leadIds },
      { entityType: "deal", entityIds: ids.dealIds },
      { entityType: "viewing", entityIds: ids.viewingIds },
    ],
    perSource: 50,
    limit: 100,
    excludeEventTypes: CUSTOMER_FEED_SKIPPED_TYPES,
  });
}

async function summaryAs(user: TestUser) {
  const ids = await idsAs(user);
  return readContactActivitySummary({
    orgId: ORG,
    viewer: user.client as never,
    contactId: contact,
    contactIds: [contact],
    leadIds: ids.leadIds,
    dealIds: ids.dealIds,
    now: new Date(),
  });
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Activity ${RUN}`, `activity-${RUN}`);
  await ensureTestOrg(svc, ORG_X, `Activity X ${RUN}`, `activity-x-${RUN}`);
  // each id is kept as soon as it exists, so a later failure still cleans it up
  admin = await createTestUser(svc, `ca-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agentA = await createTestUser(svc, `ca-agent-a-${RUN}@test.local`, "agent", ORG);
  userIds.push(agentA.id);
  agentB = await createTestUser(svc, `ca-agent-b-${RUN}@test.local`, "agent", ORG);
  userIds.push(agentB.id);

  const stage = (
    await one<{ id: string }>(
      "select id from deal_stages where org_id = $1 and deal_type = 'sale' and not is_won and not is_lost order by sort_order limit 1",
      [ORG],
    )
  ).id;
  contact = (await one<{ id: string }>("insert into contacts (org_id, first_name) values ($1, $2) returning id", [ORG, `ZZActivity ${RUN}`])).id;
  property = (
    await one<{ id: string }>(
      "insert into properties (org_id, reference, property_type, status) values ($1, $2, 'apartment', 'available') returning id",
      [ORG, `ZZCA${RUN.slice(-5).toUpperCase()}`],
    )
  ).id;
  deal = (
    await one<{ id: string }>(
      `insert into deals (org_id, deal_type, stage_id, title, agent_id, created_by, buyer_contact_id, last_contact_at, last_activity_at)
       values ($1, 'sale', $2, $3, $4, $4, $5, '2026-01-02T10:00:00Z', '2026-01-02T10:00:00Z') returning id`,
      [ORG, stage, `ZZActivity deal ${RUN}`, agentA.id, contact],
    )
  ).id;
  viewing = (
    await one<{ id: string }>(
      "insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at) values ($1, $2, $3, $4, now() + interval '1 day') returning id",
      [ORG, property, contact, agentA.id],
    )
  ).id;
  // a website enquiry two hours old, unanswered, assigned to agent A — the SLA sweep's case
  clockLead = (
    await one<{ id: string }>(
      `insert into leads (org_id, source, message, contact_id, assigned_agent_id, received_at)
       values ($1, 'website', $2, $3, $4, now() - interval '2 hours') returning id`,
      [ORG, `ZZActivity website enquiry ${RUN}`, contact, agentA.id],
    )
  ).id;
  // a phoned-in lead for the same person, already being worked
  phoneLead = (
    await one<{ id: string }>(
      `insert into leads (org_id, source, message, contact_id, assigned_agent_id, status, first_response_at)
       values ($1, 'phone', $2, $3, $4, 'contacted', now()) returning id`,
      [ORG, `ZZActivity phone enquiry ${RUN}`, contact, agentA.id],
    )
  ).id;
});

afterAll(async () => {
  const orgs = [ORG, ORG_X];
  for (const t of ["interaction_notes", "notification_jobs", "viewing_slips", "tasks", "viewings", "leads", "deals", "contacts", "properties"]) {
    await pg.query(`delete from ${t} where org_id = any($1)`, [orgs]);
  }
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = any($1)`, [orgs]);
  }
  await pg.query("delete from organizations where id = any($1)", [orgs]);
  await pg.end();
});

describe("a chat-link click never stops the response clock", () => {
  it("a WhatsApp click on the lead and a Telegram click on the contact: no first response, the SLA task stays open, the deal's last contact unmoved", async () => {
    // the count it returns is not asserted: the stack's own every-ten-minutes
    // job may have minted the task first — one open task either way
    await sweep();
    expect(await slaTask(), "the sweep mints the unanswered-enquiry task").toEqual({ open: 1, done: 0 });

    state.queue.push(agentA.client);
    await logChatLinkOpened(clockLead, null, "whatsapp");
    state.queue.push(agentA.client);
    await logChatLinkOpened(null, contact, "telegram");

    const clicks = await one<{ lead: number; contact: number }>(
      `select count(*) filter (where entity_type = 'lead' and entity_id = $1)::int as lead,
              count(*) filter (where entity_type = 'contact' and entity_id = $2)::int as contact
         from events where org_id = $3 and event_type = 'chat_link_opened'`,
      [clockLead, contact, ORG],
    );
    expect(clicks, "both clicks were recorded").toEqual({ lead: 1, contact: 1 });

    const lead = await leadRow(clockLead);
    expect(lead.first_response_at, "the clock is still running").toBeNull();
    expect(lead.first_call_at).toBeNull();
    expect(lead.status, "and the lead is still new").toBe("new");

    const d = await one<{ last_contact_at: Date; last_activity_at: Date }>(
      "select last_contact_at, last_activity_at from deals where id = $1",
      [deal],
    );
    expect(d.last_contact_at.toISOString(), "the no-contact nudge is not silenced by a click").toBe("2026-01-02T10:00:00.000Z");
    expect(d.last_activity_at.toISOString()).toBe("2026-01-02T10:00:00.000Z");

    await sweep();
    expect(await slaTask(), "the sweep still finds the enquiry unanswered").toEqual({ open: 1, done: 0 });
  });

  it("the contrast: Contacted stamps the clock and the next sweep closes the task", async () => {
    state.queue.push(agentA.client);
    await markContacted(clockLead);
    const lead = await leadRow(clockLead);
    expect(lead.first_response_at).not.toBeNull();
    expect(lead.status).toBe("contacted");
    await sweep();
    expect(await slaTask()).toEqual({ open: 0, done: 1 });
  });
});

describe("the combined feed, as a colleague and as an admin", () => {
  let called: string;
  let telemetry: string;
  let slip: string;
  let dealStage: string;

  beforeAll(async () => {
    called = await plant(ORG, agentA.id, "lead", phoneLead, "called", { first_call: true });
    telemetry = await plant(ORG, null, "lead", phoneLead, "enquiry_alert", { status: "sent" });
    slip = await plant(ORG, agentA.id, "viewing", viewing, "viewing_slip_signed", {
      sha256: "0".repeat(64),
      signer_name: `ZZQuill Signer ${RUN}`,
      second_attendee: `ZZQuill Second ${RUN}`,
      geotagged: false,
    });
    dealStage = await plant(ORG, null, "deal", deal, "updated", { section: "terms" });
    // ANOTHER organisation's event naming this contact's id — the org bound is all that keeps it out
    foreignEvent = Number(await plant(ORG_X, null, "contact", contact, "updated", { section: "foreign" }));
  });

  it("a colleague sees the lead's call and both clicks, named, and none of the telemetry", async () => {
    const feed = await feedAs(agentB, "agent");
    expect(feed.incomplete).toBe(false);
    const ids = feed.rows.map((r) => String(r.id));
    expect(ids).toContain(String(called));
    expect(ids, "delivery telemetry is not the customer's history").not.toContain(String(telemetry));
    expect(feed.rows.filter((r) => r.event_type === "chat_link_opened").map((r) => r.entity_type).sort()).toEqual(["contact", "lead"]);
    expect(feed.rows.some((r) => r.event_type === "contacted" && r.entity_type === "lead"), "the inbox tap from section 1").toBe(true);

    const call = feed.rows.find((r) => String(r.id) === String(called))!;
    expect(call.actor_id).toBe(agentA.id);
    expect(call.actor_name, "the author, read from profiles as the colleague").toBe(`Test agent ca-agent-a-${RUN}@test.local`);
  });

  it("a colleague never reads a signed slip's names, and a deal they may not read adds nothing", async () => {
    const feed = await feedAs(agentB, "agent");
    const s = feed.rows.find((r) => String(r.id) === String(slip));
    expect(s, "the slip's event is on the feed").toBeDefined();
    expect(JSON.stringify(feed.rows)).not.toContain("ZZQuill");
    expect(feed.rows.map((r) => String(r.id)), "deals_select hides agent A's deal from agent B").not.toContain(String(dealStage));
  });

  it("another organisation's event naming the same id never appears", async () => {
    for (const [user, role] of [[agentB, "agent"], [admin, "admin"]] as const) {
      const feed = await feedAs(user, role);
      expect(feed.rows.map((r) => Number(r.id))).not.toContain(foreignEvent);
    }
  });

  it("an admin's feed keeps the slip's names and the deal's events", async () => {
    const feed = await feedAs(admin, "admin");
    const s = feed.rows.find((r) => String(r.id) === String(slip))!;
    expect((s.payload as Record<string, unknown>).signer_name).toBe(`ZZQuill Signer ${RUN}`);
    expect(feed.rows.map((r) => String(r.id))).toContain(String(dealStage));
  });
});

describe("the summary strip", () => {
  let colleagueTask: string;
  let ownTask: string;

  beforeAll(async () => {
    // agent A's task on the phone lead, due first — invisible to agent B
    colleagueTask = (
      await one<{ id: string }>(
        "insert into tasks (org_id, title, due_at, assignee_id, lead_id) values ($1, $2, now() + interval '1 day', $3, $4) returning id",
        [ORG, `ZZ agent A private: call about the deposit ${RUN}`, agentA.id, phoneLead],
      )
    ).id;
    ownTask = (
      await one<{ id: string }>(
        "insert into tasks (org_id, title, due_at, assignee_id, contact_id) values ($1, $2, now() + interval '3 days', $3, $4) returning id",
        [ORG, `ZZ agent B: send the brochure ${RUN}`, agentB.id, contact],
      )
    ).id;
  });

  it("last logged contact is the call; the NEWER chat click is only 'last chat opened'", async () => {
    // a click after the call, through the real action
    state.queue.push(agentB.client);
    await logChatLinkOpened(null, contact, "whatsapp");

    const s = await summaryAs(agentB);
    expect(s.lastContact.ok && s.lastContact.value?.event_type).toBe("called");
    expect(s.lastContact.ok && s.lastContact.value?.entity_type).toBe("lead");
    expect(s.lastChatOpened.ok && s.lastChatOpened.value?.payload).toEqual({ channel: "whatsapp" });
    if (s.lastContact.ok && s.lastChatOpened.ok && s.lastContact.value && s.lastChatOpened.value) {
      expect(Date.parse(s.lastChatOpened.value.occurred_at)).toBeGreaterThanOrEqual(Date.parse(s.lastContact.value.occurred_at));
    }
  });

  it("an agent's next step is their OWN task — a colleague's earlier one, and its title, stay hidden", async () => {
    const s = await summaryAs(agentB);
    expect(s.nextTask).toEqual({ ok: true, value: expect.objectContaining({ id: ownTask }) });
    expect(JSON.stringify(s)).not.toContain("deposit");
  });

  it("an admin's next step is the earliest of all; the next viewing is the scheduled one", async () => {
    const s = await summaryAs(admin);
    expect(s.nextTask).toEqual({ ok: true, value: expect.objectContaining({ id: colleagueTask }) });
    expect(s.nextViewing).toEqual({ ok: true, value: expect.objectContaining({ id: viewing }) });
  });
});

describe("a developer with 250 deals: every deal is asked about (A06 review)", () => {
  let developer: string;
  let farDeal: string;
  let farCall: string;

  beforeAll(async () => {
    const stage = (
      await one<{ id: string }>(
        "select id from deal_stages where org_id = $1 and deal_type = 'sale' and not is_won and not is_lost order by sort_order limit 1",
        [ORG],
      )
    ).id;
    developer = (
      await one<{ id: string }>("insert into contacts (org_id, first_name) values ($1, $2) returning id", [ORG, `ZZDeveloper ${RUN}`])
    ).id;
    // the seller on every unit deal of a project, each a day older than the last
    await pg.query(
      `insert into deals (org_id, deal_type, stage_id, title, agent_id, created_by, seller_contact_id, created_at)
       select $1, 'sale', $2, 'ZZDev unit ' || g || ' ' || $3, $4, $4, $5, now() - make_interval(days => g)
         from generate_series(1, 250) g`,
      [ORG, stage, RUN, agentA.id, developer],
    );
    // the Deals tab's read — the newest 50 by creation — and a deal outside it
    const tab = await admin.client
      .from("deals")
      .select("id")
      .or(`buyer_contact_id.eq.${developer},seller_contact_id.eq.${developer}`)
      .order("created_at", { ascending: false })
      .limit(50);
    if (tab.error || !Array.isArray(tab.data)) throw new Error(`tab read: ${tab.error?.message}`);
    const shown = new Set(tab.data.map((d) => d.id as string));
    farDeal = (
      await one<{ id: string }>(
        "select id from deals where org_id = $1 and seller_contact_id = $2 and not (id = any($3::uuid[])) order by created_at limit 1",
        [ORG, developer, [...shown]],
      )
    ).id;
    // yesterday's call — logged on the oldest unit deal, from its own page
    farCall = await plant(ORG, agentA.id, "deal", farDeal, "called", { first_call: false });
  });

  it("the history ids are all 250 deals — the tab's 50 do not include the deal the call was logged on", async () => {
    const ids = await readContactHistoryIds(admin.client as never, developer);
    expect(ids.dealIds).toHaveLength(250);
    expect(ids.dealIds).toContain(farDeal);
    expect(ids.leadIds).toEqual([]);
    expect(ids.viewingIds).toEqual([]);
  });

  it("one .in() of all 250 ids is refused by the gateway — the reason the readers slice", async () => {
    const ids = await readContactHistoryIds(admin.client as never, developer);
    const all = await svc.from("events").select("id").eq("org_id", ORG).eq("entity_type", "deal").in("entity_id", ids.dealIds).limit(1);
    expect(all.error, "an unsliced read of every deal's events does not answer").not.toBeNull();
    expect(all.status).toBe(414);
  });

  it("the strip's last logged contact is the call on the 250th deal; the feed has it", async () => {
    const ids = await readContactHistoryIds(admin.client as never, developer);
    const s = await readContactActivitySummary({
      orgId: ORG,
      viewer: admin.client as never,
      contactId: developer,
      contactIds: [developer],
      leadIds: ids.leadIds,
      dealIds: ids.dealIds,
      now: new Date(),
    });
    expect(s.lastContact).toEqual({
      ok: true,
      value: expect.objectContaining({ event_type: "called", entity_type: "deal" }),
    });
    expect(s.lastContact.ok && String(s.lastContact.value?.id)).toBe(String(farCall));
    expect(s.lastChatOpened).toEqual({ ok: true, value: null });

    const feed = await readEntityTimelines({
      orgId: ORG,
      viewerRole: "admin",
      viewer: admin.client as never,
      sources: [
        { entityType: "contact", entityIds: [developer] },
        { entityType: "deal", entityIds: ids.dealIds },
      ],
      perSource: 50,
      limit: 100,
      excludeEventTypes: CUSTOMER_FEED_SKIPPED_TYPES,
    });
    expect(feed.incomplete, "every slice answered").toBe(false);
    expect(feed.rows.map((r) => String(r.id))).toContain(String(farCall));
  });

  it("the contrast: asked about only the tab's 50, the same strip reads 'None logged yet'", async () => {
    const tab = await admin.client
      .from("deals")
      .select("id")
      .or(`buyer_contact_id.eq.${developer},seller_contact_id.eq.${developer}`)
      .order("created_at", { ascending: false })
      .limit(50);
    const s = await readContactActivitySummary({
      orgId: ORG,
      viewer: admin.client as never,
      contactId: developer,
      contactIds: [developer],
      leadIds: [],
      dealIds: (tab.data ?? []).map((d) => d.id as string),
      now: new Date(),
    });
    expect(s.lastContact, "the pre-review page's answer: a none standing in for data it never read").toEqual({ ok: true, value: null });
  });
});
