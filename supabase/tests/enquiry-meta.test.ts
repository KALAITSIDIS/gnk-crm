/**
 * 0098 — what the enquiry door does with `p_meta`, how a lead is assigned by
 * the routing rule, and the ten-minute SLA sweep (audit 2026-09-15, LR-01/02/05).
 *
 * The app's copy of the allowlist is pinned by lib/services/enquiry-meta.test.ts;
 * this file proves the SQL side — the one that is the boundary. The door's
 * return shape (one row: lead_id, lead_org_id, replayed) is 0096's.
 *
 * Requires the local Supabase stack. Run: npm run test:rls
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG_A, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

const svc = serviceClient();
const run = Date.now().toString(36);
const leadIds: string[] = [];
let adminA: TestUser;
let agentA: TestUser;
let agentB: TestUser;

type DoorRow = { lead_id: string; lead_org_id: string; replayed: boolean };

const submit = async (name: string, meta: unknown, key?: string) => {
  const r = await svc.rpc("submit_public_enquiry", {
    p_org_slug: "test-org-a",
    p_name: `${name} ${run}`,
    p_email: `${name.toLowerCase()}-${run}@example.invalid`,
    p_phone: "",
    p_message: `meta probe ${run}`,
    p_property_ref: "",
    p_idempotency_key: key ?? "",
    p_meta: meta,
  });
  if (r.error) throw new Error(`submit ${name}: ${r.error.message}`);
  const row = ((r.data ?? []) as DoorRow[])[0];
  if (!row) throw new Error(`submit ${name}: refused (zero rows)`);
  if (!leadIds.includes(row.lead_id)) leadIds.push(row.lead_id);
  return row;
};

const leadById = async (id: string) => {
  const { data, error } = await svc
    .from("leads")
    .select("id, criteria, assigned_agent_id, message, source")
    .eq("id", id)
    .single();
  if (error) throw new Error(`lead ${id}: ${error.message}`);
  return data;
};

const routing = (value: { mode: string; agents: string[] }) =>
  svc.from("cyprus_config").update({ value }).eq("key", "lead_routing");

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  adminA = await createTestUser(svc, `route-admin-${run}@example.invalid`, "admin", ORG_A);
  agentA = await createTestUser(svc, `route-a-${run}@example.invalid`, "agent", ORG_A);
  agentB = await createTestUser(svc, `route-b-${run}@example.invalid`, "agent", ORG_A);
});

afterAll(async () => {
  await routing({ mode: "off", agents: [] });
  await svc.from("tasks").delete().in("lead_id", leadIds);
  await svc.from("leads").delete().in("id", leadIds);
  for (const u of [adminA, agentA, agentB]) await svc.auth.admin.deleteUser(u.id);
});

describe("0098: the brief travels as data, shape only", () => {
  it("keeps allowlisted keys in criteria and drops everything else", async () => {
    const row = await submit("Meta", {
      budget: "300_500k",
      buy_area: "Peyia / Coral Bay",
      utm_source: "instagram",
      source_page: "/properties/PAF0001",
      email: "smuggled@example.invalid",
      name: "Smuggled",
      hack: "x",
      utm_campaign: "y".repeat(121),
      bedrooms_min: 3,
    });
    expect(row.replayed).toBe(false);
    const lead = await leadById(row.lead_id);
    expect(lead.source, "source stays website — the retention sweep keys on it").toBe("website");
    const c = lead.criteria as Record<string, unknown>;
    expect(c).toMatchObject({
      channel: "website_form",
      listing_reference: null,
      budget: "300_500k",
      buy_area: "Peyia / Coral Bay",
      utm_source: "instagram",
      source_page: "/properties/PAF0001",
    });
    for (const k of ["email", "name", "hack", "utm_campaign", "bedrooms_min"]) {
      expect(c, k).not.toHaveProperty(k);
    }
    expect(JSON.stringify(c)).not.toContain("smuggled");

    const { data: events } = await svc
      .from("events")
      .select("payload")
      .eq("entity_type", "lead")
      .eq("entity_id", row.lead_id)
      .eq("event_type", "created");
    expect(events).toHaveLength(1);
    expect(events![0]!.payload).toMatchObject({
      has_meta: true,
      utm_source: "instagram",
      source_page: "/properties/PAF0001",
    });
    expect(JSON.stringify(events![0]!.payload)).not.toContain("smuggled");
  });

  it("meta cannot override the two keys the function owns", async () => {
    const row = await submit("Override", { channel: "portal", listing_reference: "PAF9999" });
    const lead = await leadById(row.lead_id);
    expect(lead.criteria).toMatchObject({ channel: "website_form", listing_reference: null });
  });

  it("a call without p_meta still works — 0096's seven-argument shape", async () => {
    const r = await svc.rpc("submit_public_enquiry", {
      p_org_slug: "test-org-a",
      p_name: `Legacy ${run}`,
      p_email: `legacy-${run}@example.invalid`,
      p_phone: "",
      p_message: `meta probe ${run}`,
      p_property_ref: "",
      p_idempotency_key: "",
    });
    expect(r.error).toBeNull();
    const row = ((r.data ?? []) as DoorRow[])[0]!;
    expect(row.replayed).toBe(false);
    leadIds.push(row.lead_id);
    const lead = await leadById(row.lead_id);
    expect(lead.criteria).toEqual({ channel: "website_form", listing_reference: null });
    const { data: events } = await svc
      .from("events")
      .select("payload")
      .eq("entity_type", "lead")
      .eq("entity_id", row.lead_id)
      .eq("event_type", "created");
    expect(events![0]!.payload).toMatchObject({ has_meta: false });
  });

  it("a replay keeps the first post's meta and writes nothing (0096's key, 0098's data)", async () => {
    const key = `meta-replay-${run}`;
    const first = await submit("Replay", { budget: "over_1m" }, key);
    const again = await submit("Replay", { budget: "under_300k" }, key);
    expect(again.lead_id).toBe(first.lead_id);
    expect(again.replayed).toBe(true);
    expect((await leadById(first.lead_id)).criteria).toMatchObject({ budget: "over_1m" });
  });
});

describe("0098: the routing rule", () => {
  it("off (the default): the lead is unassigned", async () => {
    await routing({ mode: "off", agents: [] });
    const row = await submit("Unrouted", {});
    expect((await leadById(row.lead_id)).assigned_agent_id).toBeNull();
  });

  it("round_robin: the member with the fewest open leads takes it, and an event says so", async () => {
    const { error } = await routing({ mode: "round_robin", agents: [agentA.id, agentB.id] });
    expect(error).toBeNull();
    const one = await leadById((await submit("RouteOne", {})).lead_id);
    expect([agentA.id, agentB.id]).toContain(one.assigned_agent_id);
    const two = await leadById((await submit("RouteTwo", {})).lead_id);
    expect(two.assigned_agent_id, "the second lead goes to the other member").not.toBe(one.assigned_agent_id);
    expect([agentA.id, agentB.id]).toContain(two.assigned_agent_id);

    const { data: ev } = await svc
      .from("events")
      .select("actor_id, payload")
      .eq("entity_type", "lead")
      .eq("entity_id", one.id)
      .eq("event_type", "assigned");
    expect(ev).toHaveLength(1);
    expect(ev![0]!.actor_id, "nobody signed in did this").toBeNull();
    expect(ev![0]!.payload).toMatchObject({ to: one.assigned_agent_id, via: "routing_rule" });
  });

  it("an inactive member is never chosen, and a rule naming nobody usable assigns nobody", async () => {
    await svc.from("profiles").update({ is_active: false }).eq("id", agentB.id);
    await routing({ mode: "round_robin", agents: [agentB.id] });
    const row = await submit("RouteNone", {});
    expect((await leadById(row.lead_id)).assigned_agent_id).toBeNull();
    await svc.from("profiles").update({ is_active: true }).eq("id", agentB.id);
    await routing({ mode: "off", agents: [] });
  });
});

describe("0098: the lead SLA sweep", () => {
  const tasksFor = async (leadId: string) =>
    (
      await svc
        .from("tasks")
        .select("id, kind, is_done, assignee_id, title, due_at")
        .eq("lead_id", leadId)
    ).data ?? [];

  it("raises one task for a website lead unanswered over an hour, once, and closes it when answered", async () => {
    await routing({ mode: "off", agents: [] });
    const { lead_id: leadId } = await submit("Slow", {});
    await svc
      .from("leads")
      .update({ received_at: new Date(Date.now() - 61 * 60_000).toISOString() })
      .eq("id", leadId);

    const first = await svc.rpc("raise_lead_sla_tasks", { p_org: ORG_A });
    expect(first.error).toBeNull();
    expect(Number(first.data)).toBeGreaterThanOrEqual(1);

    let t = await tasksFor(leadId);
    expect(t).toHaveLength(1);
    expect(t[0]!.kind).toBe("lead_unanswered");
    expect(t[0]!.assignee_id, "unassigned lead → the oldest active admin").not.toBeNull();
    expect(t[0]!.title, "no name in a task title").not.toContain("Slow");
    expect(t[0]!.is_done).toBe(false);

    const { data: ev } = await svc
      .from("events")
      .select("actor_id, payload")
      .eq("entity_type", "lead")
      .eq("entity_id", leadId)
      .eq("event_type", "followup_task_created");
    expect(ev).toHaveLength(1);
    expect(ev![0]!.actor_id).toBeNull();
    expect(ev![0]!.payload).toMatchObject({ kind: "lead_unanswered", minutes: 60, task_id: t[0]!.id });

    const second = await svc.rpc("raise_lead_sla_tasks", { p_org: ORG_A });
    expect(second.error).toBeNull();
    expect(await tasksFor(leadId), "a second run mints nothing new").toHaveLength(1);

    await svc
      .from("leads")
      .update({ first_response_at: new Date().toISOString(), status: "contacted" })
      .eq("id", leadId);
    await svc.rpc("raise_lead_sla_tasks", { p_org: ORG_A });
    t = await tasksFor(leadId);
    expect(t[0]!.is_done, "answered → superseded").toBe(true);
    const { data: closed } = await svc
      .from("events")
      .select("payload")
      .eq("entity_type", "task")
      .eq("entity_id", t[0]!.id)
      .eq("event_type", "superseded");
    expect(closed).toHaveLength(1);
    expect(closed![0]!.payload).toMatchObject({ kind: "lead_unanswered", reason: "lead_answered_or_closed" });
  });

  it("goes to the assigned agent when there is one", async () => {
    await routing({ mode: "round_robin", agents: [agentA.id] });
    const { lead_id: leadId } = await submit("Routed", {});
    await routing({ mode: "off", agents: [] });
    expect((await leadById(leadId)).assigned_agent_id).toBe(agentA.id);
    await svc
      .from("leads")
      .update({ received_at: new Date(Date.now() - 90 * 60_000).toISOString() })
      .eq("id", leadId);
    await svc.rpc("raise_lead_sla_tasks", { p_org: ORG_A });
    const t = await tasksFor(leadId);
    expect(t).toHaveLength(1);
    expect(t[0]!.assignee_id).toBe(agentA.id);
  });

  it("ignores a lead still inside the hour, and one the desk closed", async () => {
    const { lead_id: quick } = await submit("Quick", {});
    await svc
      .from("leads")
      .update({ received_at: new Date(Date.now() - 30 * 60_000).toISOString() })
      .eq("id", quick);
    const { lead_id: spam } = await submit("Spam", {});
    await svc
      .from("leads")
      .update({ received_at: new Date(Date.now() - 120 * 60_000).toISOString(), status: "spam" })
      .eq("id", spam);
    await svc.rpc("raise_lead_sla_tasks", { p_org: ORG_A });
    expect(await tasksFor(quick)).toHaveLength(0);
    expect(await tasksFor(spam)).toHaveLength(0);
  });
});
