import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * Every server action that links a contact a form posted re-reads it under
 * RLS before it writes (T-contact-links-org-isolation, release 1 of 2).
 *
 * Ten links onto `contacts` are still single-column: leads, deals (buyer,
 * seller), offers, share links, mandates and properties (owner, developer)
 * accept another organisation's contact id today, and migration 0139 binds
 * each to the row's organisation — from then on a crafted foreign id is
 * refused 23503 and the user would see the driver's message. These actions
 * wrote the form's id straight through; now each reads it first and answers a
 * sentence, writing nothing. `contacts_select` is organisation-wide for every
 * role, so the read refuses exactly what the key will refuse: never a
 * colleague's contact.
 *
 * Only a link the row does not already carry is read: an unchanged buyer, an
 * offer's default (the deal's own buyer) and an unchanged owner are the row's
 * own and are not read again — the tests below pin that too, because a read of
 * an unchanged link would be one more way to refuse a save nobody changed.
 *
 * createLead also re-reads the PROPERTY before anything is written (BACKLOG
 * "createLead creates the contact before the lead and never re-reads the
 * property"): a refused property used to fail the lead insert only after a
 * typed enquirer's contact had been created and its event chained.
 *
 * fakeClient answers an unscripted read with `{ data: [] }`, which a
 * `maybeSingle` caller would take as "found" — every refusal below scripts
 * `{ data: null }` explicitly and asserts the read was made by the posted id,
 * so a re-read that never happens is RED, not a vacuous pass.
 */

const state = vi.hoisted(() => ({
  client: null as unknown,
  role: "admin" as "admin" | "agent" | "listing_manager",
}));
const logEvent = vi.hoisted(() => vi.fn(async () => {}));
const generateReference = vi.hoisted(() => vi.fn(async () => "PAF0099"));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: state.role }),
}));
vi.mock("@/lib/services/events", () => ({
  logEvent,
  logEvents: vi.fn(async () => undefined),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));
vi.mock("@/lib/services/reference", () => ({ generateReference }));
vi.mock("@/lib/services/site-revalidate", () => ({ notifySiteAfter: vi.fn() }));
vi.mock("@/lib/actions/party-defaults", () => ({
  getPartyDefaults: vi.fn(async () => ({ defaults: {} })),
}));
vi.mock("@/lib/services/health-score", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recomputeDealsFor: vi.fn(async () => undefined),
  recomputeDealHealth: vi.fn(async () => undefined),
}));
vi.mock("@/lib/services/quality-score", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recomputeQualityScore: vi.fn(async () => undefined),
  recomputeQuietly: vi.fn(async () => undefined),
  refreshContainerScores: vi.fn(async () => undefined),
}));

const { createLead } = await import("@/lib/actions/leads");
const { updateDealSection, saveOffer } = await import("@/lib/actions/deals");
const { createShareLink, createAvailabilityLink } = await import("@/lib/actions/share-links");
const { saveMandate } = await import("@/lib/actions/mandates");
const { createProperty, updatePropertySection } = await import("@/lib/actions/properties");

const CONTACT = "c0c0c0c0-1111-4111-8111-111111111111";
const OTHER = "c0c0c0c0-2222-4222-8222-222222222222";
const PROPERTY = "a0a0a0a0-3333-4333-8333-333333333333";
const DEAL = "d0d0d0d0-4444-4444-8444-444444444444";
const OFFER = "e0e0e0e0-5555-4555-8555-555555555555";
const MANDATE = "f0f0f0f0-6666-4666-8666-666666666666";
const DISTRICT = "b0b0b0b0-7777-4777-8777-777777777777";
const T1 = "2026-10-03T08:00:00.000000+00:00";

const UNAVAILABLE = "That contact is no longer available to you.";
const seen = (id: string): FakePage => ({ data: { id }, error: null });
const unseen: FakePage = { data: null, error: null };
/** the write the action attempts after its reads — failed on purpose, so the test stops there */
const stop: FakePage = { data: null, error: { message: "stop here" } };

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function use(pages: Record<string, FakePage[]>) {
  const fake = fakeClient(pages);
  state.client = fake.client;
  return fake;
}

beforeEach(() => {
  state.role = "admin";
  logEvent.mockClear();
  generateReference.mockClear();
});

/* -------------------------------------------------------------- createLead */

describe("createLead re-reads its property and its picked contact before anything is written", () => {
  it("refuses a property the caller cannot see BEFORE creating the typed enquirer's contact", async () => {
    const fake = use({ properties: [unseen] });
    const res = await createLead(
      { error: null, savedAt: null },
      form({ source: "phone", property_id: PROPERTY, new_contact_name: "Zed Test" }),
    );
    expect(res.error).toBe("That property is no longer available to you.");
    expect(fake.argsOf("properties", "eq"), "read by the posted id").toEqual([["id", PROPERTY]]);
    expect(fake.argsOf("contacts", "insert"), "no orphan contact").toHaveLength(0);
    expect(fake.argsOf("leads", "insert"), "no lead attempted").toHaveLength(0);
    expect(logEvent, "nothing chained").not.toHaveBeenCalled();
  });

  it("refuses a picked contact the caller cannot see, and writes nothing", async () => {
    const fake = use({ contacts: [unseen] });
    const res = await createLead({ error: null, savedAt: null }, form({ source: "phone", contact_id: CONTACT }));
    expect(res.error).toBe(UNAVAILABLE);
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", CONTACT]]);
    expect(fake.argsOf("leads", "insert")).toHaveLength(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("writes the lead with both links when it can see them", async () => {
    const fake = use({ properties: [seen(PROPERTY)], contacts: [seen(CONTACT)], leads: [stop] });
    const res = await createLead(
      { error: null, savedAt: null },
      form({ source: "phone", contact_id: CONTACT, property_id: PROPERTY }),
    );
    expect(res.error).toBe("stop here");
    expect(fake.argsOf("leads", "insert")[0]?.[0]).toMatchObject({ contact_id: CONTACT, property_id: PROPERTY });
  });
});

/* ------------------------------------------------------- updateDealSection */

const dealRow = (parties: { buyer?: string | null; seller?: string | null } = {}) => ({
  data: {
    id: DEAL,
    title: "A deal",
    property_id: null,
    buyer_contact_id: parties.buyer ?? null,
    seller_contact_id: parties.seller ?? null,
    agent_id: null,
    expected_value: null,
  },
  error: null,
});

describe("updateDealSection (details) re-reads a buyer or seller the deal does not already carry", () => {
  for (const field of ["buyer_contact_id", "seller_contact_id"] as const) {
    it(`refuses a new ${field} the caller cannot see, and writes nothing`, async () => {
      const fake = use({ deals: [dealRow()], contacts: [unseen] });
      const res = await updateDealSection(
        { error: null, savedAt: null },
        form({ deal_id: DEAL, section: "details", title: "A deal", [field]: CONTACT }),
      );
      expect(res.error).toBe(UNAVAILABLE);
      expect(fake.argsOf("contacts", "eq")).toEqual([["id", CONTACT]]);
      expect(fake.argsOf("deals", "update"), "no deal update").toHaveLength(0);
      expect(logEvent).not.toHaveBeenCalled();
    });
  }

  it("does not read a buyer the deal already carries — a retitle with the same buyer saves", async () => {
    const fake = use({ deals: [dealRow({ buyer: CONTACT }), { data: { id: DEAL }, error: null }] });
    const res = await updateDealSection(
      { error: null, savedAt: null },
      form({ deal_id: DEAL, section: "details", title: "Retitled", buyer_contact_id: CONTACT }),
    );
    expect(res.error).toBeNull();
    expect(fake.argsOf("contacts", "eq"), "no read of an unchanged party").toEqual([]);
    expect(fake.argsOf("deals", "update")).toHaveLength(1);
  });

  it("writes a new buyer it can see", async () => {
    const fake = use({ deals: [dealRow({ buyer: OTHER }), stop], contacts: [seen(CONTACT)] });
    const res = await updateDealSection(
      { error: null, savedAt: null },
      form({ deal_id: DEAL, section: "details", title: "A deal", buyer_contact_id: CONTACT }),
    );
    expect(res.error).toBe("stop here");
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", CONTACT]]);
    expect(fake.argsOf("deals", "update")[0]?.[0]).toMatchObject({ buyer_contact_id: CONTACT });
  });
});

/* ---------------------------------------------------------------- saveOffer */

const offerDeal: FakePage = {
  data: { id: DEAL, org_id: "org-1", status: "open", property_id: null, buyer_contact_id: OTHER },
  error: null,
};
const openOffer = (contact: string | null): FakePage => ({
  data: { id: OFFER, deal_id: DEAL, status: "submitted", amount: 100000, terms: null, valid_until: null, contact_id: contact },
  error: null,
});

describe("saveOffer re-reads an offer contact that is not already the offer's (or the deal buyer's)", () => {
  it("a new offer: refuses a contact the caller cannot see, and writes nothing", async () => {
    const fake = use({ deals: [offerDeal], contacts: [unseen] });
    const res = await saveOffer(
      { error: null, savedAt: null },
      form({ deal_id: DEAL, amount: "100000", contact_id: CONTACT }),
    );
    expect(res.error).toBe(UNAVAILABLE);
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", CONTACT]]);
    expect(fake.argsOf("offers", "insert")).toHaveLength(0);
  });

  it("a new offer for the deal's own buyer is not read again", async () => {
    const fake = use({ deals: [offerDeal], offers: [stop] });
    const res = await saveOffer(
      { error: null, savedAt: null },
      form({ deal_id: DEAL, amount: "100000", contact_id: OTHER }),
    );
    expect(res.error).toBe("stop here");
    expect(fake.argsOf("contacts", "eq")).toEqual([]);
    expect(fake.argsOf("offers", "insert")[0]?.[0]).toMatchObject({ contact_id: OTHER });
  });

  it("an edit: refuses a new contact the caller cannot see, and writes nothing", async () => {
    const fake = use({ deals: [offerDeal], offers: [openOffer(null)], contacts: [unseen] });
    const res = await saveOffer(
      { error: null, savedAt: null },
      form({ offer_id: OFFER, deal_id: DEAL, amount: "100000", contact_id: CONTACT }),
    );
    expect(res.error).toBe(UNAVAILABLE);
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", CONTACT]]);
    expect(fake.argsOf("offers", "update")).toHaveLength(0);
  });

  it("an edit keeping the offer's contact is not read again", async () => {
    const fake = use({ deals: [offerDeal], offers: [openOffer(CONTACT), stop] });
    const res = await saveOffer(
      { error: null, savedAt: null },
      form({ offer_id: OFFER, deal_id: DEAL, amount: "120000", contact_id: CONTACT }),
    );
    expect(res.error).toBe("stop here");
    expect(fake.argsOf("contacts", "eq")).toEqual([]);
  });
});

/* -------------------------------------------------------------- share links */

describe("createShareLink and createAvailabilityLink re-read the link's contact", () => {
  it("a proposal: refuses a contact the caller cannot see, and mints nothing", async () => {
    const fake = use({ properties: [{ data: [{ id: PROPERTY }], error: null }], contacts: [unseen] });
    const res = await createShareLink({ property_ids: [PROPERTY], contact_id: CONTACT });
    expect(res).toEqual({ error: UNAVAILABLE, path: null, savedAt: null });
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", CONTACT]]);
    expect(fake.argsOf("share_links", "insert")).toHaveLength(0);
  });

  it("an availability link: refuses a contact the caller cannot see, and mints nothing", async () => {
    const fake = use({
      properties: [{ data: { id: PROPERTY, kind: "project", reference: "PAF0001" }, error: null }],
      contacts: [unseen],
    });
    const res = await createAvailabilityLink({ project_id: PROPERTY, contact_id: CONTACT });
    expect(res).toEqual({ error: UNAVAILABLE, path: null, savedAt: null });
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", CONTACT]]);
    expect(fake.argsOf("share_links", "insert")).toHaveLength(0);
  });

  it("a proposal for a contact it can see is minted with it", async () => {
    const fake = use({
      properties: [{ data: [{ id: PROPERTY }], error: null }],
      contacts: [seen(CONTACT)],
      share_links: [stop],
    });
    const res = await createShareLink({ property_ids: [PROPERTY], contact_id: CONTACT });
    expect(res.error).toBe("stop here");
    expect(fake.argsOf("share_links", "insert")[0]?.[0]).toMatchObject({ contact_id: CONTACT });
  });
});

/* --------------------------------------------------------------- saveMandate */

const mandateRow = (owner: string | null): FakePage => ({
  data: {
    id: MANDATE,
    property_id: PROPERTY,
    type: "exclusive",
    owner_contact_id: owner,
    commission_pct: 3,
    commission_notes: null,
    start_date: "2026-01-01",
    expiry_date: "2026-12-31",
    renewal_reminder_days: 30,
    notes: null,
  },
  error: null,
});
const mandateForm = (fields: Record<string, string>) =>
  form({ property_id: PROPERTY, type: "exclusive", renewal_reminder_days: "30", ...fields });

describe("saveMandate re-reads an owner the mandate does not already carry", () => {
  it("a new mandate: refuses an owner the caller cannot see, and writes nothing", async () => {
    const fake = use({ contacts: [unseen] });
    const res = await saveMandate({ error: null, savedAt: null }, mandateForm({ owner_contact_id: CONTACT }));
    expect(res.error).toBe(UNAVAILABLE);
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", CONTACT]]);
    expect(fake.argsOf("mandates", "insert")).toHaveLength(0);
  });

  it("an edit: refuses a new owner the caller cannot see, and writes nothing", async () => {
    const fake = use({ mandates: [mandateRow(null)], contacts: [unseen] });
    const res = await saveMandate(
      { error: null, savedAt: null },
      mandateForm({ mandate_id: MANDATE, owner_contact_id: CONTACT, start_date: "2026-01-01", expiry_date: "2026-12-31" }),
    );
    expect(res.error).toBe(UNAVAILABLE);
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", CONTACT]]);
    expect(fake.argsOf("mandates", "update")).toHaveLength(0);
  });

  it("an edit keeping the mandate's owner is not read again", async () => {
    const fake = use({ mandates: [mandateRow(CONTACT), stop] });
    const res = await saveMandate(
      { error: null, savedAt: null },
      mandateForm({
        mandate_id: MANDATE,
        owner_contact_id: CONTACT,
        commission_pct: "2.5",
        start_date: "2026-01-01",
        expiry_date: "2026-12-31",
      }),
    );
    expect(res.error).toBe("stop here");
    expect(fake.argsOf("contacts", "eq")).toEqual([]);
  });
});

/* ------------------------------------------------------------ createProperty */

const propertyForm = (fields: Record<string, string>) =>
  form({
    kind: "standalone",
    property_type: "apartment",
    transaction_type: "sale",
    district_id: DISTRICT,
    title_en: "Re-read flat",
    ...fields,
  });

describe("createProperty re-reads its owner or developer before it burns a reference", () => {
  it("refuses an owner the caller cannot see: no reference drawn, nothing written", async () => {
    const fake = use({ districts: [{ data: { code: "PAF" }, error: null }], contacts: [unseen] });
    const res = await createProperty({ error: null }, propertyForm({ source: "owner", owner_contact_id: CONTACT }));
    expect(res.error).toBe(UNAVAILABLE);
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", CONTACT]]);
    expect(generateReference, "no sequence number burned").not.toHaveBeenCalled();
    expect(fake.argsOf("properties", "insert")).toHaveLength(0);
  });

  it("writes an owner it can see", async () => {
    const fake = use({
      districts: [{ data: { code: "PAF" }, error: null }],
      contacts: [seen(CONTACT)],
      properties: [stop],
    });
    const res = await createProperty({ error: null }, propertyForm({ source: "owner", owner_contact_id: CONTACT }));
    expect(res.error).toBe("stop here");
    expect(fake.argsOf("properties", "insert")[0]?.[0]).toMatchObject({ owner_contact_id: CONTACT });
  });
});

/* ------------------------------------------------- updatePropertySection */

const propertyRow = (kind: string, parties: { owner?: string | null; developer?: string | null } = {}): FakePage => ({
  data: {
    id: PROPERTY,
    org_id: "org-1",
    reference: "PAF0007",
    kind,
    property_type: "apartment",
    parent_id: null,
    status: "available",
    visibility: "private",
    transaction_type: "sale",
    updated_at: T1,
    owner_contact_id: parties.owner ?? null,
    developer_contact_id: parties.developer ?? null,
    assigned_agent_id: null,
    inherited_fields: [],
  },
  error: null,
});

describe("updatePropertySection (parties) re-reads an owner or developer the property does not already carry", () => {
  it("refuses a new owner the caller cannot see, and writes nothing", async () => {
    const fake = use({ properties: [propertyRow("standalone")], contacts: [unseen] });
    const res = await updatePropertySection(
      { error: null, savedAt: null },
      form({ property_id: PROPERTY, section: "parties", expected_updated_at: T1, owner_contact_id: CONTACT }),
    );
    expect(res.error).toBe(UNAVAILABLE);
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", CONTACT]]);
    expect(fake.argsOf("properties", "update")).toHaveLength(0);
  });

  it("refuses a new developer of a project the caller cannot see, and writes nothing", async () => {
    const fake = use({ properties: [propertyRow("project")], contacts: [unseen] });
    const res = await updatePropertySection(
      { error: null, savedAt: null },
      form({ property_id: PROPERTY, section: "parties", expected_updated_at: T1, developer_contact_id: CONTACT }),
    );
    expect(res.error).toBe(UNAVAILABLE);
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", CONTACT]]);
    expect(fake.argsOf("properties", "update")).toHaveLength(0);
  });

  it("does not read an owner the property already carries", async () => {
    const fake = use({ properties: [propertyRow("standalone", { owner: CONTACT }), stop] });
    const res = await updatePropertySection(
      { error: null, savedAt: null },
      form({ property_id: PROPERTY, section: "parties", expected_updated_at: T1, owner_contact_id: CONTACT, assigned_agent_id: "" }),
    );
    expect(fake.argsOf("contacts", "eq"), "no read of an unchanged party").toEqual([]);
    expect(res.error).not.toBe(UNAVAILABLE);
  });
});
