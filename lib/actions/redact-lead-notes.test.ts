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
 * Two writes, so it RESUMES: a failed notes step says so, and the same action
 * finishes the job — the leads page offers "Finish redaction" while notes
 * remain. The one `redacted` event belongs to the message write, exactly once.
 * Refusals come back as `{ error }`: production replaces a thrown Server
 * Action message with a generic one.
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

  it("a fresh redaction rewrites the message once, logs its one event, then blanks THIS lead's unredacted notes in the caller's org", async () => {
    const { session, admin } = setup(
      [{ data: lead(), error: null }, { data: [{ id: LEAD }], error: null }],
      [{ data: [{ id: "n1" }, { id: "n2" }], error: null }],
    );
    expect(await redactLead(LEAD)).toEqual({ error: null });
    expect(session.argsOf("leads", "update")).toEqual([[{ message: LEAD_MESSAGE_REDACTED }]]);
    // exactly once: not a lead that is already the marker (null-safe)
    expect(session.argsOf("leads", "or")).toEqual([[`message.is.null,message.neq."${LEAD_MESSAGE_REDACTED}"`]]);
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

  it("a failed notes step keeps the message's event and says how to finish", async () => {
    setup(
      [{ data: lead(), error: null }, { data: [{ id: LEAD }], error: null }],
      [{ data: null, error: { message: "network down" } }],
    );
    const res = await redactLead(LEAD);
    expect(res.error).toMatch(/notes .*not.*Finish redaction/i);
    expect(logEvent).toHaveBeenCalledTimes(1); // the message write happened, and is recorded
  });

  it("finishing a redaction whose notes were left writes no message and logs no second event", async () => {
    const { session } = setup(
      [{ data: lead({ message: LEAD_MESSAGE_REDACTED }), error: null }],
      [{ data: [{ id: "n1" }], error: null }],
    );
    expect(await redactLead(LEAD)).toEqual({ error: null });
    expect(session.argsOf("leads", "update")).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a lead redacted meanwhile by someone else: no second event, and its notes are still finished", async () => {
    const { admin } = setup(
      [
        { data: lead(), error: null },
        { data: [], error: null }, // the guarded UPDATE: zero rows
        { data: { contact_id: null, message: LEAD_MESSAGE_REDACTED }, error: null }, // re-read
      ],
      [{ data: [{ id: "n1" }], error: null }],
    );
    expect(await redactLead(LEAD)).toEqual({ error: null });
    expect(logEvent).not.toHaveBeenCalled();
    expect(admin.argsOf("interaction_notes", "update")).toHaveLength(1);
  });

  it("a redaction with nothing left to do is refused as before, with no event", async () => {
    setup([{ data: lead({ message: LEAD_MESSAGE_REDACTED }), error: null }], [{ data: [], error: null }]);
    expect(await redactLead(LEAD)).toEqual({ error: "Already redacted." });
    expect(logEvent).not.toHaveBeenCalled();
  });
});

describe("refusals touch no note", () => {
  it("a linked lead is refused before the admin client is created", async () => {
    setup([{ data: lead({ contact_id: CONTACT }), error: null }], []);
    expect((await redactLead(LEAD)).error).toMatch(/erase the contact instead/);
    expect(state.adminCalls).toBe(0);
  });

  it("a non-admin is refused before the admin client is created", async () => {
    setup([{ data: lead(), error: null }], [], "agent");
    expect(await redactLead(LEAD)).toEqual({ error: "Admins only." });
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
    expect((await redactLead(LEAD)).error).toMatch(/linked to a contact meanwhile/);
    expect(state.adminCalls).toBe(0);
    expect(logEvent).not.toHaveBeenCalled();
  });
});
