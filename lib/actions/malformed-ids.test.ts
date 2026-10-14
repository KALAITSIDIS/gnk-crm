import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server actions that take a raw id string check it with z.guid() at entry,
 * BEFORE any read or write, and refuse in their own return shape (T-malformed-ids;
 * BACKLOG "External audit — 2026-10-14", "Malformed ids from URLs and action
 * arguments reach queries unchecked").
 *
 * A server action is a public endpoint: a crafted call can post any string.
 * Before, each of these sent it to PostgREST, which answers 22P02 — and
 * `moveDealToStage` handed Postgres' own "invalid input syntax for type uuid"
 * back to the toast. The database is a tripwire here: every client factory
 * throws, so an action that reaches one fails with that error instead of its
 * refusal, and a well-formed id must still reach it, as before.
 *
 * `renewMandate` (lib/actions/mandates.ts) is the fourteenth such action and
 * is deferred: that file is being changed by another branch.
 */

const createClient = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("REACHED THE DATABASE");
  }),
);
const createAdminClient = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("REACHED THE SERVICE ROLE");
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => {
    throw new Error("REACHED THE PROFILE READ");
  },
}));
vi.mock("@/lib/services/events", () => ({ logEvent: vi.fn(), logEvents: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { moveDealToStage } = await import("@/lib/actions/deals");
const leads = await import("@/lib/actions/leads");
const { deleteMedia, deleteMediaBulk } = await import("@/lib/actions/media");
const { archiveProperty, restoreProperty } = await import("@/lib/actions/properties");
const { listKeyMovements } = await import("@/lib/actions/keys");
const { getPartyDefaults } = await import("@/lib/actions/party-defaults");

const ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c01";
const ID2 = "00000000-0000-0000-0000-000000000001"; // the hosted organisation's shape: strict uuid() refuses it
const MALFORMED = ["not-a-uuid", "lead-1", "", `${ID},x`, "00000000-0000-0000-0000-00000000000"];

/** Settle a call either way, so a refusal by throw and a refusal by answer read alike. */
async function settle(call: () => Promise<unknown>): Promise<{ value?: unknown; thrown?: string }> {
  try {
    return { value: await call() };
  } catch (e) {
    return { thrown: e instanceof Error ? e.message : String(e) };
  }
}

type Case = {
  name: string;
  /** the call with one malformed id in place */
  bad: (bad: string) => Promise<unknown>;
  /** what the refusal looks like, in the action's own shape */
  refusal: { value?: unknown; thrown?: string };
  /** the same call with well-formed ids */
  good: () => Promise<unknown>;
};

const CASES: Case[] = [
  {
    name: "moveDealToStage — the deal id",
    bad: (bad) => moveDealToStage(bad, ID),
    refusal: { value: { error: "Deal not found" } },
    good: () => moveDealToStage(ID, ID2),
  },
  {
    name: "moveDealToStage — the stage id",
    bad: (bad) => moveDealToStage(ID, bad),
    refusal: { value: { error: "Stage not found" } },
    good: () => moveDealToStage(ID, ID2),
  },
  {
    name: "claimLead",
    bad: (bad) => leads.claimLead(bad),
    refusal: { thrown: "Lead not found" },
    good: () => leads.claimLead(ID),
  },
  {
    name: "markContacted",
    bad: (bad) => leads.markContacted(bad),
    refusal: { thrown: "Lead not found" },
    good: () => leads.markContacted(ID),
  },
  {
    name: "markCalled",
    bad: (bad) => leads.markCalled(bad),
    refusal: { thrown: "Lead not found" },
    good: () => leads.markCalled(ID),
  },
  {
    name: "reassignLead — the lead id",
    bad: (bad) => leads.reassignLead(bad, ID2),
    refusal: { thrown: "Lead not found" },
    good: () => leads.reassignLead(ID, ID2),
  },
  {
    name: "reassignLead — the agent id",
    bad: (bad) => leads.reassignLead(ID, bad),
    refusal: { thrown: "Pick an active agent." },
    good: () => leads.reassignLead(ID, ID2),
  },
  {
    name: "redactLead",
    bad: (bad) => leads.redactLead(bad),
    refusal: { value: { error: "Lead not found" } },
    good: () => leads.redactLead(ID),
  },
  {
    name: "retryEnquiryAlert",
    bad: (bad) => leads.retryEnquiryAlert(bad),
    refusal: { thrown: "Lead not found" },
    good: () => leads.retryEnquiryAlert(ID),
  },
  {
    name: "createContactFromEnquiry",
    bad: (bad) => leads.createContactFromEnquiry(bad),
    refusal: { value: { error: "Lead not found", savedAt: null } },
    good: () => leads.createContactFromEnquiry(ID),
  },
  {
    name: "deleteMedia — the property id",
    bad: (bad) => deleteMedia(bad, ID2),
    refusal: { value: { error: "Photo not found" } },
    good: () => deleteMedia(ID, ID2),
  },
  {
    name: "deleteMedia — the photo id",
    bad: (bad) => deleteMedia(ID, bad),
    refusal: { value: { error: "Photo not found" } },
    good: () => deleteMedia(ID, ID2),
  },
  {
    name: "deleteMediaBulk — the property id",
    bad: (bad) => deleteMediaBulk(bad, [ID2]),
    refusal: { value: { error: "Photo not found", deleted: 0 } },
    good: () => deleteMediaBulk(ID, [ID2]),
  },
  {
    name: "deleteMediaBulk — one photo id among good ones",
    bad: (bad) => deleteMediaBulk(ID, [ID2, bad]),
    refusal: { value: { error: "Photo not found", deleted: 0 } },
    good: () => deleteMediaBulk(ID, [ID2, ID]),
  },
  {
    name: "archiveProperty",
    bad: (bad) => archiveProperty(bad),
    refusal: { value: { error: "Property not found" } },
    good: () => archiveProperty(ID),
  },
  {
    name: "restoreProperty",
    bad: (bad) => restoreProperty(bad),
    refusal: { value: { error: "Property not found" } },
    good: () => restoreProperty(ID),
  },
  {
    name: "listKeyMovements",
    bad: (bad) => listKeyMovements(bad),
    // its "nothing to show" is an empty trail
    refusal: { value: [] },
    good: () => listKeyMovements(ID),
  },
  {
    name: "getPartyDefaults",
    bad: (bad) => getPartyDefaults(bad),
    // no prefill at all: not a party, and not worth the office read either
    refusal: { value: { defaults: {}, source: {}, partyName: null } },
    good: () => getPartyDefaults(ID),
  },
];

// moveDealToStage logs what a throw said (here: the tripwire) and never shows it
vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  createClient.mockClear();
  createAdminClient.mockClear();
});

describe("an action refuses a malformed id before it reaches the database", () => {
  for (const c of CASES) {
    it(`${c.name}: refused in its own shape, no client built`, async () => {
      for (const bad of MALFORMED) {
        expect(await settle(() => c.bad(bad)), `${c.name} with "${bad}"`).toEqual(c.refusal);
      }
      expect(createClient).not.toHaveBeenCalled();
      expect(createAdminClient).not.toHaveBeenCalled();
    });

    it(`${c.name}: a well-formed id still goes to the database`, async () => {
      await settle(c.good);
      expect(createClient).toHaveBeenCalledTimes(1);
    });
  }

  it("a crafted non-string id is refused too (a server action's arguments are whatever was posted)", async () => {
    for (const bad of [null, undefined, 42, {}, [ID]] as unknown as string[]) {
      expect(await settle(() => moveDealToStage(bad, ID))).toEqual({ value: { error: "Deal not found" } });
      expect(await settle(() => leads.claimLead(bad))).toEqual({ thrown: "Lead not found" });
      expect(await settle(() => archiveProperty(bad))).toEqual({ value: { error: "Property not found" } });
    }
    expect(await settle(() => deleteMediaBulk(ID, "x" as unknown as string[]))).toEqual({
      value: { error: "Photo not found", deleted: 0 },
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("getPartyDefaults(null) still reads the office's terms — no contact is not a malformed contact", async () => {
    await settle(() => getPartyDefaults(null));
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("deleteMediaBulk of nothing still answers 'nothing deleted' without a query", async () => {
    expect(await deleteMediaBulk(ID, [])).toEqual({ error: null, deleted: 0 });
    expect(createClient).not.toHaveBeenCalled();
  });
});
