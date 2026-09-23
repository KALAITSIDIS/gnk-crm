import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * An edit writes WHICH fields moved into the chain — never a person's
 * identifiers or the words somebody typed (audit SEC-03, DECISIONS
 * T-updated-event-shape-only).
 *
 * Until 2026-09-23 every section save logged `{ section, changed }` with the
 * old and the new value of each field that moved: a corrected name, e-mail or
 * phone entered the hash-chained payload twice, and so did every note. Events
 * are never updated and erasure leaves them alone by design, so both copies
 * outlived any request to remove or rectify them. The static scan
 * (event-payload-privacy.test.ts) cannot see this — the values sit inside the
 * shorthand `changed` — so each test here drives the real action and searches
 * everything it logged for the fixture's own values, whatever syntax put them
 * there. The fields that still carry from/to are asserted too: sales velocity
 * reads `changed.status.to`, 0073's feed reads `changed.visibility.to`, and
 * the consent event reads `changed.consent_marketing`.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "admin-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
vi.mock("@/lib/services/followup-tasks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  completeListingStatusChecks: vi.fn(async () => 0),
}));
vi.mock("@/lib/services/match-alerts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  raiseNewListingAlert: vi.fn(async () => ({ newlyMatching: 0 })),
  raisePriceDropAlert: vi.fn(async () => undefined),
}));

const { updateContactSection } = await import("@/lib/actions/contacts");
const { updateDealSection, saveOffer } = await import("@/lib/actions/deals");
const { saveMandate } = await import("@/lib/actions/mandates");
const { updatePropertySection } = await import("@/lib/actions/properties");

const CONTACT_ID = "7c1f3a52-4a0e-4d8b-9a51-0f6f3f1c2a01";
const DEAL_ID = "7c1f3a52-4a0e-4d8b-9a51-0f6f3f1c2a02";
const OFFER_ID = "7c1f3a52-4a0e-4d8b-9a51-0f6f3f1c2a03";
const MANDATE_ID = "7c1f3a52-4a0e-4d8b-9a51-0f6f3f1c2a04";
const PROPERTY_ID = "7c1f3a52-4a0e-4d8b-9a51-0f6f3f1c2a05";
const T1 = "2026-09-23T08:00:00.000000+00:00";

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) fd.append(key, v);
  }
  return fd;
}

function use(pages: Record<string, FakePage[]>) {
  logEvent.mockClear();
  state.client = fakeClient(pages).client;
}

function logged() {
  return logEvent.mock.calls.map((c) => c[1]);
}

function updatedEvent() {
  const e = logged().find((x) => x.eventType === "updated");
  expect(e, "the save logged an `updated` event").toBeDefined();
  return e!.payload as { section?: string; changed: Record<string, Record<string, unknown>> };
}

/** Every fixture value found anywhere in anything the action logged. */
function leaks(values: string[]): string[] {
  const text = JSON.stringify(logged().map((e) => e.payload));
  return values.filter((v) => text.includes(v));
}

/** A field recorded as moved, without either of its values. */
function expectShapeOnly(
  changed: Record<string, Record<string, unknown>>,
  field: string,
  shape: { from_set: boolean; to_set: boolean; keys?: string[] },
) {
  expect(changed[field], `${field} is recorded as moved`).toBeDefined();
  expect(changed[field], `${field} carries no value`).not.toHaveProperty("from");
  expect(changed[field], `${field} carries no value`).not.toHaveProperty("to");
  expect(changed[field]).toEqual(shape);
}

beforeEach(() => {
  logEvent.mockClear();
});

/* ------------------------------------------------------------------ contacts */

const contactBefore = {
  id: CONTACT_ID,
  org_id: "org-1",
  contact_kind: "person",
  first_name: "Kyriakoula",
  last_name: "Palaiopoulou",
  display_name: "Kyriakoula Palaiopoulou",
  company_name: "Palaiopoulou Holdings",
  phone_e164: "+35799111222",
  phone_raw: "99 111 222",
  additional_phones: [],
  email: "kyriakoula@old.example",
  telegram_username: "kyriakoula_old",
  has_whatsapp: false,
  languages: ["en"],
  nationality: "Moldovan",
  contact_types: ["buyer"],
  temperature: "warm",
  source: "website",
  source_detail: "Stand fourteen at the Limassol expo",
  preferred_channel: "email",
  psychology: "retirement",
  consent_marketing: false,
  consent_at: null,
  gdpr_notes: "Asked not to be called before noon",
  notes: "Divorcing, wants to buy before the settlement",
  assigned_agent_id: null,
  is_archived: false,
  kyc: { passport_id: { done: false } },
  banking_readiness: {},
};

/** Old AND new: a value that leaves the row must not stay in the chain either. */
const CONTACT_VALUES = [
  "Kyriakoula",
  "Palaiopoulou",
  "Kyriaki",
  "Neopoulou",
  "Holdings",
  "Trading",
  "99111222",
  "99 111 222",
  "99555666",
  "99 555 666",
  "kyriakoula@old.example",
  "kyriaki@new.example",
  "kyriakoula_old",
  "kyriaki_new",
  "Moldovan",
  "Georgian",
  "Limassol expo",
  "cousin Andreas",
  "retirement",
  "relocation",
  "before noon",
  "at the viewing",
  "Divorcing",
  "Settlement signed",
];

const profileForm = (overrides: Record<string, string | string[]> = {}) =>
  form({
    contact_id: CONTACT_ID,
    section: "profile",
    contact_kind: "person",
    first_name: "Kyriaki",
    last_name: "Neopoulou",
    company_name: "Neopoulou Trading",
    phone: "+357 99 555 666",
    email: "kyriaki@new.example",
    telegram_username: "kyriaki_new",
    has_whatsapp: "on",
    languages: ["en", "ru"],
    nationality: "Georgian",
    contact_types: ["buyer", "investor"],
    temperature: "hot",
    source: "referral",
    source_detail: "Sent by her cousin Andreas",
    preferred_channel: "whatsapp",
    psychology: "relocation",
    consent_marketing: "on",
    gdpr_notes: "Consent given in person at the viewing",
    notes: "Settlement signed, cash ready",
    ...overrides,
  });

/** read, the phone duplicate check, the e-mail duplicate check, the UPDATE */
const contactPages = (): Record<string, FakePage[]> => ({
  contacts: [
    { data: contactBefore, error: null },
    { data: [], error: null },
    { data: [], error: null },
    { data: [{ id: CONTACT_ID }], error: null },
  ],
});

describe("a contact profile edit (updateContactSection, section profile)", () => {
  it("puts no name, phone, e-mail, handle, note or profile of the person — old or new — in any event", async () => {
    use(contactPages());
    const res = await updateContactSection({ error: null, savedAt: null }, profileForm());
    expect(res.error).toBeNull();
    expect(leaks(CONTACT_VALUES), "a client's data reached the hash chain").toEqual([]);
  });

  it("records each identifier and free-text field as moved, without its values", async () => {
    use(contactPages());
    await updateContactSection({ error: null, savedAt: null }, profileForm());
    const { section, changed } = updatedEvent();
    expect(section).toBe("profile");
    const both = { from_set: true, to_set: true };
    for (const field of [
      "first_name",
      "last_name",
      "company_name",
      "phone_e164",
      "phone_raw",
      "email",
      "telegram_username",
      "languages",
      "nationality",
      "source_detail",
      "psychology",
      "gdpr_notes",
      "notes",
    ]) {
      expectShapeOnly(changed, field, both);
    }
  });

  it("keeps from/to for the fields that describe the desk's work, not the person", async () => {
    use(contactPages());
    await updateContactSection({ error: null, savedAt: null }, profileForm());
    const { changed } = updatedEvent();
    expect(changed.temperature).toEqual({ from: "warm", to: "hot" });
    expect(changed.contact_types).toEqual({ from: ["buyer"], to: ["buyer", "investor"] });
    expect(changed.source).toEqual({ from: "website", to: "referral" });
    expect(changed.preferred_channel).toEqual({ from: "email", to: "whatsapp" });
    expect(changed.has_whatsapp).toEqual({ from: false, to: true });
    expect(changed.consent_marketing).toEqual({ from: false, to: true });
    expect(changed.consent_at).toMatchObject({ from: null });
    expect(typeof changed.consent_at?.to).toBe("string");
  });

  it("still writes the consent flip as its own event (SEC-06)", async () => {
    use(contactPages());
    await updateContactSection({ error: null, savedAt: null }, profileForm());
    const consent = logged().find((e) => e.eventType === "consent_changed");
    expect(consent?.payload).toEqual({ from: false, to: true, channel: "crm_form" });
  });

  it("says whether a value was added or removed — never which", async () => {
    // e-mail and notes cleared, a company name where there was none
    use({
      contacts: [
        { data: { ...contactBefore, company_name: null }, error: null },
        { data: [], error: null }, // phone duplicate check (the phone moves)
        { data: [{ id: CONTACT_ID }], error: null }, // the UPDATE — no e-mail check for a blank
      ],
    });
    const res = await updateContactSection(
      { error: null, savedAt: null },
      profileForm({ email: "", notes: "" }),
    );
    expect(res.error).toBeNull();
    const { changed } = updatedEvent();
    expectShapeOnly(changed, "email", { from_set: true, to_set: false });
    expectShapeOnly(changed, "notes", { from_set: true, to_set: false });
    expectShapeOnly(changed, "company_name", { from_set: false, to_set: true });
    expect(leaks(CONTACT_VALUES)).toEqual([]);
  });
});

describe("a contact KYC and banking edit (updateContactSection, section kyc_banking)", () => {
  const KYC_VALUES = ["K00471923", "drive.example", "enhanced checks", "Moldova"];

  it("names the checklist items that moved, never a note, a document link or a country", async () => {
    use({
      contacts: [
        { data: contactBefore, error: null },
        { data: [{ id: CONTACT_ID }], error: null },
      ],
    });
    const res = await updateContactSection(
      { error: null, savedAt: null },
      form({
        contact_id: CONTACT_ID,
        section: "kyc_banking",
        kyc_passport_id_done: "on",
        kyc_passport_id_note: "Passport K00471923 checked against the original",
        kyc_passport_id_doc: "https://drive.example/kyriakoula-passport.pdf",
        nationality_risk_note: "Moldovan passport, enhanced checks",
        funds_origin_country: "Moldova",
        bank_pre_check_done: "on",
        account_feasibility: "maybe",
      }),
    );
    expect(res.error).toBeNull();
    expect(leaks(KYC_VALUES), "a client's data reached the hash chain").toEqual([]);
    const { section, changed } = updatedEvent();
    expect(section).toBe("kyc_banking");
    expectShapeOnly(changed, "kyc", { from_set: true, to_set: true, keys: ["passport_id"] });
    expectShapeOnly(changed, "banking_readiness", {
      from_set: false,
      to_set: true,
      keys: ["account_feasibility", "bank_pre_check_done", "funds_origin_country", "nationality_risk_note"],
    });
  });
});

/* --------------------------------------------------------------------- deals */

describe("a deal edit (updateDealSection) and an offer edit (saveOffer)", () => {
  it("records a retitled deal as moved — the title is built from the buyer's name", async () => {
    // convertLead titles a deal `<contact display name> — <reference>` (leads.ts)
    use({
      deals: [
        {
          data: {
            id: DEAL_ID,
            title: "Kyriakoula Palaiopoulou — PAF0007",
            property_id: null,
            buyer_contact_id: CONTACT_ID,
            seller_contact_id: null,
            agent_id: null,
            expected_value: 350000,
          },
          error: null,
        },
        { data: { id: DEAL_ID }, error: null },
      ],
    });
    const res = await updateDealSection(
      { error: null, savedAt: null },
      form({
        deal_id: DEAL_ID,
        section: "details",
        title: "Kyriaki Neopoulou — PAF0007",
        buyer_contact_id: CONTACT_ID,
        expected_value: "365000",
      }),
    );
    expect(res.error).toBeNull();
    expect(leaks(["Kyriakoula", "Palaiopoulou", "Kyriaki", "Neopoulou"])).toEqual([]);
    const { changed } = updatedEvent();
    expectShapeOnly(changed, "title", { from_set: true, to_set: true });
    expect(changed.expected_value).toEqual({ from: 350000, to: 365000 });
  });

  it("records the commission-split notes as moved, without the words", async () => {
    use({
      deals: [
        {
          data: { id: DEAL_ID, commission_split_notes: "Referral fee owed to Kyriakoula's cousin" },
          error: null,
        },
        { data: { id: DEAL_ID }, error: null },
      ],
    });
    const res = await updateDealSection(
      { error: null, savedAt: null },
      form({
        deal_id: DEAL_ID,
        section: "commission",
        commission_split_notes: "Half to Andreas Georgiou of Partner Realty",
      }),
    );
    expect(res.error).toBeNull();
    expect(leaks(["Kyriakoula", "Referral fee", "Andreas Georgiou", "Partner Realty"])).toEqual([]);
    expectShapeOnly(updatedEvent().changed, "commission_split_notes", {
      from_set: true,
      to_set: true,
    });
  });

  it("records an offer's terms as moved and keeps the amount", async () => {
    use({
      deals: [
        {
          data: {
            id: DEAL_ID,
            org_id: "org-1",
            status: "open",
            property_id: null,
            buyer_contact_id: CONTACT_ID,
          },
          error: null,
        },
      ],
      offers: [
        {
          data: {
            id: OFFER_ID,
            deal_id: DEAL_ID,
            status: "submitted",
            amount: 340000,
            terms: "Subject to Kyriakoula's mortgage from Hellenic Bank",
            valid_until: null,
            contact_id: null,
          },
          error: null,
        },
        { data: { id: OFFER_ID }, error: null },
      ],
    });
    const res = await saveOffer(
      { error: null, savedAt: null },
      form({
        offer_id: OFFER_ID,
        deal_id: DEAL_ID,
        amount: "345000",
        terms: "Cash, completion after Neopoulou's settlement",
      }),
    );
    expect(res.error).toBeNull();
    expect(leaks(["Kyriakoula", "Hellenic Bank", "Neopoulou", "settlement"])).toEqual([]);
    const e = logged().find((x) => x.eventType === "updated");
    const { changed } = e!.payload as { changed: Record<string, Record<string, unknown>> };
    expectShapeOnly(changed, "terms", { from_set: true, to_set: true });
    expect(changed.amount).toEqual({ from: 340000, to: 345000 });
  });
});

/* ------------------------------------------------------------------ mandates */

describe("a mandate edit (saveMandate)", () => {
  it("records its notes as moved, without the words, and keeps the terms", async () => {
    use({
      mandates: [
        {
          data: {
            id: MANDATE_ID,
            property_id: PROPERTY_ID,
            type: "exclusive",
            owner_contact_id: CONTACT_ID,
            commission_pct: 3,
            commission_notes: "Palaiopoulou pays one percent to her brother",
            start_date: "2026-01-01",
            expiry_date: "2026-12-31",
            renewal_reminder_days: 30,
            notes: "Owner abroad until March, call her sister Eleni",
          },
          error: null,
        },
        { data: null, error: null },
      ],
    });
    const res = await saveMandate(
      { error: null, savedAt: null },
      form({
        mandate_id: MANDATE_ID,
        property_id: PROPERTY_ID,
        type: "exclusive",
        owner_contact_id: CONTACT_ID,
        commission_pct: "2.5",
        commission_notes: "Neopoulou agreed a flat fee with Andreas",
        start_date: "2026-01-01",
        expiry_date: "2026-12-31",
        renewal_reminder_days: "30",
        notes: "Owner back in Limassol, call her directly",
      }),
    );
    expect(res.error).toBeNull();
    expect(
      leaks(["Palaiopoulou", "brother", "sister Eleni", "Neopoulou", "Andreas", "back in Limassol"]),
    ).toEqual([]);
    const e = logged().find((x) => x.eventType === "updated");
    const { changed } = e!.payload as { changed: Record<string, Record<string, unknown>> };
    expectShapeOnly(changed, "commission_notes", { from_set: true, to_set: true });
    expectShapeOnly(changed, "notes", { from_set: true, to_set: true });
    expect(changed.commission_pct).toEqual({ from: 3, to: 2.5 });
  });
});

/* ---------------------------------------------------------------- properties */

const propertyBefore = {
  id: PROPERTY_ID,
  org_id: "org-1",
  reference: "PAF0007",
  kind: "standalone",
  property_type: "apartment",
  parent_id: null,
  status: "available",
  visibility: "private",
  transaction_type: "sale",
  vat_status: "resale_no_vat",
  has_storage: false,
  features: [],
  location_approx: false,
  updated_at: T1,
  internal_notes: "Owner Kyriakoula wants cash, reach her on 99 111 222",
  amenities_notes: "Next to her mother's house",
  title_deed_status: "pending",
  permit_status: "full",
  encumbrances_notes: "Mortgage to Hellenic Bank in Palaiopoulou's name",
  registration_no: "0/12345",
};

describe("a property edit (updatePropertySection)", () => {
  it("details: records the notes as moved and keeps status from/to (sales velocity reads it)", async () => {
    use({
      properties: [
        { data: propertyBefore, error: null },
        { data: [{ id: PROPERTY_ID }], error: null },
      ],
    });
    const res = await updatePropertySection(
      { error: null, savedAt: null },
      form({
        property_id: PROPERTY_ID,
        section: "details",
        expected_updated_at: T1,
        status: "under_offer",
        visibility: "private",
        transaction_type: "sale",
        vat_status: "resale_no_vat",
        internal_notes: "Kyriaki accepted, her lawyer is Andreas",
        amenities_notes: "Walking distance to Neopoulou's school",
      }),
    );
    expect(res.error).toBeNull();
    expect(
      leaks(["Kyriakoula", "99 111 222", "mother's house", "Kyriaki", "lawyer is Andreas", "Neopoulou"]),
    ).toEqual([]);
    const { changed } = updatedEvent();
    expectShapeOnly(changed, "internal_notes", { from_set: true, to_set: true });
    expectShapeOnly(changed, "amenities_notes", { from_set: true, to_set: true });
    expect(changed.status).toEqual({ from: "available", to: "under_offer" });
  });

  it("legal: records the encumbrances notes as moved and keeps the deed status", async () => {
    use({
      properties: [
        { data: propertyBefore, error: null },
        { data: [{ id: PROPERTY_ID }], error: null },
      ],
    });
    const res = await updatePropertySection(
      { error: null, savedAt: null },
      form({
        property_id: PROPERTY_ID,
        section: "legal",
        expected_updated_at: T1,
        title_deed_status: "separate",
        permit_status: "full",
        encumbrances_notes: "Memo in favour of Neopoulou's creditor",
        registration_no: "0/12345",
      }),
    );
    expect(res.error).toBeNull();
    expect(leaks(["Hellenic Bank", "Palaiopoulou", "Neopoulou"])).toEqual([]);
    const { changed } = updatedEvent();
    expectShapeOnly(changed, "encumbrances_notes", { from_set: true, to_set: true });
    expect(changed.title_deed_status).toEqual({ from: "pending", to: "separate" });
  });
});

/* ------------------------------------------------------------------- the guard */

describe("no action logs the raw diff", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)));
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("finds the actions that build a from/to diff", () => {
    const builders = files.filter((f) =>
      /changed\[key\] = \{ from:/.test(readFileSync(join(dir, f), "utf-8")),
    );
    expect(builders.sort()).toEqual(
      ["contacts.ts", "deals.ts", "mandates.ts", "party-defaults.ts", "properties.ts"].sort(),
    );
  });

  // The diff holds every value that moved; what an event may carry is its
  // shape (changesForChain). A payload that names `changed` bare — the
  // shorthand this idiom was copied with five times — is the raw diff.
  for (const file of files) {
    it(`${file} passes a diff through changesForChain before logging it`, () => {
      const src = readFileSync(join(dir, file), "utf-8");
      const raw = src
        .split("\n")
        .filter((line) => /payload:/.test(line) && /[{,]\s*changed\s*[},]/.test(line));
      expect(raw, `${file} logs the raw diff`).toEqual([]);
    });
  }
});
