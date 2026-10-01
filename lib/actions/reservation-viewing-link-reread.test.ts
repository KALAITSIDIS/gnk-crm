import { describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * `createReservation` and `createViewing` re-read the form's links under RLS
 * before they write (0129, T-deal-child-org-isolation).
 *
 * Neither form sends an id the user cannot see — the reservation form offers
 * the caller's own contacts and sends no deal or offer; the viewing dialog
 * sends the deal page's own deal — so only a crafted post does. Since 0126 /
 * 0129 the composite keys refuse another organisation's id (23503,
 * supabase/tests/deal-child-org-isolation.test.ts); until these re-reads the
 * user then saw the driver's message. A row RLS hides inside the caller's
 * own organisation is not the keys' business at all, and was accepted.
 *
 * The re-read is the MESSAGE, not the boundary — but it must not write.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
const logEvent = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "agent" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createReservation } = await import("@/lib/actions/reservations");
const { createViewing } = await import("@/lib/actions/viewings");

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const DEAL = "33333333-3333-4333-8333-333333333333";
const OFFER = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";

const seen = (id: string): FakePage => ({ data: { id }, error: null });
const unseen: FakePage = { data: null, error: null };

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const holdForm = (links: Record<string, string> = {}) =>
  form({ property_id: PROPERTY, expires_on: "2099-12-31", ...links });

function setupHold(pages: Record<string, FakePage[]>) {
  const fake = fakeClient({
    properties: [{ data: { id: PROPERTY, reference: "PAF0001", kind: "unit" }, error: null }],
    reservations: [{ data: { id: "hold-1" }, error: null }],
    ...pages,
  });
  state.client = fake.client;
  logEvent.mockClear();
  return fake;
}

describe("createReservation re-reads the form's contact, deal and offer", () => {
  for (const [field, table, id, what, a] of [
    ["contact_id", "contacts", CONTACT, "contact", "a"],
    ["deal_id", "deals", DEAL, "deal", "a"],
    ["offer_id", "offers", OFFER, "offer", "an"],
  ] as const) {
    it(`refuses ${a} ${what} the user cannot see, with a sentence, and writes nothing`, async () => {
      const fake = setupHold({ [table]: [unseen] });
      const res = await createReservation({ error: null, savedAt: null }, holdForm({ [field]: id }));
      expect(res.error).toBe(`That ${what} is no longer available to you.`);
      expect(fake.argsOf(table, "eq"), "read by the posted id").toEqual([["id", id]]);
      expect(fake.argsOf("reservations", "insert"), "no hold written").toHaveLength(0);
      expect(logEvent).not.toHaveBeenCalled();
    });
  }

  it("writes the hold with every link it could see", async () => {
    const fake = setupHold({ contacts: [seen(CONTACT)], deals: [seen(DEAL)], offers: [seen(OFFER)] });
    const res = await createReservation(
      { error: null, savedAt: null },
      holdForm({ contact_id: CONTACT, deal_id: DEAL, offer_id: OFFER }),
    );
    expect(res.error).toBeNull();
    expect(fake.argsOf("reservations", "insert")[0][0]).toMatchObject({
      org_id: "org-1",
      contact_id: CONTACT,
      deal_id: DEAL,
      offer_id: OFFER,
    });
  });

  it("reads nothing more for a hold with no links (the form's usual post)", async () => {
    const fake = setupHold({});
    const res = await createReservation({ error: null, savedAt: null }, holdForm());
    expect(res.error).toBeNull();
    for (const table of ["contacts", "deals", "offers"]) expect(fake.served[table] ?? 0, table).toBe(0);
    expect(fake.argsOf("reservations", "insert")).toHaveLength(1);
  });
});

describe("createViewing re-reads the form's deal", () => {
  const viewingForm = (links: Record<string, string> = {}) =>
    form({
      property_id: PROPERTY,
      contact_id: CONTACT,
      agent_id: AGENT,
      scheduled_at: "2099-06-01T10:00",
      duration_min: "30",
      ...links,
    });
  const initial = { error: null, savedAt: null, viewingId: null };

  function setupViewing(pages: Record<string, FakePage[]>) {
    const fake = fakeClient({ viewings: [{ data: { id: "viewing-1" }, error: null }], ...pages });
    state.client = fake.client;
    logEvent.mockClear();
    return fake;
  }

  it("refuses a deal the user cannot see, with a sentence, and writes nothing", async () => {
    const fake = setupViewing({ deals: [unseen] });
    const res = await createViewing(initial, viewingForm({ deal_id: DEAL }));
    expect(res.error).toBe("That deal is no longer available to you.");
    expect(fake.argsOf("deals", "eq")).toEqual([["id", DEAL]]);
    expect(fake.argsOf("viewings", "insert")).toHaveLength(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("writes the viewing with a deal it could see", async () => {
    const fake = setupViewing({ deals: [seen(DEAL)] });
    const res = await createViewing(initial, viewingForm({ deal_id: DEAL }));
    expect(res.error).toBeNull();
    expect(fake.argsOf("viewings", "insert")[0][0]).toMatchObject({ org_id: "org-1", deal_id: DEAL });
  });

  it("reads no deal for a viewing without one", async () => {
    const fake = setupViewing({});
    const res = await createViewing(initial, viewingForm());
    expect(res.error).toBeNull();
    expect(fake.served.deals ?? 0).toBe(0);
    expect(fake.argsOf("viewings", "insert")[0][0]).toMatchObject({ deal_id: null });
  });
});
