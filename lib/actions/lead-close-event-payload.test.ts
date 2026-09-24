import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * Closing a lead as lost or spam stores the typed reason on the LEAD ROW and
 * logs the act — which lead, and the outcome as the event type — never the
 * reason itself (audit SEC-03, DECISIONS T-lead-lost-reason-shape).
 *
 * The reason is free text an agent types (up to 500 characters, required for
 * `lost`, optional for `spam`), and it names people ("Andreas went with his
 * brother-in-law's agency"). Until this change `closeLead` copied it into the
 * hash-chained `lost` / `spam` event, where neither erasure nor a correction
 * can reach it. `leads.lost_reason` has always held it too, and the leads inbox
 * prints it from there. The row is also the honest place for it: a reopen
 * clears it and a re-close replaces it, so the CURRENT reason is not an older
 * event's, and the timeline line says only "Marked lost".
 *
 * The real action calls the real `logEvent`; the assertions read the row that
 * reached `events.insert` — the exact bytes the chain would hash.
 */

const state = vi.hoisted(() => ({
  client: null as unknown,
  profile: { id: "agent-1", orgId: "org-1", role: "agent" } as { id: string; orgId: string; role: string },
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({ getCurrentProfile: async () => state.profile }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { closeLead } = await import("@/lib/actions/leads");

const LEAD_ID = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01";
// synthetic: a name, a phone number and an e-mail — none may reach the chain
const REASON = "Andreas Kyprianou went with his brother-in-law, 99 555 666, andreas.k@example.invalid";
const WORDS = ["Andreas", "Kyprianou", "brother-in-law", "99 555 666", "andreas.k", "example.invalid"];

const openLead = (extra: Record<string, unknown> = {}): FakePage => ({
  data: { id: LEAD_ID, org_id: "org-1", status: "new", assigned_agent_id: null, ...extra },
  error: null,
});

/** the lead read, then the conditional update */
function close(outcome: string, reason: string | null, pages: FakePage[]) {
  const fake = fakeClient({ leads: pages });
  state.client = fake.client;
  const fd = new FormData();
  fd.set("lead_id", LEAD_ID);
  fd.set("outcome", outcome);
  if (reason !== null) fd.set("reason", reason);
  return { fake, result: closeLead({ error: null, savedAt: null }, fd) };
}

const inserted = (fake: ReturnType<typeof fakeClient>) =>
  fake.argsOf("events", "insert").map((args) => args[0] as Record<string, unknown>);

beforeEach(() => {
  state.client = null;
  state.profile = { id: "agent-1", orgId: "org-1", role: "agent" };
});

describe("closeLead keeps the reason on the lead, not in the chain", () => {
  it("lost: the row gets the status and the typed reason, only while the lead is still open", async () => {
    const { fake, result } = close("lost", REASON, [openLead(), { data: [{ id: LEAD_ID }], error: null }]);
    expect((await result).error).toBeNull();
    expect(fake.argsOf("leads", "update")).toEqual([[{ status: "lost", lost_reason: REASON }]]);
    // race-safe precondition folded into the write, unchanged
    expect(fake.argsOf("leads", "in")).toEqual([["status", ["new", "contacted", "qualified"]]]);
    // and the write names THIS lead: the id filter is chained onto the update
    // itself (the read before it filters on the id too, so order is the proof)
    const leadCalls = fake.calls.filter((c) => c.table === "leads");
    const at = leadCalls.findIndex((c) => c.method === "update");
    expect(leadCalls.slice(at + 1).find((c) => c.method === "eq")?.args).toEqual(["id", LEAD_ID]);
  });

  it("lost: ONE event, typed `lost`, on the lead, with an empty payload", async () => {
    const { fake, result } = close("lost", REASON, [openLead(), { data: [{ id: LEAD_ID }], error: null }]);
    expect((await result).error).toBeNull();
    const rows = inserted(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: "org-1",
      actor_id: "agent-1",
      entity_type: "lead",
      entity_id: LEAD_ID,
      event_type: "lost",
    });
    expect(rows[0].payload).toEqual({});
  });

  it("spam with a reason: the row keeps it, the event carries none", async () => {
    const { fake, result } = close("spam", REASON, [openLead(), { data: [{ id: LEAD_ID }], error: null }]);
    expect((await result).error).toBeNull();
    expect(fake.argsOf("leads", "update")).toEqual([[{ status: "spam", lost_reason: REASON }]]);
    const rows = inserted(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: "lead", event_type: "spam" });
    expect(rows[0].payload).toEqual({});
  });

  it("spam without a reason logs the same empty payload", async () => {
    const { fake, result } = close("spam", null, [openLead(), { data: [{ id: LEAD_ID }], error: null }]);
    expect((await result).error).toBeNull();
    expect(inserted(fake)[0].payload).toEqual({});
  });

  it("puts none of the reason's words anywhere in the inserted event row, for either outcome", async () => {
    for (const outcome of ["lost", "spam"]) {
      const { fake, result } = close(outcome, REASON, [openLead(), { data: [{ id: LEAD_ID }], error: null }]);
      expect((await result).error).toBeNull();
      const text = JSON.stringify(inserted(fake));
      expect(WORDS.filter((w) => text.includes(w)), `a ${outcome} reason reached the hash chain`).toEqual([]);
    }
  });

  it("a lead that changed underneath (0 rows: already closed or converted) logs no phantom event", async () => {
    const { fake, result } = close("lost", REASON, [openLead(), { data: [], error: null }]);
    expect((await result).error).toMatch(/changed underneath/);
    expect(inserted(fake)).toEqual([]);
  });

  it("a lead that is not open is refused before anything is written or logged", async () => {
    const { fake, result } = close("lost", REASON, [openLead({ status: "converted" })]);
    expect((await result).error).toMatch(/open lead/);
    expect(fake.argsOf("leads", "update")).toEqual([]);
    expect(inserted(fake)).toEqual([]);
  });

  it("another agent's lead is refused before anything is written or logged", async () => {
    const { fake, result } = close("lost", REASON, [openLead({ assigned_agent_id: "agent-2" })]);
    expect((await result).error).toMatch(/another agent/);
    expect(fake.argsOf("leads", "update")).toEqual([]);
    expect(inserted(fake)).toEqual([]);
  });

  it("lost without a reason is refused before anything is read, written or logged", async () => {
    const { fake, result } = close("lost", "  ", []);
    expect((await result).error).toMatch(/reason is required/);
    expect(fake.calls).toEqual([]);
  });
});
