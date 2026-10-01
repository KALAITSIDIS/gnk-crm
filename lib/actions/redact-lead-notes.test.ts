import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import { LEAD_MESSAGE_REDACTED } from "@/lib/services/erasure";

/**
 * Redacting an enquiry takes the desk's notes about it too
 * (BACKLOG "`redactLead` leaves the enquiry's conversation notes",
 * T-redact-lead-notes).
 *
 * Article 17 on an unlinked enquiry rewrote `leads.message` but left its
 * `interaction_notes` — the desk's own words about the person, which 0094 made
 * erasable exactly so they could go with the message, and which contact
 * erasure and `redact_stale_enquiries` both blank. A session cannot update a
 * note (0094's trigger admits only a redaction, by the service role), so the
 * action blanks them through the admin client, bounded by the caller's
 * organisation and this lead — contact erasure's path.
 *
 * Two writes, so it RESUMES: a failed notes step says so, and the same button
 * finishes the job — the leads page offers it while notes remain. One
 * `redacted` event, logged when the redaction completes.
 */

const LEAD = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
  client: null as unknown,
  admin: null as unknown,
  adminCalls: 0,
  profile: { id: "admin-1", orgId: "org-1", role: "admin" as string },
}));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminCalls += 1;
    return state.admin;
  },
}));
vi.mock("@/lib/services/auth", () => ({ getCurrentProfile: async () => state.profile }));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { redactLead } = await import("@/lib/actions/leads");

const lead = (over: Record<string, unknown> = {}) => ({
  id: LEAD,
  org_id: "org-1",
  status: "new",
  contact_id: null,
  message: "Website enquiry\nName: Maria Georgiou",
  ...over,
});

function setup(leads: FakePage[], notes: FakePage[], role = "admin") {
  const session = fakeClient({ leads });
  const admin = fakeClient({ interaction_notes: notes });
  state.client = session.client;
  state.admin = admin.client;
  state.adminCalls = 0;
  state.profile = { id: "admin-1", orgId: "org-1", role };
  logEvent.mockClear();
  return { session, admin };
}

describe("redactLead blanks the enquiry's notes", () => {
  beforeEach(() => logEvent.mockClear());

  it("a fresh redaction rewrites the message, then blanks THIS lead's unredacted notes in the caller's org, then logs one event", async () => {
    const { session, admin } = setup(
      [{ data: lead(), error: null }, { data: [{ id: LEAD }], error: null }],
      [{ data: [{ id: "n1" }, { id: "n2" }], error: null }],
    );
    await redactLead(LEAD);
    expect(session.argsOf("leads", "update")).toEqual([[{ message: LEAD_MESSAGE_REDACTED }]]);
    const [[patch]] = admin.argsOf("interaction_notes", "update") as [[Record<string, unknown>]];
    expect(patch.body).toBeNull();
    expect(typeof patch.redacted_at).toBe("string");
    expect(admin.argsOf("interaction_notes", "eq")).toEqual([
      ["org_id", "org-1"],
      ["entity_type", "lead"],
      ["entity_id", LEAD],
    ]);
    expect(admin.argsOf("interaction_notes", "is")).toEqual([["redacted_at", null]]);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]![1]).toMatchObject({ eventType: "redacted", entityId: LEAD, payload: {} });
  });

  it("a failed notes step says the message is gone but the notes are not, and logs nothing", async () => {
    setup(
      [{ data: lead(), error: null }, { data: [{ id: LEAD }], error: null }],
      [{ data: null, error: { message: "network down" } }],
    );
    await expect(redactLead(LEAD)).rejects.toThrow(/notes .*not.*Redact again/i);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("pressing Redact again finishes a redaction whose notes were left: no second message write, one event", async () => {
    const { session } = setup(
      [{ data: lead({ message: LEAD_MESSAGE_REDACTED }), error: null }],
      [{ data: [{ id: "n1" }], error: null }],
    );
    await redactLead(LEAD);
    expect(session.argsOf("leads", "update")).toEqual([]);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]![1]).toMatchObject({ eventType: "redacted", payload: {} });
  });

  it("a redaction with nothing left to do is refused as before, with no event", async () => {
    setup([{ data: lead({ message: LEAD_MESSAGE_REDACTED }), error: null }], [{ data: [], error: null }]);
    await expect(redactLead(LEAD)).rejects.toThrow("Already redacted.");
    expect(logEvent).not.toHaveBeenCalled();
  });
});

describe("refusals touch no note", () => {
  it("a linked lead is refused before the admin client is created", async () => {
    setup([{ data: lead({ contact_id: CONTACT }), error: null }], []);
    await expect(redactLead(LEAD)).rejects.toThrow(/erase the contact instead/);
    expect(state.adminCalls).toBe(0);
  });

  it("a non-admin is refused before the admin client is created", async () => {
    setup([{ data: lead(), error: null }], [], "agent");
    await expect(redactLead(LEAD)).rejects.toThrow("Admins only.");
    expect(state.adminCalls).toBe(0);
  });

  it("a lead linked between the read and the write keeps its notes", async () => {
    setup(
      [
        { data: lead(), error: null },
        { data: [], error: null }, // the conditional UPDATE: zero rows
        { data: { contact_id: CONTACT, message: "x" }, error: null }, // re-read: linked meanwhile
      ],
      [],
    );
    await expect(redactLead(LEAD)).rejects.toThrow(/linked to a contact meanwhile/);
    expect(state.adminCalls).toBe(0);
    expect(logEvent).not.toHaveBeenCalled();
  });
});
