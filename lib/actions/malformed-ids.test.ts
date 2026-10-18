import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUID_SHAPES } from "@/lib/testing/guid-shapes";

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
 * refusal, and a well-formed id must still reach it, as before — an id of
 * EVERY shape in GUID_SHAPES, in every argument: the hosted organisation's id
 * and the seed ids are what a call site that slipped to the strict z.uuid()
 * would refuse (DECISIONS T3.2), and an RFC v4 id alone cannot show that.
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
  /** the same call with EVERY id argument `id` — run once per shape in GUID_SHAPES */
  good: (id: string) => Promise<unknown>;
};

const CASES: Case[] = [
  {
    name: "moveDealToStage — the deal id",
    bad: (bad) => moveDealToStage(bad, ID),
    refusal: { value: { error: "Deal not found" } },
    good: (id) => moveDealToStage(id, id),
  },
  {
    name: "moveDealToStage — the stage id",
    bad: (bad) => moveDealToStage(ID, bad),
    refusal: { value: { error: "Stage not found" } },
    good: (id) => moveDealToStage(id, id),
  },
  {
    name: "claimLead",
    bad: (bad) => leads.claimLead(bad),
    refusal: { thrown: "Lead not found" },
    good: (id) => leads.claimLead(id),
  },
  {
    name: "markContacted",
    bad: (bad) => leads.markContacted(bad),
    refusal: { thrown: "Lead not found" },
    good: (id) => leads.markContacted(id),
  },
  {
    name: "markCalled",
    bad: (bad) => leads.markCalled(bad),
    refusal: { thrown: "Lead not found" },
    good: (id) => leads.markCalled(id),
  },
  {
    name: "reassignLead — the lead id",
    bad: (bad) => leads.reassignLead(bad, ID2),
    refusal: { thrown: "Lead not found" },
    good: (id) => leads.reassignLead(id, id),
  },
  {
    name: "reassignLead — the agent id",
    bad: (bad) => leads.reassignLead(ID, bad),
    refusal: { thrown: "Pick an active agent." },
    good: (id) => leads.reassignLead(id, id),
  },
  {
    name: "redactLead",
    bad: (bad) => leads.redactLead(bad),
    refusal: { value: { error: "Lead not found" } },
    good: (id) => leads.redactLead(id),
  },
  {
    name: "retryEnquiryAlert",
    bad: (bad) => leads.retryEnquiryAlert(bad),
    refusal: { thrown: "Lead not found" },
    good: (id) => leads.retryEnquiryAlert(id),
  },
  {
    name: "createContactFromEnquiry",
    bad: (bad) => leads.createContactFromEnquiry(bad),
    refusal: { value: { error: "Lead not found", savedAt: null } },
    good: (id) => leads.createContactFromEnquiry(id),
  },
  {
    name: "saveSearchFromEnquiry",
    bad: (bad) => leads.saveSearchFromEnquiry(bad),
    refusal: { value: { error: "Lead not found", savedAt: null } },
    good: (id) => leads.saveSearchFromEnquiry(id),
  },
  {
    name: "deleteMedia — the property id",
    bad: (bad) => deleteMedia(bad, ID2),
    refusal: { value: { error: "Photo not found" } },
    good: (id) => deleteMedia(id, id),
  },
  {
    name: "deleteMedia — the photo id",
    bad: (bad) => deleteMedia(ID, bad),
    refusal: { value: { error: "Photo not found" } },
    good: (id) => deleteMedia(id, id),
  },
  {
    name: "deleteMediaBulk — the property id",
    bad: (bad) => deleteMediaBulk(bad, [ID2]),
    refusal: { value: { error: "Photo not found", deleted: 0 } },
    good: (id) => deleteMediaBulk(id, [id]),
  },
  {
    name: "deleteMediaBulk — one photo id among good ones",
    bad: (bad) => deleteMediaBulk(ID, [ID2, bad]),
    refusal: { value: { error: "Photo not found", deleted: 0 } },
    good: (id) => deleteMediaBulk(id, [ID, id]),
  },
  {
    name: "archiveProperty",
    bad: (bad) => archiveProperty(bad),
    refusal: { value: { error: "Property not found" } },
    good: (id) => archiveProperty(id),
  },
  {
    name: "restoreProperty",
    bad: (bad) => restoreProperty(bad),
    refusal: { value: { error: "Property not found" } },
    good: (id) => restoreProperty(id),
  },
  {
    name: "listKeyMovements",
    bad: (bad) => listKeyMovements(bad),
    // its "nothing to show" is an empty trail
    refusal: { value: [] },
    good: (id) => listKeyMovements(id),
  },
  {
    name: "getPartyDefaults",
    bad: (bad) => getPartyDefaults(bad),
    // no prefill at all: not a party, and not worth the office read either
    refusal: { value: { defaults: {}, source: {}, partyName: null } },
    good: (id) => getPartyDefaults(id),
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

    it(`${c.name}: a well-formed id of every shape still goes to the database`, async () => {
      for (const [i, id] of GUID_SHAPES.entries()) {
        await settle(() => c.good(id));
        expect(createClient, `${c.name} with ${id}`).toHaveBeenCalledTimes(i + 1);
      }
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
