import { describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * A WHATSAPP OR TELEGRAM CLICK NEVER STOPS THE RESPONSE CLOCK (A06, pinned).
 *
 * The Lead Speed Monitor's clock reads `leads.first_response_at`
 * (lib/services/response-clock.ts); the lead-SLA task (0098), the e-mail
 * escalation (0107, 0112) and the dashboard's response KPIs all key on it
 * being null. `markContacted`, `markCalled`, `logConversation` and
 * `convertLead` stamp it. A chat-link click must not: the button opens the
 * app, and nothing says a message was sent, let alone answered (no messaging
 * API — Do-Not-Build). Nor may it move a converted lead's deal
 * (`last_contact_at` silences the no-contact nudge, 0025).
 *
 * Measured, not assumed: `logChatLinkOpened` is driven here against a client
 * that records every table and verb, with the REAL `logEvent`. It writes one
 * events row and touches nothing else. The contrast case runs `markContacted`
 * on the same harness and sees its `first_response_at` write — so this file
 * would notice a click that started stamping. The database half (no trigger
 * stamps it either, the SLA task stays open) is
 * supabase/tests/contact-activity.test.ts.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "agent" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

const { logChatLinkOpened, markContacted } = await import("@/lib/actions/leads");

const LEAD = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";

function harness(pages: Record<string, FakePage[]> = {}) {
  const fake = fakeClient(pages);
  state.client = fake.client;
  return fake;
}

describe("logChatLinkOpened", () => {
  it.each(["whatsapp", "telegram"] as const)(
    "a %s click on a lead writes ONE event and no lead, deal or task",
    async (channel) => {
      const fake = harness();
      await logChatLinkOpened(LEAD, null, channel);

      expect(
        [...new Set(fake.calls.map((c) => c.table))],
        "the only table touched is events: no first_response_at, no status, no last_contact_at",
      ).toEqual(["events"]);
      expect(fake.calls.filter((c) => c.method === "update" || c.method === "upsert" || c.method === "delete")).toEqual([]);
      expect(fake.argsOf("events", "insert")).toEqual([
        [
          {
            org_id: "org-1",
            actor_id: "actor-1",
            entity_type: "lead",
            entity_id: LEAD,
            event_type: "chat_link_opened",
            payload: { channel },
          },
        ],
      ]);
    },
  );

  it("a click on the contact page files it on the contact, and likewise writes nothing else", async () => {
    const fake = harness();
    await logChatLinkOpened(null, CONTACT, "whatsapp");
    expect([...new Set(fake.calls.map((c) => c.table))]).toEqual(["events"]);
    expect(fake.argsOf("events", "insert")).toEqual([
      [expect.objectContaining({ entity_type: "contact", entity_id: CONTACT, event_type: "chat_link_opened" })],
    ]);
  });
});

describe("the harness sees a clock stamp when there is one", () => {
  it("markContacted on the same harness writes first_response_at — the write a click must never make", async () => {
    const fake = harness({
      leads: [
        { data: { id: LEAD, org_id: "org-1", status: "new", assigned_agent_id: null, first_response_at: null, first_call_at: null }, error: null },
        { data: [{ id: LEAD }], error: null },
      ],
    });
    await markContacted(LEAD);
    const [[update]] = fake.argsOf("leads", "update") as [[Record<string, unknown>]];
    expect(typeof update.first_response_at, "the stamp a chat click is pinned never to make").toBe("string");
  });
});
