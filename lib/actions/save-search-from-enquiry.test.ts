import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * `saveSearchFromEnquiry` (A04): a website buyer's brief, on a lead whose
 * contact already existed, saved as that contact's search — through the same
 * helper `createContactFromEnquiry` uses. Every refusal is a sentence with
 * NOTHING written (no insert, no event); the happy path writes one search and
 * one `requirement_added` line on the contact. The create path still seeds
 * through the helper (its regression is at the end).
 */

const state = vi.hoisted(() => ({
  client: null as unknown,
  profile: { id: "actor-1", orgId: "org-1", role: "agent" as string },
  profileError: null as Error | null,
}));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeClient({}).client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => {
    if (state.profileError) throw state.profileError;
    return state.profile;
  },
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath }));

const { createContactFromEnquiry, saveSearchFromEnquiry } = await import("@/lib/actions/leads");
const { LEAD_MESSAGE_REDACTED } = await import("@/lib/services/erasure");

const LEAD = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const REQ = "33333333-3333-4333-8333-333333333333";
const BRIEF = { looking_to: "buy", budget: "300_500k", buy_property_type: "villa" };

const lead = (over: Record<string, unknown> = {}): FakePage => ({
  data: { id: LEAD, source: "website", contact_id: CONTACT, message: "Website enquiry\nName: A\n", criteria: BRIEF, ...over },
  error: null,
});
const contact = (over: Record<string, unknown> = {}): FakePage => ({
  data: { id: CONTACT, is_archived: false, erased_at: null, ...over },
  error: null,
});
const noSearch: FakePage = { data: [], error: null };
const areas: FakePage = { data: [], error: null };
const inserted: FakePage = { data: { id: REQ }, error: null, status: 201 };

function setup(pages: Record<string, FakePage[]>, role = "agent") {
  const fake = fakeClient(pages);
  state.client = fake.client;
  state.profile = { id: "actor-1", orgId: "org-1", role };
  state.profileError = null;
  logEvent.mockClear();
  revalidatePath.mockClear();
  return fake;
}

const inserts = (fake: ReturnType<typeof fakeClient>) => fake.argsOf("buyer_requirements", "insert");

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("saveSearchFromEnquiry — refused, nothing written", () => {
  const refusals: [string, Record<string, FakePage[]>, RegExp, string?][] = [
    ["a lead that is not a website enquiry", { leads: [lead({ source: "phone" })] }, /only a website enquiry/i],
    ["a lead with no contact", { leads: [lead({ contact_id: null })] }, /link or create the contact first/i],
    ["a redacted enquiry", { leads: [lead({ message: LEAD_MESSAGE_REDACTED })] }, /redacted/i],
    ["a brief with no buyer answers", { leads: [lead({ criteria: { district: "Paphos", property_type: "villa" } })] }, /no buyer's brief/i],
    ["a brief that is not an object", { leads: [lead({ criteria: null })] }, /no buyer's brief/i],
    ["an archived contact", { leads: [lead()], contacts: [contact({ is_archived: true })] }, /archived/i],
    ["an erased contact", { leads: [lead()], contacts: [contact({ is_archived: true, erased_at: "2026-10-01T00:00:00Z" })] }, /erased/i],
    ["a contact the caller cannot see", { leads: [lead()], contacts: [{ data: null, error: null }] }, /contact not found/i],
    ["a contact read that failed", { leads: [lead()], contacts: [{ data: null, error: { message: "timeout" } }] }, /could not load the contact/i],
    [
      "a contact that already has an active search",
      { leads: [lead()], contacts: [contact()], buyer_requirements: [{ data: [{ id: REQ }], error: null }] },
      /already has a saved search/i,
    ],
    [
      "a search check that failed — never read as 'none'",
      { leads: [lead()], contacts: [contact()], buyer_requirements: [{ data: null, error: { message: "boom" } }] },
      /could not check/i,
    ],
    [
      "a search check with no rows array — never read as 'none'",
      { leads: [lead()], contacts: [contact()], buyer_requirements: [{ data: null, error: null }] },
      /could not check/i,
    ],
    ["a lead the caller cannot see", { leads: [{ data: null, error: null }] }, /lead not found/i],
    ["a lead read that failed", { leads: [{ data: null, error: { message: "timeout" } }] }, /could not load the lead/i],
  ];

  for (const [name, pages, message] of refusals) {
    it(name, async () => {
      const fake = setup(pages);
      const r = await saveSearchFromEnquiry(LEAD);
      expect(r.error).toMatch(message);
      expect(r.savedAt).toBeNull();
      expect(inserts(fake), "no search written").toEqual([]);
      expect(logEvent, "no event written").not.toHaveBeenCalled();
    });
  }

  it("a role that may not record saved searches", async () => {
    const fake = setup({ leads: [lead()], contacts: [contact()] }, "owner");
    expect((await saveSearchFromEnquiry(LEAD)).error).toMatch(/your role cannot/i);
    expect(inserts(fake)).toEqual([]);
  });

  it("a session it cannot verify answers a sentence and reads nothing", async () => {
    const fake = setup({});
    state.profileError = new Error("Account deactivated");
    expect((await saveSearchFromEnquiry(LEAD)).error).toMatch(/session could not be verified/i);
    expect(fake.calls).toEqual([]);
  });

  it("checks for an ACTIVE search of THIS contact", async () => {
    const fake = setup({ leads: [lead()], contacts: [contact()], buyer_requirements: [{ data: [{ id: REQ }], error: null }] });
    await saveSearchFromEnquiry(LEAD);
    expect(fake.argsOf("buyer_requirements", "eq")).toEqual([
      ["contact_id", CONTACT],
      ["is_active", true],
    ]);
  });
});

describe("saveSearchFromEnquiry — saved", () => {
  it("any staff role — a listing manager too (the 0043 policies are org-wide) — on an open or closed lead", async () => {
    for (const role of ["agent", "listing_manager", "admin"]) {
      const fake = setup({ leads: [lead({ status: "lost" })], contacts: [contact()], buyer_requirements: [noSearch, inserted], areas: [areas] }, role);
      const r = await saveSearchFromEnquiry(LEAD);
      expect(r.error, role).toBeNull();
      expect(r.savedAt).toEqual(expect.any(Number));
      expect(inserts(fake)).toHaveLength(1);
    }
  });

  it("writes one search for the lead's contact and one requirement_added line naming the lead", async () => {
    const fake = setup({ leads: [lead()], contacts: [contact()], buyer_requirements: [noSearch, inserted], areas: [areas] });
    const r = await saveSearchFromEnquiry(LEAD);
    expect(r).toEqual({ error: null, savedAt: expect.any(Number), note: null });
    expect(inserts(fake)[0]![0]).toMatchObject({ contact_id: CONTACT, org_id: "org-1", property_types: ["villa"], budget_max: 500000 });
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]![1]).toMatchObject({
      entityType: "contact",
      entityId: CONTACT,
      eventType: "requirement_added",
      payload: { requirement_id: REQ, via: "website_enquiry", lead_id: LEAD },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/leads");
    expect(revalidatePath).toHaveBeenCalledWith(`/contacts/${CONTACT}`);
  });

  it("does not write the lead — saving a brief is not working the lead", async () => {
    const fake = setup({ leads: [lead()], contacts: [contact()], buyer_requirements: [noSearch, inserted], areas: [areas] });
    await saveSearchFromEnquiry(LEAD);
    expect(fake.argsOf("leads", "update")).toEqual([]);
  });

  it("a search whose insert outcome is unknown is not reported as saved, nor as 'nothing saved'", async () => {
    setup({
      leads: [lead()],
      contacts: [contact()],
      buyer_requirements: [noSearch, { data: null, error: { message: "fetch failed" } }],
      areas: [areas],
    });
    const r = await saveSearchFromEnquiry(LEAD);
    expect(r.savedAt).toBeNull();
    expect(r.error).toMatch(/could not be confirmed — it may have been saved/i);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a search certainly refused says nothing was saved", async () => {
    setup({
      leads: [lead()],
      contacts: [contact()],
      buyer_requirements: [noSearch, { data: null, error: { message: "denied", code: "42501" } }],
      areas: [areas],
    });
    expect((await saveSearchFromEnquiry(LEAD)).error).toMatch(/nothing was saved/i);
  });
});

describe("createContactFromEnquiry still seeds through the shared helper (regression)", () => {
  it("a new website buyer: contact, link, then the search with requirement_added naming the lead", async () => {
    const HEADER = "Website enquiry\nName: Maria Georgiou\nEmail: maria@example.invalid\nPhone: 0035799123456\n\nHello";
    const fake = setup(
      {
        leads: [
          { data: { id: LEAD, status: "new", source: "website", contact_id: null, assigned_agent_id: null, message: HEADER, criteria: BRIEF, received_at: "2026-10-18T08:00:00Z" }, error: null },
          { data: [{ id: LEAD }], error: null },
        ],
        // the dedup reads find nobody; then the insert answers the new id
        contacts: [{ data: [], error: null }, { data: [], error: null }, { data: { id: CONTACT }, error: null, status: 201 }],
        areas: [areas],
        buyer_requirements: [inserted],
      },
      "admin",
    );
    const r = await createContactFromEnquiry(LEAD);
    expect(r.error).toBeNull();
    expect(r.note).toBeNull();
    expect(inserts(fake)).toHaveLength(1);
    const types = logEvent.mock.calls.map((c) => c[1].eventType);
    expect(types).toEqual(["created", "contact_linked", "requirement_added"]);
    expect(logEvent.mock.calls[2]![1].payload).toEqual({
      requirement_id: REQ,
      label: "From website enquiry",
      via: "website_enquiry",
      lead_id: LEAD,
    });
  });
});
