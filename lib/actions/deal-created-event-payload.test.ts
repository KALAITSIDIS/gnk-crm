import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * A converted deal's `created` event carries ids and shape, never the buyer's
 * name (audit SEC-03, DECISIONS T-deal-created-title-shape).
 *
 * `convertLead` titles a deal `<contact display name> — <reference>` and, until
 * 2026-09-23, wrote that title into the deal's hash-chained `created` event — the
 * buyer's name, on every conversion, where neither erasure nor a correction can
 * reach it. Nothing reads it there: the timeline's `created` line prints an
 * amount only. The title stays on the deal ROW, where the pipeline shows it and
 * erasure and editing reach it. Driven through the real action, like
 * updated-event-payload.test.ts, and every logged payload is searched for the
 * fixture's own name.
 */

const state = vi.hoisted(() => ({ client: null as unknown, fake: null as unknown }));
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

const { convertLead } = await import("@/lib/actions/leads");

const LEAD_ID = "5d2e8c1a-3b4f-4c6d-8e9f-0a1b2c3d4e01";
const CONTACT_ID = "5d2e8c1a-3b4f-4c6d-8e9f-0a1b2c3d4e02";
const PROPERTY_ID = "5d2e8c1a-3b4f-4c6d-8e9f-0a1b2c3d4e03";
const BUYER = "Kyriakoula Palaiopoulou";

const lead = (criteria: Record<string, unknown> | null = null) => ({
  id: LEAD_ID,
  org_id: "org-1",
  status: "new",
  contact_id: CONTACT_ID,
  property_id: PROPERTY_ID,
  assigned_agent_id: null,
  first_response_at: null,
  criteria,
});

/** the lead, the first stage, the buyer, the listing, the deal insert, the claim */
function convert(criteria: Record<string, unknown> | null = null) {
  logEvent.mockClear();
  const pages: Record<string, FakePage[]> = {
    leads: [
      { data: lead(criteria), error: null },
      { data: [{ id: LEAD_ID }], error: null },
    ],
    deal_stages: [{ data: { id: "stage-1", name: "Qualified" }, error: null }],
    contacts: [{ data: { display_name: BUYER }, error: null }],
    properties: [{ data: { reference: "PAF0007" }, error: null }],
    deals: [{ data: null, error: null }],
  };
  const fake = fakeClient(pages);
  state.client = fake.client;
  const fd = new FormData();
  fd.set("lead_id", LEAD_ID);
  fd.set("deal_type", "sale");
  return { fake, result: convertLead({ error: null, savedAt: null }, fd) };
}

const logged = () => logEvent.mock.calls.map((c) => c[1]);

beforeEach(() => {
  logEvent.mockClear();
});

describe("convertLead writes the deal's title to the row, not the chain", () => {
  it("puts the buyer's name in no event it logs", async () => {
    const { result } = convert();
    expect((await result).error).toBeNull();
    const text = JSON.stringify(logged().map((e) => e.payload));
    expect(
      ["Kyriakoula", "Palaiopoulou"].filter((v) => text.includes(v)),
      "the buyer's name reached the hash chain",
    ).toEqual([]);
  });

  it("logs the deal's created event with ids and shape only", async () => {
    const { result } = convert();
    expect((await result).error).toBeNull();
    const created = logged().find((e) => e.entityType === "deal" && e.eventType === "created");
    expect(created?.payload).toEqual({ from_lead: LEAD_ID, stage: "Qualified" });
  });

  it("keeps the expected value a website budget band seeded", async () => {
    const { result } = convert({ budget: "300_500k" });
    expect((await result).error).toBeNull();
    const created = logged().find((e) => e.entityType === "deal" && e.eventType === "created");
    expect(created?.payload).toEqual({
      from_lead: LEAD_ID,
      stage: "Qualified",
      expected_value: 500000,
      expected_value_from: "website_budget_band",
    });
  });

  it("still titles the deal ROW with the buyer's name and the reference", async () => {
    const { fake, result } = convert();
    expect((await result).error).toBeNull();
    const [row] = fake.argsOf("deals", "insert")[0] as [Record<string, unknown>];
    expect(row.title).toBe(`${BUYER} — PAF0007`);
  });

  it("leaves the lead's converted event as it was — ids only", async () => {
    const { result } = convert();
    expect((await result).error).toBeNull();
    const converted = logged().find((e) => e.entityType === "lead" && e.eventType === "converted");
    expect(converted?.payload).toMatchObject({ deal_type: "sale" });
    expect(Object.keys(converted?.payload as object).sort()).toEqual(["deal_id", "deal_type"]);
  });
});
