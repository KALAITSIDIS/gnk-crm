import { describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * `linkLeadContact`, hardened (T-enquiry-contact-suggestions).
 *
 * It used to be "link (or replace)": an unconditional UPDATE, so a screen
 * drawn before a colleague linked someone else could overwrite their work, an
 * archived or erased contact was accepted, and a second click wrote a second
 * `contact_linked`. These tests pin the action's half — the checks before the
 * write, which branch of the write's answer it takes, and that an event is
 * written for a write that happened and for nothing else. The database's half
 * (the conditional UPDATE racing real sessions under RLS) is proven in
 * supabase/tests/enquiry-contact-suggestions.test.ts.
 */

const state = vi.hoisted(() => ({
  client: null as unknown,
  profile: { id: "actor-1", orgId: "org-1", role: "admin" as string },
  /** getCurrentProfile's throw: a deactivated account, a missing profile */
  profileError: null as Error | null,
}));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => {
    if (state.profileError) throw state.profileError;
    return state.profile;
  },
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath }));

const { createContactFromEnquiry, linkLeadContact, redactLead } = await import("@/lib/actions/leads");

const LEAD = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const HEADER = "Website enquiry\nName: Maria Georgiou\nEmail: maria@example.invalid\nPhone: 0035799123456\n\nHello";

const lead = (over: Record<string, unknown> = {}) => ({
  id: LEAD,
  status: "new",
  contact_id: null,
  assigned_agent_id: null,
  message: HEADER,
  ...over,
});

const contact = (over: Record<string, unknown> = {}) => ({
  id: CONTACT,
  is_archived: false,
  erased_at: null,
  email: "maria@example.invalid",
  phone_e164: "+35799123456",
  additional_phones: [],
  ...over,
});

function setup(leads: FakePage[], contacts: FakePage[] = [], role = "admin", actor = "actor-1") {
  const fake = fakeClient({ leads, contacts });
  state.client = fake.client;
  state.profile = { id: actor, orgId: "org-1", role };
  state.profileError = null;
  logEvent.mockClear();
  revalidatePath.mockClear();
  return fake;
}

const updates = (fake: ReturnType<typeof fakeClient>) => fake.argsOf("leads", "update");

describe("linkLeadContact — refused before any write", () => {
  it("refuses a malformed id without a query", async () => {
    const fake = setup([]);
    expect(await linkLeadContact("nope", CONTACT)).toEqual({ error: "Invalid lead." });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a listing manager — leads_update never lets one write", async () => {
    const fake = setup([{ data: lead(), error: null }], [], "listing_manager");
    const r = await linkLeadContact(LEAD, CONTACT);
    expect(r.error).toMatch(/only an admin or an agent/i);
    expect(updates(fake)).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("answers an already-linked SAME contact as success — no write, no second event, and a redrawn row", async () => {
    const fake = setup([{ data: lead({ contact_id: CONTACT }), error: null }]);
    expect(await linkLeadContact(LEAD, CONTACT)).toEqual({ error: null, alreadyLinked: true });
    expect(updates(fake)).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
    // the page that offered the link still shows the lead unlinked
    expect(revalidatePath).toHaveBeenCalledWith("/leads");
  });

  it("answers a session it cannot verify with a sentence, not a throw — and touches nothing", async () => {
    const fake = setup([]);
    state.profileError = new Error("Account deactivated");
    const r = await linkLeadContact(LEAD, CONTACT);
    expect(r.error).toMatch(/session could not be verified/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("writes only the one known `via` into the event — the browser sends the whole argument", async () => {
    setup([{ data: lead(), error: null }, { data: [{ id: LEAD }], error: null }], [{ data: contact(), error: null }]);
    await linkLeadContact(LEAD, CONTACT, { via: "maria@example.invalid +35799123456" } as never);
    expect(logEvent.mock.calls[0]![1].payload).toEqual({ contact_id: CONTACT, via: null, matched_on: null });

    setup([{ data: lead(), error: null }, { data: [{ id: LEAD }], error: null }], [{ data: contact(), error: null }]);
    expect((await linkLeadContact(LEAD, CONTACT, null)).error, "a null options argument does not throw").toBeNull();
  });

  it("never replaces a link to ANOTHER contact", async () => {
    const fake = setup([{ data: lead({ contact_id: OTHER }), error: null }]);
    const r = await linkLeadContact(LEAD, CONTACT);
    expect(r.error).toMatch(/already linked to another contact/i);
    expect(updates(fake)).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["converted", /already converted/i],
    ["lost", /only an open lead/i],
    ["spam", /only an open lead/i],
  ])("refuses a %s lead", async (status, message) => {
    const fake = setup([{ data: lead({ status }), error: null }]);
    expect((await linkLeadContact(LEAD, CONTACT)).error).toMatch(message);
    expect(updates(fake)).toEqual([]);
  });

  it("refuses an agent on another agent's lead, and lets one work an unassigned or own lead", async () => {
    let fake = setup([{ data: lead({ assigned_agent_id: "someone-else" }), error: null }], [], "agent", "agent-1");
    expect((await linkLeadContact(LEAD, CONTACT)).error).toMatch(/assigned to another agent/i);
    expect(updates(fake)).toEqual([]);

    fake = setup(
      [{ data: lead({ assigned_agent_id: "agent-1" }), error: null }, { data: [{ id: LEAD }], error: null }],
      [{ data: contact(), error: null }],
      "agent",
      "agent-1",
    );
    expect(await linkLeadContact(LEAD, CONTACT)).toEqual({ error: null, alreadyLinked: false, warning: null });
    expect(updates(fake)).toHaveLength(1);
  });

  it.each([
    ["an unknown contact (or another organisation's — RLS hides it)", null, /contact not found/i],
    ["an erased contact", contact({ erased_at: "2026-09-01T00:00:00Z", is_archived: true }), /was erased/i],
    ["an archived contact", contact({ is_archived: true }), /archived — restore it/i],
  ])("refuses %s", async (_label, row, message) => {
    const fake = setup([{ data: lead(), error: null }], [{ data: row, error: null }]);
    expect((await linkLeadContact(LEAD, CONTACT)).error).toMatch(message);
    expect(updates(fake)).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("refuses a redacted enquiry — an anonymised enquiry is not re-attached to a named person", async () => {
    const fake = setup([{ data: lead({ message: "[erased at the contact's request]" }), error: null }]);
    expect((await linkLeadContact(LEAD, CONTACT)).error).toMatch(/was redacted/i);
    expect(updates(fake)).toEqual([]);
  });

  it("refuses Review and link when the contact no longer shares the e-mail or phone — no stale evidence is confirmed", async () => {
    const fake = setup(
      [{ data: lead(), error: null }],
      [{ data: contact({ email: "changed@example.invalid", phone_e164: "+35799000000" }), error: null }],
    );
    const r = await linkLeadContact(LEAD, CONTACT, { via: "suggestion" });
    expect(r.error).toMatch(/no longer shares the enquiry's e-mail or phone/i);
    expect(updates(fake)).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("says a failed read is a failure, not a missing row", async () => {
    setup([{ data: null, error: { message: "boom", code: "XX000" } }]);
    expect((await linkLeadContact(LEAD, CONTACT)).error).toMatch(/could not load the lead/i);
  });
});

describe("linkLeadContact — the conditional write", () => {
  it("writes contact_id ONLY, and only while the lead is unlinked and open", async () => {
    const fake = setup([{ data: lead(), error: null }, { data: [{ id: LEAD }], error: null }], [{ data: contact(), error: null }]);
    await linkLeadContact(LEAD, CONTACT);
    expect(updates(fake)).toEqual([[{ contact_id: CONTACT }]]);
    expect(fake.argsOf("leads", "is")).toContainEqual(["contact_id", null]);
    expect(fake.argsOf("leads", "in")).toContainEqual(["status", ["new", "contacted", "qualified"]]);
    // and never onto an enquiry redacted meanwhile (null messages still qualify)
    expect(fake.argsOf("leads", "or")).toContainEqual([`message.is.null,message.neq."[erased at the contact's request]"`]);
  });

  it("writes exactly one event for the link it made — ids and shape only", async () => {
    setup([{ data: lead(), error: null }, { data: [{ id: LEAD }], error: null }], [{ data: contact(), error: null }]);
    expect(await linkLeadContact(LEAD, CONTACT)).toEqual({ error: null, alreadyLinked: false, warning: null });
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]![1]).toMatchObject({
      entityType: "lead",
      entityId: LEAD,
      eventType: "contact_linked",
      payload: { contact_id: CONTACT, via: null, matched_on: null },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/leads");
  });

  it("never reports a link that happened as a failure — a lost event becomes a warning", async () => {
    setup([{ data: lead(), error: null }, { data: [{ id: LEAD }], error: null }], [{ data: contact(), error: null }]);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    logEvent.mockRejectedValueOnce(new Error('events insert failed for "22222222-…"'));
    const r = await linkLeadContact(LEAD, CONTACT);
    expect(r).toEqual({ error: null, alreadyLinked: false, warning: expect.stringMatching(/timeline entry could not be written/i) });
    expect(JSON.stringify(log.mock.calls)).not.toContain("2222");
    log.mockRestore();
  });

  it("records where a suggestion link came from and what matched — recomputed on the server", async () => {
    setup([{ data: lead(), error: null }, { data: [{ id: LEAD }], error: null }], [{ data: contact(), error: null }]);
    await linkLeadContact(LEAD, CONTACT, { via: "suggestion" });
    const payload = logEvent.mock.calls[0]![1].payload as Record<string, unknown>;
    expect(payload).toEqual({ contact_id: CONTACT, via: "suggestion", matched_on: "email_and_phone" });
    // no identifier by value: the chain is immutable and erasure cannot reach it
    expect(JSON.stringify(payload)).not.toMatch(/maria|example\.invalid|99123456/i);
  });

  it("records a phone-only match through another number as phone", async () => {
    setup(
      [{ data: lead(), error: null }, { data: [{ id: LEAD }], error: null }],
      [{ data: contact({ email: null, phone_e164: "+35799000000", additional_phones: ["+35799123456"] }), error: null }],
    );
    await linkLeadContact(LEAD, CONTACT, { via: "suggestion" });
    expect(logEvent.mock.calls[0]![1].payload).toEqual({ contact_id: CONTACT, via: "suggestion", matched_on: "phone" });
  });

  it("a lost race to the SAME contact (a double click, a colleague) is success with no event", async () => {
    setup(
      [
        { data: lead(), error: null },
        { data: [], error: null }, // the UPDATE: zero rows
        { data: { contact_id: CONTACT, status: "new" }, error: null }, // the re-read
      ],
      [{ data: contact(), error: null }],
    );
    expect(await linkLeadContact(LEAD, CONTACT, { via: "suggestion" })).toEqual({ error: null, alreadyLinked: true });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["linked to another contact meanwhile", { contact_id: OTHER, status: "new" }, /another contact meanwhile/i],
    ["converted meanwhile", { contact_id: null, status: "converted" }, /converted or closed meanwhile/i],
    ["closed meanwhile", { contact_id: null, status: "spam" }, /converted or closed meanwhile/i],
    ["redacted meanwhile", { contact_id: null, status: "new", message: "[erased at the contact's request]" }, /redacted meanwhile/i],
    ["refused by the row policy", { contact_id: null, status: "new", message: HEADER }, /refused/i],
  ])("refuses when the write was %s — and writes no event", async (_label, reread, message) => {
    setup(
      [{ data: lead(), error: null }, { data: [], error: null }, { data: reread, error: null }],
      [{ data: contact(), error: null }],
    );
    const r = await linkLeadContact(LEAD, CONTACT);
    expect(r.error).toMatch(message);
    expect(r.alreadyLinked).toBeUndefined();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("reports a failed write as a failure with no event and no database words", async () => {
    setup(
      [{ data: lead(), error: null }, { data: null, error: { message: 'violates foreign key "leads_contact_id_fkey"', code: "23503" } }],
      [{ data: contact(), error: null }],
    );
    const r = await linkLeadContact(LEAD, CONTACT);
    expect(r.error).toBe("Could not link the contact — try again.");
    expect(logEvent).not.toHaveBeenCalled();
  });
});

describe("createContactFromEnquiry — around the suggestions", () => {
  const websiteLead = (over: Record<string, unknown> = {}) => ({
    ...lead(),
    org_id: "org-1",
    source: "website",
    criteria: {},
    received_at: "2026-09-20T09:00:00Z",
    ...over,
  });

  it("refuses a listing manager BEFORE inserting — the link would fail and leave an orphan contact", async () => {
    const fake = setup([{ data: websiteLead(), error: null }], [], "listing_manager");
    const r = await createContactFromEnquiry(LEAD);
    expect(r.error).toMatch(/only an admin or an agent/i);
    expect(fake.argsOf("contacts", "insert")).toEqual([]);
    expect(fake.served.contacts ?? 0, "not even the duplicate check runs").toBe(0);
  });

  it("names an ERASED holder for what it is and does not send the desk back to the panel", async () => {
    const fake = setup(
      [{ data: websiteLead(), error: null }],
      // the phone check finds an erased contact someone unarchived
      [{ data: [{ id: OTHER, display_name: "Gone", erased_at: "2026-09-01T00:00:00Z" }], error: null }],
    );
    const r = await createContactFromEnquiry(LEAD);
    expect(r.error).toMatch(/an erased contact still holds this phone/i);
    expect(r.duplicate, "no link is offered to an erased record").toBeNull();
    expect(fake.argsOf("contacts", "insert")).toEqual([]);
  });

  it("still returns an ordinary duplicate as one", async () => {
    setup(
      [{ data: websiteLead(), error: null }],
      [{ data: [{ id: OTHER, display_name: "Maria", erased_at: null }], error: null }],
    );
    const r = await createContactFromEnquiry(LEAD);
    expect(r.duplicate).toEqual({ id: OTHER, display_name: "Maria", matched_on: "phone", erased: false });
  });
});

describe("redactLead — the other order of the same race", () => {
  it("does not redact a lead a colleague linked between its read and its write", async () => {
    const fake = setup([
      { data: lead({ org_id: "org-1" }), error: null }, // getLead: unlinked
      { data: [], error: null }, // the conditional UPDATE: zero rows
      { data: { contact_id: CONTACT, message: HEADER }, error: null }, // the re-read: linked meanwhile
    ]);
    await expect(redactLead(LEAD)).rejects.toThrow(/linked to a contact meanwhile/i);
    expect(fake.argsOf("leads", "is")).toContainEqual(["contact_id", null]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("redacts an unlinked lead and writes its event", async () => {
    setup([{ data: lead({ org_id: "org-1" }), error: null }, { data: [{ id: LEAD }], error: null }]);
    await redactLead(LEAD);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]![1]).toMatchObject({ eventType: "redacted", payload: {} });
  });
});
