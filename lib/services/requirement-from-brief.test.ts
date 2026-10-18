import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import { NOT_CONFIRMED_NOTICE, NOT_RECORDED_NOTICE } from "@/lib/services/optimistic-save";

/**
 * The website brief → saved search body (A04), shared by createContactFromEnquiry
 * and saveSearchFromEnquiry. What it writes, what its event says, and that every
 * outcome of the insert is CLASSIFIED — a certain refusal, an unknown, a save
 * whose timeline line failed — and none of them is a throw after the commit.
 */

const events = vi.hoisted(() => {
  class EventWriteError extends Error {
    constructor(
      message: string,
      readonly refused: boolean,
    ) {
      super(message);
    }
  }
  return {
    EventWriteError,
    logEvent: vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
  };
});
vi.mock("@/lib/services/events", () => ({ EventWriteError: events.EventWriteError, logEvent: events.logEvent }));

const { seedRequirementFromBrief, seedNote } = await import("./requirement-from-brief");

const ACTOR = { id: "actor-1", orgId: "org-1" };
const CONTACT = "c0c0c0c0-1111-4111-8111-111111111111";
const LEAD = "11111111-1111-4111-8111-111111111111";
const AREA = { id: "a0a0a0a0-1111-4111-8111-111111111111", district_id: "d0d0d0d0-1111-4111-8111-111111111111", name: { en: "Kato Paphos" } };
const BRIEF = { looking_to: "buy", budget: "300_500k", buy_area: "Kato Paphos", buy_property_type: "villa", bedrooms_min: "3" };

const areasOk: FakePage = { data: [AREA], error: null };
const inserted: FakePage = { data: { id: "r0r0r0r0-1111-4111-8111-111111111111" }, error: null, status: 201 };

function setup(pages: Record<string, FakePage[]>) {
  const fake = fakeClient(pages);
  return fake;
}

beforeEach(() => {
  events.logEvent.mockReset();
  events.logEvent.mockImplementation(async () => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("seedRequirementFromBrief", () => {
  it("inserts the seed for the contact, and writes requirement_added on the CONTACT with ids and shape only", async () => {
    const fake = setup({ areas: [areasOk], buyer_requirements: [inserted] });
    const out = await seedRequirementFromBrief(fake.client as never, ACTOR, CONTACT, BRIEF, LEAD);
    expect(out).toEqual({ kind: "saved", requirementId: "r0r0r0r0-1111-4111-8111-111111111111", notice: null });

    const [row] = fake.argsOf("buyer_requirements", "insert")[0] as [Record<string, unknown>];
    expect(row).toMatchObject({
      org_id: "org-1",
      contact_id: CONTACT,
      created_by: "actor-1",
      label: "From website enquiry",
      transaction_type: "sale",
      property_types: ["villa"],
      area_ids: [AREA.id],
      district_ids: [AREA.district_id],
      budget_min: 300000,
      budget_max: 500000,
      bedrooms_min: 3,
    });

    expect(events.logEvent).toHaveBeenCalledTimes(1);
    expect(events.logEvent.mock.calls[0]![1]).toEqual({
      orgId: "org-1",
      actorId: "actor-1",
      entityType: "contact",
      entityId: CONTACT,
      eventType: "requirement_added",
      payload: {
        requirement_id: "r0r0r0r0-1111-4111-8111-111111111111",
        label: "From website enquiry",
        via: "website_enquiry",
        lead_id: LEAD,
      },
    });
  });

  it("a brief with no buyer answers writes nothing", async () => {
    const fake = setup({ areas: [areasOk] });
    expect(await seedRequirementFromBrief(fake.client as never, ACTOR, CONTACT, { district: "Paphos" }, LEAD)).toEqual({
      kind: "no_brief",
    });
    expect(fake.argsOf("buyer_requirements", "insert")).toEqual([]);
    expect(events.logEvent).not.toHaveBeenCalled();
  });

  it("an areas read that failed refuses — a search saved without the brief's area would read 'anywhere'", async () => {
    for (const page of [
      { data: null, error: { message: "upstream timeout" } },
      { data: null, error: null },
    ] as FakePage[]) {
      const fake = setup({ areas: [page] });
      const out = await seedRequirementFromBrief(fake.client as never, ACTOR, CONTACT, BRIEF, LEAD);
      expect(out).toEqual({ kind: "refused", reason: "the areas could not be read" });
      expect(fake.argsOf("buyer_requirements", "insert")).toEqual([]);
    }
    expect(events.logEvent).not.toHaveBeenCalled();
  });

  it("an insert CERTAINLY refused is `refused`, and writes no event", async () => {
    const fake = setup({
      areas: [areasOk],
      buyer_requirements: [{ data: null, error: { message: "new row violates row-level security policy", code: "42501" } }],
    });
    const out = await seedRequirementFromBrief(fake.client as never, ACTOR, CONTACT, BRIEF, LEAD);
    expect(out).toEqual({ kind: "refused", reason: "new row violates row-level security policy" });
    expect(events.logEvent).not.toHaveBeenCalled();
  });

  it("an insert whose outcome is unknown — no code, a code that can follow a commit, a hollow answer — is `unconfirmed`, never refused", async () => {
    for (const page of [
      { data: null, error: { message: "fetch failed" } },
      { data: null, error: { message: "connection reset", code: "08006" } },
      { data: null, error: null, status: 204 },
    ] as FakePage[]) {
      const fake = setup({ areas: [areasOk], buyer_requirements: [page] });
      expect(await seedRequirementFromBrief(fake.client as never, ACTOR, CONTACT, BRIEF, LEAD)).toEqual({
        kind: "unconfirmed",
      });
    }
    expect(events.logEvent).not.toHaveBeenCalled();
  });

  it("a saved search whose line was REFUSED is kept, with NOT_RECORDED — never a throw", async () => {
    events.logEvent.mockRejectedValueOnce(new events.EventWriteError("refused", true));
    const fake = setup({ areas: [areasOk], buyer_requirements: [inserted] });
    const out = await seedRequirementFromBrief(fake.client as never, ACTOR, CONTACT, BRIEF, LEAD);
    expect(out).toMatchObject({ kind: "saved", notice: NOT_RECORDED_NOTICE });
  });

  it("a saved search whose line is UNKNOWN is kept, with NOT_CONFIRMED", async () => {
    events.logEvent.mockRejectedValueOnce(new events.EventWriteError("hollow", false));
    const fake = setup({ areas: [areasOk], buyer_requirements: [inserted] });
    expect(await seedRequirementFromBrief(fake.client as never, ACTOR, CONTACT, BRIEF, LEAD)).toMatchObject({
      kind: "saved",
      notice: NOT_CONFIRMED_NOTICE,
    });

    events.logEvent.mockRejectedValueOnce(new TypeError("fetch failed"));
    const again = setup({ areas: [areasOk], buyer_requirements: [inserted] });
    expect(await seedRequirementFromBrief(again.client as never, ACTOR, CONTACT, BRIEF, LEAD)).toMatchObject({
      kind: "saved",
      notice: NOT_CONFIRMED_NOTICE,
    });
  });
});

describe("seedNote — the create-contact path's caveat", () => {
  it("says nothing for no brief or a clean save, and passes a save's notice through", () => {
    expect(seedNote({ kind: "no_brief" })).toBeNull();
    expect(seedNote({ kind: "saved", requirementId: "r", notice: null })).toBeNull();
    expect(seedNote({ kind: "saved", requirementId: "r", notice: NOT_RECORDED_NOTICE })).toBe(NOT_RECORDED_NOTICE);
  });

  it("a refusal keeps the old sentence; an unknown asks the desk to look before adding it again", () => {
    expect(seedNote({ kind: "refused", reason: "boom" })).toBe(
      "The saved search could not be created (boom) — add it on the contact.",
    );
    expect(seedNote({ kind: "unconfirmed" })).toMatch(/could not be confirmed.*before adding it again/);
  });
});
