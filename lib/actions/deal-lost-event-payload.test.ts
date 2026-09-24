import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * Marking a deal lost stores the typed reason on the DEAL ROW and logs the act
 * — which deal, that it was lost, and the lost stage's name — never the
 * reason itself (audit SEC-03, DECISIONS T-event-typed-text-shape).
 *
 * The reason is free text an agent types, up to 2000 characters, and it names
 * people ("Eleni chose her cousin's villa"). Until this change `markDealLost`
 * copied it into the hash-chained `lost` event. `deals.lost_reason` has always
 * held it too, and the deal page prints it from there; the timeline line now
 * says only "Marked lost", so the CURRENT reason (a reopened-and-relost deal's
 * reason is not the first one's) is never presented as an old event's.
 *
 * The real action calls the real `logEvent`; the assertions read the row that
 * reached `events.insert`.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "agent-1", orgId: "org-1", role: "agent" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { markDealLost } = await import("@/lib/actions/deals");

const DEAL_ID = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e01";
const STAGE_ID = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e02";
// synthetic: a name, a phone number and an e-mail — none may reach the chain
const REASON =
  "Eleni Charalambous bought her cousin's villa instead; call 99 333 444 or eleni.c@example.invalid";
const WORDS = ["Eleni", "Charalambous", "cousin", "99 333 444", "eleni.c", "example.invalid"];

const openDeal: FakePage = {
  data: { id: DEAL_ID, org_id: "org-1", deal_type: "sale", status: "open" },
  error: null,
};

function markLost(pages: Record<string, FakePage[]>, reason = REASON) {
  const fake = fakeClient(pages);
  state.client = fake.client;
  const fd = new FormData();
  fd.set("deal_id", DEAL_ID);
  fd.set("lost_reason", reason);
  return { fake, result: markDealLost({ error: null, savedAt: null }, fd) };
}

const inserted = (fake: ReturnType<typeof fakeClient>) =>
  fake.argsOf("events", "insert").map((args) => args[0] as Record<string, unknown>);

beforeEach(() => {
  state.client = null;
});

describe("markDealLost keeps the reason on the deal, not in the chain", () => {
  it("stores the typed reason on the deal row and moves it to the lost stage", async () => {
    const { fake, result } = markLost({
      deals: [openDeal, { data: { id: DEAL_ID }, error: null }],
      deal_stages: [{ data: { id: STAGE_ID, name: "Lost" }, error: null }],
    });
    expect((await result).error).toBeNull();
    const [patch] = fake.argsOf("deals", "update")[0] as [Record<string, unknown>];
    expect(patch).toMatchObject({ status: "lost", lost_reason: REASON, stage_id: STAGE_ID });
    expect(typeof patch.lost_at).toBe("string");
  });

  it("logs ONE lost event carrying the lost stage's name only", async () => {
    const { fake, result } = markLost({
      deals: [openDeal, { data: { id: DEAL_ID }, error: null }],
      deal_stages: [{ data: { id: STAGE_ID, name: "Lost" }, error: null }],
    });
    expect((await result).error).toBeNull();
    const rows = inserted(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: "org-1",
      actor_id: "agent-1",
      entity_type: "deal",
      entity_id: DEAL_ID,
      event_type: "lost",
    });
    expect(rows[0].payload).toEqual({ stage: "Lost" });
  });

  it("logs an empty payload when the pipeline has no lost stage", async () => {
    const { fake, result } = markLost({
      deals: [openDeal, { data: { id: DEAL_ID }, error: null }],
      deal_stages: [{ data: null, error: null }],
    });
    expect((await result).error).toBeNull();
    expect(inserted(fake)[0].payload).toEqual({});
  });

  it("puts none of the reason's words anywhere in the inserted event row", async () => {
    const { fake, result } = markLost({
      deals: [openDeal, { data: { id: DEAL_ID }, error: null }],
      deal_stages: [{ data: { id: STAGE_ID, name: "Lost" }, error: null }],
    });
    expect((await result).error).toBeNull();
    const text = JSON.stringify(inserted(fake));
    expect(WORDS.filter((w) => text.includes(w)), "a lost reason reached the hash chain").toEqual([]);
  });

  it("a refused update (RLS: not this agent's deal) logs no phantom event", async () => {
    const { fake, result } = markLost({
      deals: [openDeal, { data: null, error: null }],
      deal_stages: [{ data: { id: STAGE_ID, name: "Lost" }, error: null }],
    });
    expect((await result).error).toMatch(/permission/);
    expect(inserted(fake)).toEqual([]);
  });

  it("a deal that is not open is refused before anything is written or logged", async () => {
    const { fake, result } = markLost({
      deals: [{ data: { id: DEAL_ID, org_id: "org-1", deal_type: "sale", status: "won" }, error: null }],
    });
    expect((await result).error).toMatch(/already won/);
    expect(fake.argsOf("deals", "update")).toEqual([]);
    expect(inserted(fake)).toEqual([]);
  });

  it("a missing reason is refused before anything is written or logged", async () => {
    const { fake, result } = markLost({ deals: [openDeal] }, "  ");
    expect((await result).error).toMatch(/reason/i);
    expect(fake.argsOf("deals", "update")).toEqual([]);
    expect(inserted(fake)).toEqual([]);
  });
});
