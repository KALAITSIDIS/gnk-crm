import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alertFromLead } from "@/lib/services/enquiry-alert-jobs";
import { ORG_A, ORG_B, anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * 0106: "I'm interested" on a shared proposal — a buyer's explicit interest
 * in ONE property becomes an enquiry in the CRM, through the same pipeline
 * as the website door (a lead, its `created` event, its durable desk-alert
 * row, the routing to a person), with the proposal as its provenance.
 *
 * What the function must and must not do (audit 2026-09-21, finding 4):
 *   - the ORGANISATION, the PROPOSAL and the PROPERTY are resolved on the
 *     server from the token digest — the caller names a reference, never an
 *     id, and cannot pick an org;
 *   - an expired, revoked or unknown token, a reference outside the proposal,
 *     and an archived property are all refused the same way: no rows;
 *   - a forwarded link proves nothing about who is typing, so the link's
 *     contact is NEVER attributed — the enquirer gives their own name and a
 *     way to reply, like any website enquiry;
 *   - the proposal's author is the natural owner: the lead is assigned to the
 *     link's creator while they are active;
 *   - the idempotency key makes a retry the same lead (and no second alert);
 *   - the message carries the SAME block the desk e-mail is rebuilt from, so
 *     the alert worker needs nothing new;
 *   - nothing personal enters an event, and no token is stored anywhere.
 */
const svc = serviceClient();
const run = Date.now().toString(36);
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const mint = () => randomBytes(32).toString("base64url");

let adminA: TestUser;
let agentA: TestUser;
let contactId: string;
let propertyId: string;
let reference: string;
let archivedReference: string;
let outsideReference: string;
let linkId: string;
let liveToken: string;
let expiredToken: string;
let revokedToken: string;
let contactLessToken: string;
let bToken: string;
const madeLinks: string[] = [];
const madeProps: string[] = [];
const madeLeads: string[] = [];

async function mkProperty(orgId: string, ref: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await svc
    .from("properties")
    .insert({
      org_id: orgId,
      reference: ref,
      property_type: "villa",
      visibility: "private",
      status: "available",
      title: { en: `Interest ${ref}` },
      asking_price: 450000,
      ...extra,
    })
    .select("id")
    .single();
  if (error) throw new Error(`mkProperty ${ref}: ${error.message}`);
  madeProps.push(data.id);
  return data.id as string;
}

async function mkLink(orgId: string, createdBy: string, props: string[], extra: Record<string, unknown> = {}) {
  const token = mint();
  const { data, error } = await svc
    .from("share_links")
    .insert({
      org_id: orgId,
      token_sha256: sha(token),
      locale: "el",
      title: `Selection ${run}`,
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      created_by: createdBy,
      ...extra,
    })
    .select("id")
    .single();
  if (error) throw new Error(`mkLink: ${error.message}`);
  await svc.from("share_link_properties").insert(props.map((p, i) => ({ share_link_id: data.id, property_id: p, sort_order: i })));
  madeLinks.push(data.id);
  return { token, id: data.id as string };
}

async function interest(token: string, ref: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await svc.rpc("submit_proposal_interest", {
    p_token_sha256: sha(token),
    p_property_ref: ref,
    p_name: `Buyer ${run}`,
    p_email: `buyer-${run}@example.invalid`,
    p_phone: "",
    p_message: "",
    p_idempotency_key: `int-${run}-${ref}`,
    ...overrides,
  });
  if (error) throw new Error(`interest: ${error.message}`);
  const rows = (data ?? []) as Array<{ lead_id: string; lead_org_id: string; replayed: boolean }>;
  for (const r of rows) if (!madeLeads.includes(r.lead_id)) madeLeads.push(r.lead_id);
  return rows;
}

async function lead(id: string) {
  const { data, error } = await svc.from("leads").select("*").eq("id", id).single();
  if (error) throw new Error(`lead: ${error.message}`);
  return data as Record<string, unknown>;
}

async function eventsFor(entityType: string, entityId: string) {
  const { data, error } = await svc
    .from("events")
    .select("event_type, payload, actor_id")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("occurred_at", { ascending: true });
  if (error) throw new Error(`events: ${error.message}`);
  return (data ?? []) as Array<{ event_type: string; payload: Record<string, unknown>; actor_id: string | null }>;
}

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  await ensureTestOrg(svc, ORG_B, "Test Org B", "test-org-b");
  adminA = await createTestUser(svc, `interest-admin-a-${run}@test.local`, "admin", ORG_A);
  agentA = await createTestUser(svc, `interest-agent-a-${run}@test.local`, "agent", ORG_A);

  const { data: contact, error: cErr } = await svc
    .from("contacts")
    .insert({ org_id: ORG_A, first_name: "Recipient", last_name: run, email: `recipient-${run}@example.invalid` })
    .select("id")
    .single();
  if (cErr) throw new Error(cErr.message);
  contactId = contact.id;

  reference = `INT-${run.toUpperCase()}-A`;
  archivedReference = `INT-${run.toUpperCase()}-X`;
  outsideReference = `INT-${run.toUpperCase()}-O`;
  propertyId = await mkProperty(ORG_A, reference);
  const archivedId = await mkProperty(ORG_A, archivedReference, { visibility: "archived" });
  await mkProperty(ORG_A, outsideReference); // in the org, NOT in the proposal

  const live = await mkLink(ORG_A, agentA.id, [propertyId, archivedId], { contact_id: contactId });
  linkId = live.id;
  liveToken = live.token;
  expiredToken = (await mkLink(ORG_A, agentA.id, [propertyId], { expires_at: new Date(Date.now() - 60_000).toISOString() })).token;
  revokedToken = (await mkLink(ORG_A, agentA.id, [propertyId], { revoked_at: new Date().toISOString() })).token;
  contactLessToken = (await mkLink(ORG_A, adminA.id, [propertyId])).token;
  // org B's link naming org A's property never resolves org A's listing
  const bProp = await mkProperty(ORG_B, `INT-${run.toUpperCase()}-B`);
  bToken = (await mkLink(ORG_B, adminA.id, [bProp])).token;
});

afterAll(async () => {
  if (madeLeads.length) {
    await svc.from("tasks").delete().in("lead_id", madeLeads);
    await svc.from("leads").delete().in("id", madeLeads);
  }
  if (madeLinks.length) {
    await svc.from("share_link_properties").delete().in("share_link_id", madeLinks);
    await svc.from("share_links").delete().in("id", madeLinks);
  }
  if (madeProps.length) await svc.from("properties").delete().in("id", madeProps);
  if (contactId) await svc.from("contacts").delete().eq("id", contactId);
});

describe("submit_proposal_interest — a valid submission", () => {
  it("makes one lead in the LINK's org, bound to the resolved property, with the proposal as provenance", async () => {
    const [row] = await interest(liveToken, reference);
    expect(row, "one row: the lead").toBeDefined();
    expect(row!.replayed).toBe(false);
    expect(row!.lead_org_id).toBe(ORG_A);

    const l = await lead(row!.lead_id);
    expect(l.org_id).toBe(ORG_A);
    expect(l.property_id, "the property is the one the proposal holds under that reference").toBe(propertyId);
    expect(l.source, "the website's lead_source; the proposal is the channel, in criteria").toBe("website");
    expect(l.status).toBe("new");
    expect(l.channel).toBe("email");
    expect(l.contact_id, "a forwarded link proves nothing: the recipient is NOT attributed").toBeNull();
    expect(l.assigned_agent_id, "the proposal's author owns the enquiry").toBe(agentA.id);
    expect(l.idempotency_key).toBe(`int-${run}-${reference}`);
    const criteria = l.criteria as Record<string, unknown>;
    expect(criteria.channel).toBe("proposal_interest");
    expect(criteria.listing_reference).toBe(reference);
    expect(criteria.share_link_id).toBe(linkId);
    expect(JSON.stringify(l), "the token digest is stored nowhere on the lead").not.toContain(sha(liveToken));
  });

  it("writes the message in the block the desk e-mail is rebuilt from, so the alert worker needs nothing new", async () => {
    const [row] = await interest(liveToken, reference);
    const l = await lead(row!.lead_id);
    const message = String(l.message);
    expect(message.startsWith("Website enquiry\n")).toBe(true);
    expect(message).toContain(`About: ${reference}\n`);
    expect(message).toContain(`Selection ${run}`); // the proposal's title, in the visitor-facing part
    const alert = alertFromLead({ message, criteria: l.criteria });
    expect(alert, "the worker can rebuild the desk e-mail").not.toBeNull();
    expect(alert!.propertyReference).toBe(reference);
    expect(alert!.email).toBe(`buyer-${run}@example.invalid`);
  });

  it("writes the durable desk-alert row with the lead, in the same transaction", async () => {
    const [row] = await interest(liveToken, reference);
    const { data: job } = await svc.from("notification_jobs").select("*").eq("lead_id", row!.lead_id).single();
    expect(job).not.toBeNull();
    expect(job!.kind).toBe("enquiry_desk_alert");
    expect(["pending", "sending", "accepted", "failed"]).toContain(job!.state);
  });

  it("records the events with ids and words only — no name, e-mail, phone or token", async () => {
    const [row] = await interest(liveToken, reference);
    const leadEvents = await eventsFor("lead", row!.lead_id);
    const created = leadEvents.find((e) => e.event_type === "created");
    expect(created).toBeDefined();
    expect(created!.actor_id, "no user did this").toBeNull();
    expect(created!.payload).toMatchObject({
      source: "website",
      channel: "proposal_interest",
      listing_reference: reference,
      share_link_id: linkId,
      matched_listing: true,
      has_email: true,
      has_phone: false,
    });
    const assigned = leadEvents.find((e) => e.event_type === "assigned");
    expect(assigned?.payload).toMatchObject({ to: agentA.id, via: "proposal_owner" });
    const linkEvents = await eventsFor("share_link", linkId);
    const interestEvent = linkEvents.find((e) => e.event_type === "interest");
    expect(interestEvent?.payload).toMatchObject({ listing_reference: reference, lead_id: row!.lead_id });
    const everything = JSON.stringify([...leadEvents, ...linkEvents]);
    expect(everything).not.toContain(`buyer-${run}@`);
    expect(everything).not.toContain(`Buyer ${run}`);
    expect(everything).not.toContain(sha(liveToken));
  });

  it("a proposal whose author is no longer active leaves the lead unassigned for the desk", async () => {
    // the contact-less link was made by adminA; deactivate them briefly
    await svc.from("profiles").update({ is_active: false }).eq("id", adminA.id);
    try {
      const [row] = await interest(contactLessToken, reference, { p_idempotency_key: `int-${run}-inactive` });
      expect((await lead(row!.lead_id)).assigned_agent_id).toBeNull();
    } finally {
      await svc.from("profiles").update({ is_active: true }).eq("id", adminA.id);
    }
  });
});

describe("submit_proposal_interest — idempotency", () => {
  it("the same key again is the same lead, replayed, with one desk-alert row", async () => {
    const key = `int-${run}-replay`;
    const [first] = await interest(liveToken, reference, { p_idempotency_key: key });
    const [second] = await interest(liveToken, reference, { p_idempotency_key: key, p_message: "typed again" });
    expect(second!.lead_id).toBe(first!.lead_id);
    expect(first!.replayed).toBe(false);
    expect(second!.replayed).toBe(true);
    const { count } = await svc.from("notification_jobs").select("id", { count: "exact", head: true }).eq("lead_id", first!.lead_id);
    expect(count).toBe(1);
    const { count: leads } = await svc.from("leads").select("id", { count: "exact", head: true }).eq("org_id", ORG_A).eq("idempotency_key", key);
    expect(leads).toBe(1);
  });

  it("two concurrent posts with one key make one lead", async () => {
    const key = `int-${run}-race`;
    const [a, b] = await Promise.all([interest(liveToken, reference, { p_idempotency_key: key }), interest(liveToken, reference, { p_idempotency_key: key })]);
    expect(a[0]!.lead_id).toBe(b[0]!.lead_id);
    expect([a[0]!.replayed, b[0]!.replayed].filter(Boolean)).toHaveLength(1);
  });
});

describe("submit_proposal_interest — refusals are all the same: no rows", () => {
  it("an unknown, an expired and a revoked token", async () => {
    expect(await interest(mint(), reference)).toHaveLength(0);
    expect(await interest(expiredToken, reference, { p_idempotency_key: `int-${run}-exp` })).toHaveLength(0);
    expect(await interest(revokedToken, reference, { p_idempotency_key: `int-${run}-rev` })).toHaveLength(0);
  });

  it("a reference the proposal does not hold — even one in the same org — and an archived one it does", async () => {
    expect(await interest(liveToken, outsideReference, { p_idempotency_key: `int-${run}-out` })).toHaveLength(0);
    expect(await interest(liveToken, archivedReference, { p_idempotency_key: `int-${run}-arch` })).toHaveLength(0);
  });

  it("another org's link cannot reach this org's listing: the org is the link's, never the caller's", async () => {
    expect(await interest(bToken, reference, { p_idempotency_key: `int-${run}-orgb` })).toHaveLength(0);
  });

  it("no name, or no way to reply, is refused before anything is written", async () => {
    expect(await interest(liveToken, reference, { p_name: "  ", p_idempotency_key: `int-${run}-noname` })).toHaveLength(0);
    expect(await interest(liveToken, reference, { p_email: "", p_phone: "", p_idempotency_key: `int-${run}-noreply` })).toHaveLength(0);
    expect(await interest(liveToken, reference, { p_idempotency_key: "bad key!" })).toHaveLength(0);
  });

  it("a refused submission leaves no lead, no job and no event behind", async () => {
    const before = await eventsFor("share_link", linkId);
    await interest(liveToken, outsideReference, { p_idempotency_key: `int-${run}-clean` });
    const { count } = await svc.from("leads").select("id", { count: "exact", head: true }).eq("org_id", ORG_A).eq("idempotency_key", `int-${run}-clean`);
    expect(count).toBe(0);
    expect(await eventsFor("share_link", linkId)).toHaveLength(before.length);
  });
});

describe("submit_proposal_interest — who may call it", () => {
  it("service_role only: anon and a signed-in agent are refused by the grant", async () => {
    const args = {
      p_token_sha256: sha(liveToken),
      p_property_ref: reference,
      p_name: "x",
      p_email: "x@example.invalid",
      p_phone: "",
      p_message: "",
      p_idempotency_key: `int-${run}-anon`,
    };
    const a = await anonClient().rpc("submit_proposal_interest", args);
    expect(a.error?.code).toBe("42501");
    const b = await agentA.client.rpc("submit_proposal_interest", args);
    expect(b.error?.code).toBe("42501");
  });
});
