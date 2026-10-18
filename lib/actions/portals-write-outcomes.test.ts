import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_CONFIRMED_NOTICE, NOT_RECORDED_NOTICE } from "@/lib/services/optimistic-save";
import { PORTAL_PROPERTY_COLUMNS } from "@/lib/services/portals/property-portals";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * WHAT A PORTAL WRITE'S ANSWER PROVES (portal integrations audit 2026-10-18,
 * findings 4, 7 and 8 — lib/actions/portals.ts header).
 *
 * A non-empty RETURNING is a commit; an empty one, or an error whose code
 * `certainlyRolledBack` understands, is a refusal; anything else — no code, a
 * code that can follow a commit, an answer with no rows array — is UNKNOWN:
 * the write may have landed. These tests pin what each action does with each
 * of the three, and in particular the one that matters most:
 *
 *   A TOKEN WRITE WHOSE ANSWER IS UNKNOWN IS READ BACK BY ITS DIGEST. The
 *   column is unique, so finding sha256(this token) proves this attempt
 *   committed and the URL may be shown; not finding it — or not being able to
 *   ask — shows NO URL, because an unconfirmed URL handed to a portal may be
 *   dead, and the old one may already be.
 *
 * Plus the preview gate (finding 8), the server-side eligibility re-check on
 * select (finding 7), the "a committed write whose line fails is a notice,
 * not a throw" rule for the three actions one-time-secrets.test.ts does not
 * cover, and the array reads that make a hollow answer an error.
 *
 * Driven through the REAL actions and the REAL logEvent: the `events` insert
 * is answered as PostgREST would answer it, so a line "written" is a line the
 * action asked the events table for, and a failing line throws EventWriteError
 * exactly as in production.
 */

const state = vi.hoisted(() => ({ client: null as unknown, role: "admin" as string }));
const getCurrentProfile = vi.hoisted(() =>
  vi.fn(async () => ({ id: "actor-1", orgId: "org-1", role: state.role, fullName: "A. Actor" })),
);
const revalidatePath = vi.hoisted(() => vi.fn<(path: string) => void>());

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({ getCurrentProfile }));
vi.mock("next/cache", () => ({ revalidatePath }));

const { deselectPortal, regeneratePortalToken, savePortalSettings, selectPortal, setPortalEnabled } =
  await import("@/lib/actions/portals");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const PORTAL_PATH = "/settings/portals";
const PROPERTY_PATH = "/properties/prop-1";

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV;
const restoreVercelEnv = () => {
  if (ORIGINAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV;
};

beforeEach(() => {
  // Every test but the preview ones runs as a local `next dev` (VERCEL_ENV
  // unset), whatever the shell running vitest happens to export.
  delete process.env.VERCEL_ENV;
  getCurrentProfile.mockClear();
  revalidatePath.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(restoreVercelEnv);
afterAll(restoreVercelEnv);

function setup(pages: Record<string, FakePage[]>, role = "admin") {
  const fake = fakeClient(pages);
  state.client = fake.client;
  state.role = role;
  return fake;
}
type Fake = ReturnType<typeof setup>;

/** every write the action attempted on a table */
const writesTo = (fake: Fake, table: string) =>
  fake.calls.filter((c) => c.table === table && ["insert", "update", "delete", "upsert"].includes(c.method));
/** the event rows the action asked to write, by type */
const linesWritten = (fake: Fake) =>
  fake.argsOf("events", "insert").map((args) => (args[0] as { event_type: string }).event_type);
/** the digests a read-back asked portal_connections for */
const readBackDigests = (fake: Fake) =>
  fake
    .argsOf("portal_connections", "eq")
    .filter(([column]) => column === "feed_token_sha256")
    .map(([, value]) => value);
/** the digest the action's write stored (insert or update payload) */
const digestWritten = (fake: Fake, method: "insert" | "update") =>
  (fake.argsOf("portal_connections", method)[0]![0] as { feed_token_sha256: string }).feed_token_sha256;
/** no plaintext token, and no digest, anywhere in what goes back to the card */
const holdsNoToken = (res: object) => !/[0-9a-f]{64}/.test(JSON.stringify(res));

/** answers to a write under which it MAY have committed */
const UNKNOWN_WRITE: [string, FakePage][] = [
  ["an error with no code (a network failure)", { data: null, error: { message: "fetch failed" } }],
  ["an error whose code is ''", { data: null, error: { message: "Fixture: gateway body", code: "" } }],
  ["XX000, which can be reported for a commit", { data: null, error: { message: "Fixture: internal error", code: "XX000" } }],
  ["rows that are not an array", { data: { id: "conn-1" }, error: null }],
  ["no rows array at all (a hollow 204)", { data: null, error: null, status: 204 }],
];
/** answers under which the write certainly did not commit */
const REFUSED_WRITE: [string, FakePage][] = [
  ["42501", { data: null, error: { message: "Fixture: permission denied", code: "42501" } }],
  ["23514", { data: null, error: { message: "Fixture: check constraint violated", code: "23514" } }],
  ["an empty RETURNING", { data: [], error: null }],
];
/** an `events` insert that fails, with the notice the committed action must hand back */
const EVENT_FAILURES: [string, FakePage, string][] = [
  [
    "42501, a certain refusal",
    { data: null, error: { message: 'new row violates row-level security policy for table "events"', code: "42501" } },
    NOT_RECORDED_NOTICE,
  ],
  ["XX000, which may follow a written line", { data: null, error: { message: "Fixture: internal error", code: "XX000" } }, NOT_CONFIRMED_NOTICE],
  ["a hollow 204 that never said Created", { data: null, error: null, status: 204 }, NOT_CONFIRMED_NOTICE],
];

const NO_CONNECTION: FakePage = { data: [], error: null };
const CONNECTED: FakePage = { data: [{ id: "conn-1", settings: {}, feed_token_sha256: "b".repeat(64) }], error: null };
const CONNECTED_WITHOUT_TOKEN: FakePage = { data: [{ id: "conn-1", settings: {}, feed_token_sha256: null }], error: null };
const COMMITTED: FakePage = { data: [{ id: "conn-1" }], error: null };
const FOUND: FakePage = { data: [{ id: "conn-1" }], error: null };

const settingsForm = () => {
  const fd = new FormData();
  fd.set("portal", "jamesedition");
  fd.set("contact_number", "+357 26 000000");
  fd.set("email", "sales@example.com");
  return fd;
};
const BLANK = { error: null, savedAt: null };

/** A listing JamesEdition would receive — every field the eligibility re-check reads. */
const eligibleListing = (over: Record<string, unknown> = {}) => ({
  id: "prop-1",
  reference: "PAF0001",
  org_id: "org-1",
  visibility: "public",
  status: "available",
  transaction_type: "sale",
  asking_price: 950_000,
  rent_price_month: null,
  currency: "EUR",
  public_description: { en: "A villa above the sea." },
  property_type: "villa",
  location: null,
  location_approx: false,
  districts: { name: { en: "Paphos" } },
  areas: null,
  ...over,
});
/** a JPEG-prepared photo; 2400×1600 delivers 1600×1067, over JamesEdition's 800×600 */
const photo = (over: Record<string, unknown> = {}) => ({
  kind: "photo",
  path_jpeg: "org-1/prop-1/a.jpg",
  width: 2400,
  height: 1600,
  ...over,
});

function selectPages(o: { listing?: object; media?: FakePage; insert?: FakePage; events?: FakePage } = {}) {
  return {
    properties: [{ data: [o.listing ?? eligibleListing()], error: null }],
    portal_connections: [{ data: [{ enabled: true }], error: null }],
    property_media: [o.media ?? { data: [photo(), photo({ path_jpeg: "org-1/prop-1/b.jpg" })], error: null }],
    portal_listings: [o.insert ?? { data: [{ portal: "jamesedition" }], error: null }],
    ...(o.events ? { events: [o.events] } : {}),
  } satisfies Record<string, FakePage[]>;
}

/* ------------------------------------------------------------------ */
/* (1) a preview deployment manages no connection                       */
/* ------------------------------------------------------------------ */

describe("the preview gate (finding 8)", () => {
  const CONNECTION_WRITES = [
    ["setPortalEnabled (enable)", () => setPortalEnabled("jamesedition", true)],
    ["setPortalEnabled (disable)", () => setPortalEnabled("jamesedition", false)],
    ["regeneratePortalToken", () => regeneratePortalToken("jamesedition")],
    ["savePortalSettings", () => savePortalSettings(BLANK, settingsForm())],
  ] as const;

  /*
   * A URL minted on a preview is shown once and points nowhere a portal
   * should go; a Regenerate on a preview that shares production's database
   * would kill production's live URL. So the refusal must come before the
   * session is even resolved — getCurrentProfile is itself a database read.
   */
  describe.each(["preview", "development"])("VERCEL_ENV=%s", (env) => {
    it.each(CONNECTION_WRITES)("%s refuses before any database call", async (_label, run) => {
      process.env.VERCEL_ENV = env;
      const fake = setup({
        portal_connections: [CONNECTED, COMMITTED, FOUND],
      });
      const res = await run();
      expect(res.error).toMatch(/preview deployment/i);
      expect(res.savedAt).toBeNull();
      expect(holdsNoToken(res), "no URL is issued on a preview").toBe(true);
      expect(getCurrentProfile, "not even the session's profile is read").not.toHaveBeenCalled();
      expect(fake.calls, "the database is never asked").toHaveLength(0);
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  });

  it("control: VERCEL_ENV=production manages connections (the gate is not a blanket refusal)", async () => {
    process.env.VERCEL_ENV = "production";
    const fake = setup({ portal_connections: [COMMITTED] });
    const res = await regeneratePortalToken("jamesedition");
    expect(res.error).toBeNull();
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(writesTo(fake, "portal_connections")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* (2) Regenerate with an answer that proves nothing                   */
/* ------------------------------------------------------------------ */

describe("regeneratePortalToken — an unknown answer is read back by the token's digest", () => {
  it.each(UNKNOWN_WRITE)(
    "answered %s, and the read-back FINDS the digest: the token comes back and the line is written",
    async (_label, answer) => {
      const fake = setup({ portal_connections: [answer, FOUND] });
      const res = await regeneratePortalToken("jamesedition");
      expect(res.error).toBeNull();
      expect(res.token).toMatch(/^[0-9a-f]{64}$/);
      const stored = digestWritten(fake, "update");
      expect(sha256(res.token!), "the token whose digest the update carried").toBe(stored);
      expect(readBackDigests(fake), "read back by THIS token's digest, once").toEqual([stored]);
      expect(fake.argsOf("portal_connections", "eq"), "on this portal").toContainEqual(["portal", "jamesedition"]);
      expect(writesTo(fake, "portal_connections"), "a read, never a second write").toHaveLength(1);
      expect(linesWritten(fake)).toEqual(["portal_token_regenerated"]);
      expect(res.notice ?? null).toBeNull();
      expect(res.discardIssued ?? false).toBe(false);
      expect(revalidatePath).toHaveBeenCalledWith(PORTAL_PATH);
    },
  );

  const NOT_CONFIRMED_READS: [string, FakePage][] = [
    ["finds no row", { data: [], error: null }],
    ["fails", { data: null, error: { message: "Fixture: read failed" } }],
    ["answers no rows array", { data: null, error: null }],
  ];

  describe.each(UNKNOWN_WRITE)("answered %s", (_label, answer) => {
    it.each(NOT_CONFIRMED_READS)(
      "and the read-back %s: NO token, the Regenerate text, discardIssued, no line, still revalidated",
      async (_readLabel, readBack) => {
        const fake = setup({ portal_connections: [answer, readBack] });
        const res = await regeneratePortalToken("jamesedition");
        expect(res.token ?? null, "an unconfirmed URL is never shown").toBeNull();
        expect(holdsNoToken(res)).toBe(true);
        expect(res.savedAt).toBeNull();
        expect(res.error).toMatch(/new feed URL could not be confirmed/i);
        expect(res.error, "the way out is named").toMatch(/Regenerate/);
        expect(res.discardIssued, "the card must stop showing a URL it issued earlier").toBe(true);
        expect(readBackDigests(fake)).toEqual([digestWritten(fake, "update")]);
        expect(linesWritten(fake), "an unproven rotation is not put on the chain").toEqual([]);
        expect(revalidatePath, "the page may now show a rotated row").toHaveBeenCalledWith(PORTAL_PATH);
      },
    );
  });

  it.each(REFUSED_WRITE)("a certain refusal (%s) fails with no read-back", async (_label, answer) => {
    const fake = setup({ portal_connections: [answer, FOUND] });
    const res = await regeneratePortalToken("jamesedition");
    expect(res.error).toBeTruthy();
    expect(res.token ?? null).toBeNull();
    expect(res.discardIssued ?? false, "a refused rotation left the old URL live").toBe(false);
    expect(readBackDigests(fake), "nothing to reconcile: it certainly did not commit").toEqual([]);
    expect(fake.served.portal_connections).toBe(1);
    expect(linesWritten(fake)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* (3) the enable switch: minting writes reconcile, a toggle does not  */
/* ------------------------------------------------------------------ */

describe("setPortalEnabled — an unknown answer", () => {
  describe("on a FIRST enable (the INSERT mints the URL)", () => {
    it.each(UNKNOWN_WRITE)("answered %s, found by digest: the token and the line", async (_label, answer) => {
      const fake = setup({ portal_connections: [NO_CONNECTION, answer, FOUND] });
      const res = await setPortalEnabled("jamesedition", true);
      expect(res.error).toBeNull();
      const stored = digestWritten(fake, "insert");
      expect(sha256(res.token!)).toBe(stored);
      expect(readBackDigests(fake)).toEqual([stored]);
      expect(writesTo(fake, "portal_connections")).toHaveLength(1);
      expect(linesWritten(fake)).toEqual(["portal_enabled"]);
      expect(res.notice ?? null).toBeNull();
    });

    it.each(UNKNOWN_WRITE)(
      "answered %s, NOT found: no token, the ENABLE text, discardIssued, no line, revalidated",
      async (_label, answer) => {
        const fake = setup({ portal_connections: [NO_CONNECTION, answer, { data: [], error: null }] });
        const res = await setPortalEnabled("jamesedition", true);
        expect(res.token ?? null).toBeNull();
        expect(holdsNoToken(res)).toBe(true);
        expect(res.error).toMatch(/Enabling could not be confirmed/i);
        expect(res.error).toMatch(/Regenerate/);
        expect(res.discardIssued).toBe(true);
        expect(readBackDigests(fake)).toEqual([digestWritten(fake, "insert")]);
        expect(linesWritten(fake)).toEqual([]);
        expect(revalidatePath).toHaveBeenCalledWith(PORTAL_PATH);
      },
    );

    it("answered XX000 and the read-back fails: the same — no token, discardIssued", async () => {
      const fake = setup({
        portal_connections: [
          NO_CONNECTION,
          { data: null, error: { message: "Fixture: internal error", code: "XX000" } },
          { data: null, error: { message: "Fixture: read failed" } },
        ],
      });
      const res = await setPortalEnabled("jamesedition", true);
      expect(res.token ?? null).toBeNull();
      expect(res.error).toMatch(/Enabling could not be confirmed/i);
      expect(res.discardIssued).toBe(true);
      expect(linesWritten(fake)).toEqual([]);
    });

    it.each(REFUSED_WRITE)("a certain refusal (%s) fails with no read-back and no token", async (_label, answer) => {
      const fake = setup({ portal_connections: [NO_CONNECTION, answer, FOUND] });
      const res = await setPortalEnabled("jamesedition", true);
      expect(res.error).toBeTruthy();
      expect(res.token ?? null).toBeNull();
      expect(res.discardIssued ?? false).toBe(false);
      expect(readBackDigests(fake)).toEqual([]);
      expect(linesWritten(fake)).toEqual([]);
    });
  });

  it("an enable of a row with NO token yet mints on the UPDATE — reconciled the same way", async () => {
    // Settings saved before the switch leave a disabled row with no digest;
    // the enable's UPDATE is then a minting write, and an unknown answer to it
    // is as dangerous as one to the insert.
    const fake = setup({
      portal_connections: [CONNECTED_WITHOUT_TOKEN, { data: null, error: { message: "fetch failed" } }, { data: [], error: null }],
    });
    const res = await setPortalEnabled("jamesedition", true);
    expect(res.token ?? null).toBeNull();
    expect(res.error).toMatch(/Enabling could not be confirmed/i);
    expect(res.discardIssued).toBe(true);
    expect(readBackDigests(fake)).toEqual([digestWritten(fake, "update")]);
    expect(linesWritten(fake)).toEqual([]);
  });

  describe.each([
    ["enable", true],
    ["disable", false],
  ] as const)("a plain toggle (%s of a row that has its token — nothing minted)", (_label, enabled) => {
    it.each(UNKNOWN_WRITE)(
      "answered %s: 'could not be confirmed', no read-back, no line, revalidated",
      async (_answerLabel, answer) => {
        const fake = setup({ portal_connections: [CONNECTED, answer, FOUND] });
        const res = await setPortalEnabled("jamesedition", enabled);
        expect(res.savedAt).toBeNull();
        expect(res.error).toMatch(/could not be confirmed/i);
        expect(res.error, "no URL is in play, so Regenerate is not the advice").not.toMatch(/Regenerate/);
        expect(res.token ?? null).toBeNull();
        expect(res.discardIssued ?? false, "the stored URL was never touched").toBe(false);
        expect(readBackDigests(fake), "no token to look for").toEqual([]);
        expect(fake.served.portal_connections, "the read and the write, nothing after").toBe(2);
        expect(linesWritten(fake)).toEqual([]);
        expect(revalidatePath).toHaveBeenCalledWith(PORTAL_PATH);
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* (4) a refusal always carries words                                  */
/* ------------------------------------------------------------------ */

describe("fail() never hands back an empty error", () => {
  // Both cards read `error: ""` as success (it is falsy), so a refusal whose
  // database message is empty must still say something.
  const EMPTY_REFUSALS: [string, FakePage][] = [
    ["an empty message", { data: null, error: { message: "", code: "42501" } }],
    ["a whitespace message", { data: null, error: { message: "   ", code: "42501" } }],
  ];

  describe.each(EMPTY_REFUSALS)("a write refused (42501) with %s", (_label, refusal) => {
    const cases = [
      ["setPortalEnabled (insert)", { portal_connections: [NO_CONNECTION, refusal] }, () => setPortalEnabled("jamesedition", true)],
      ["setPortalEnabled (update)", { portal_connections: [CONNECTED, refusal] }, () => setPortalEnabled("jamesedition", false)],
      ["savePortalSettings", { portal_connections: [{ data: [{ id: "conn-1" }], error: null }, refusal] }, () => savePortalSettings(BLANK, settingsForm())],
      ["regeneratePortalToken", { portal_connections: [refusal] }, () => regeneratePortalToken("jamesedition")],
      ["deselectPortal", { properties: [{ data: [eligibleListing()], error: null }], portal_listings: [refusal] }, () => deselectPortal("prop-1", "jamesedition")],
    ] as const;

    it.each(cases)("%s", async (_name, pages, run) => {
      const fake = setup(pages as unknown as Record<string, FakePage[]>);
      const res = await run();
      expect(typeof res.error).toBe("string");
      expect(res.error!.trim(), "the desk is told something").not.toBe("");
      expect(res.savedAt).toBeNull();
      expect(linesWritten(fake)).toEqual([]);
    });
  });

  it("selectPortal: a refusal past the 42501 branch (23514) with an empty message still has words", async () => {
    const fake = setup(selectPages({ insert: { data: null, error: { message: "", code: "23514" } } }));
    const res = await selectPortal("prop-1", "jamesedition");
    expect(res.error?.trim()).toBeTruthy();
    expect(linesWritten(fake)).toEqual([]);
  });

  it("a connection read failing with an empty message still has words", async () => {
    setup({ portal_connections: [{ data: null, error: { message: "" } }] });
    const res = await setPortalEnabled("jamesedition", false);
    expect(res.error?.trim()).toBeTruthy();
  });

  // Fixed after review: a CERTAIN refusal whose message is empty used to be
  // worded as an UNKNOWN outcome (`?? fallback` kept the ""); classifyWrite
  // now treats an empty message as no words, so the refusal's own sentence applies.
  it("a certain refusal with an empty message gets the refusal's words, not the unknown-outcome sentence", async () => {
    setup({ portal_connections: [NO_CONNECTION, { data: null, error: { message: "", code: "42501" } }] });
    const res = await setPortalEnabled("jamesedition", true);
    expect(res.error).toMatch(/nothing changed|your role/i);
    expect(res.error).not.toMatch(/did not answer clearly/i);
  });
});

/* ------------------------------------------------------------------ */
/* (5) a committed write whose line fails is a notice, never a throw   */
/* ------------------------------------------------------------------ */

describe("a committed write whose timeline line fails", () => {
  describe("savePortalSettings", () => {
    it.each(EVENT_FAILURES)("line fails (%s): ok WITH the notice, revalidated, nothing undone", async (_label, events, notice) => {
      const fake = setup({ portal_connections: [{ data: [{ id: "conn-1" }], error: null }, COMMITTED], events: [events] });
      const res = await savePortalSettings(BLANK, settingsForm());
      expect(res.error).toBeNull();
      expect(res.savedAt).not.toBeNull();
      expect(res.notice).toBe(notice);
      expect(linesWritten(fake), "the line was attempted once").toEqual(["portal_settings_updated"]);
      expect(writesTo(fake, "portal_connections"), "the saved settings are not rolled back").toHaveLength(1);
      expect(revalidatePath).toHaveBeenCalledWith(PORTAL_PATH);
    });

    it("control: the line lands — no notice", async () => {
      setup({ portal_connections: [{ data: [{ id: "conn-1" }], error: null }, COMMITTED] });
      const res = await savePortalSettings(BLANK, settingsForm());
      expect(res.error).toBeNull();
      expect(res.notice ?? null).toBeNull();
    });

    it.each(UNKNOWN_WRITE)("an unknown answer to the save (%s): 'could not be confirmed', no line", async (_label, answer) => {
      const fake = setup({ portal_connections: [{ data: [{ id: "conn-1" }], error: null }, answer] });
      const res = await savePortalSettings(BLANK, settingsForm());
      expect(res.savedAt).toBeNull();
      expect(res.error).toMatch(/could not be confirmed/i);
      expect(linesWritten(fake)).toEqual([]);
      expect(revalidatePath).toHaveBeenCalledWith(PORTAL_PATH);
    });
  });

  describe("selectPortal", () => {
    it.each(EVENT_FAILURES)("line fails (%s): ok WITH the notice, revalidated, the selection kept", async (_label, events, notice) => {
      const fake = setup(selectPages({ events }));
      const res = await selectPortal("prop-1", "jamesedition");
      expect(res.error).toBeNull();
      expect(res.savedAt).not.toBeNull();
      expect(res.notice).toBe(notice);
      expect(linesWritten(fake)).toEqual(["portal_selected"]);
      expect(writesTo(fake, "portal_listings"), "the insert, and no delete after it").toHaveLength(1);
      expect(revalidatePath).toHaveBeenCalledWith(PROPERTY_PATH);
    });

    it.each(UNKNOWN_WRITE)("an unknown answer to the insert (%s): 'could not be confirmed', no line", async (_label, answer) => {
      const fake = setup(selectPages({ insert: answer }));
      const res = await selectPortal("prop-1", "jamesedition");
      expect(res.savedAt).toBeNull();
      expect(res.error).toMatch(/could not be confirmed/i);
      expect(linesWritten(fake)).toEqual([]);
      expect(revalidatePath).toHaveBeenCalledWith(PROPERTY_PATH);
    });
  });

  describe("deselectPortal", () => {
    const deselectPages = (o: { del?: FakePage; events?: FakePage } = {}) => ({
      properties: [{ data: [eligibleListing()], error: null }],
      portal_listings: [o.del ?? { data: [{ portal: "jamesedition" }], error: null }],
      ...(o.events ? { events: [o.events] } : {}),
    });

    it.each(EVENT_FAILURES)("line fails (%s): ok WITH the notice, revalidated, the removal kept", async (_label, events, notice) => {
      const fake = setup(deselectPages({ events }));
      const res = await deselectPortal("prop-1", "jamesedition");
      expect(res.error).toBeNull();
      expect(res.savedAt).not.toBeNull();
      expect(res.notice).toBe(notice);
      expect(linesWritten(fake)).toEqual(["portal_removed"]);
      expect(writesTo(fake, "portal_listings"), "the delete, and no re-insert").toHaveLength(1);
      expect(revalidatePath).toHaveBeenCalledWith(PROPERTY_PATH);
    });

    /* (7) */
    it.each(UNKNOWN_WRITE)(
      "an unknown answer to the delete (%s): 'could not be confirmed', no line, and NO read-back",
      async (_label, answer) => {
        // An absent row afterwards could be someone else's removal, with its
        // own line; nothing would prove THIS delete did it.
        const fake = setup(deselectPages({ del: answer }));
        const res = await deselectPortal("prop-1", "jamesedition");
        expect(res.savedAt).toBeNull();
        expect(res.error).toMatch(/could not be confirmed/i);
        expect(linesWritten(fake)).toEqual([]);
        expect(fake.served.portal_listings, "the delete only — nothing read back").toBe(1);
        expect(fake.calls.filter((c) => c.table === "portal_listings" && c.method === "delete")).toHaveLength(1);
        expect(revalidatePath).toHaveBeenCalledWith(PROPERTY_PATH);
      },
    );
  });
});

/* ------------------------------------------------------------------ */
/* (6) select re-checks the portal's eligibility on the server         */
/* ------------------------------------------------------------------ */

describe("selectPortal — eligibility is re-checked server-side (finding 7)", () => {
  const noInsert = (fake: Fake) => fake.calls.filter((c) => c.table === "portal_listings" && c.method === "insert");

  it("reads the eligibility columns and the listing's photos, scoped to the listing", async () => {
    const fake = setup(selectPages());
    await selectPortal("prop-1", "jamesedition");
    const columns = fake.argsOf("properties", "select")[0]![0] as string;
    expect(columns, "the same columns the card's adapter reads").toContain(PORTAL_PROPERTY_COLUMNS);
    expect(fake.argsOf("properties", "eq")).toEqual([["id", "prop-1"]]);
    expect(fake.argsOf("property_media", "select")[0]![0]).toMatch(/kind.*path_jpeg.*width.*height/);
    expect(fake.argsOf("property_media", "eq")).toEqual([["property_id", "prop-1"]]);
  });

  it("an eligible listing is inserted and its line written", async () => {
    const fake = setup(selectPages());
    const res = await selectPortal("prop-1", "jamesedition");
    expect(res.error).toBeNull();
    expect(fake.argsOf("portal_listings", "insert")).toEqual([
      [{ org_id: "org-1", property_id: "prop-1", portal: "jamesedition", selected_by: "actor-1" }],
    ]);
    expect(linesWritten(fake)).toEqual(["portal_selected"]);
  });

  const INELIGIBLE: [string, { listing?: object; media?: FakePage }, RegExp][] = [
    ["no English description", { listing: eligibleListing({ public_description: { el: "Βίλα." } }) }, /No English public description/],
    ["only ONE photo (JamesEdition needs 2)", { media: { data: [photo()], error: null } }, /Fewer than 2 photos of at least 800×600 px/],
    [
      "two photos, one under JamesEdition's 800×600 floor",
      { media: { data: [photo(), photo({ width: 640, height: 480 })], error: null } },
      /Fewer than 2 photos of at least 800×600 px/,
    ],
    [
      "two photos, one with no JPEG rendition yet",
      { media: { data: [photo(), photo({ path_jpeg: null })], error: null } },
      /Fewer than 2 photos/,
    ],
    ["a private listing", { listing: eligibleListing({ visibility: "private" }) }, /Not on the website/],
    [
      "a commercial type JamesEdition refuses",
      { listing: eligibleListing({ property_type: "office" }) },
      /residential property only/,
    ],
  ];

  it.each(INELIGIBLE)("refuses %s, with the reason, and does NOT insert", async (_label, o, reason) => {
    const fake = setup(selectPages(o));
    const res = await selectPortal("prop-1", "jamesedition");
    expect(res.savedAt).toBeNull();
    expect(res.error).toMatch(/would not go into JamesEdition's feed/);
    expect(res.error).toMatch(reason);
    expect(noInsert(fake), "a selection the feed would silently exclude is never made").toHaveLength(0);
    expect(linesWritten(fake)).toEqual([]);
  });

  it("names EVERY failing reason, not just the first", async () => {
    const fake = setup(
      selectPages({
        listing: eligibleListing({ public_description: {} }),
        media: { data: [photo()], error: null },
      }),
    );
    const res = await selectPortal("prop-1", "jamesedition");
    expect(res.error).toMatch(/No English public description/);
    expect(res.error).toMatch(/Fewer than 2 photos/);
    expect(noInsert(fake)).toHaveLength(0);
  });

  it.each([
    ["fails", { data: null, error: { message: "Fixture: media read failed" } }],
    ["answers no rows array", { data: null, error: null }],
  ] as [string, FakePage][])("a photo read that %s refuses rather than guessing, and does not insert", async (_label, media) => {
    const fake = setup(selectPages({ media }));
    const res = await selectPortal("prop-1", "jamesedition");
    expect(res.error).toMatch(/photos could not be read/i);
    expect(noInsert(fake)).toHaveLength(0);
  });

  it("23505 (already selected) is still ok — no second line, the page refreshed", async () => {
    const fake = setup(selectPages({ insert: { data: null, error: { message: "duplicate key value", code: "23505" } } }));
    const res = await selectPortal("prop-1", "jamesedition");
    expect(res.error).toBeNull();
    expect(res.savedAt).not.toBeNull();
    expect(linesWritten(fake), "the first selection's line is the one that happened").toEqual([]);
    expect(revalidatePath).toHaveBeenCalledWith(PROPERTY_PATH);
  });
});

/* ------------------------------------------------------------------ */
/* (8) a hollow connection read is an error, not "no row"              */
/* ------------------------------------------------------------------ */

describe("a hollow connection read (data null, no error)", () => {
  it("on a DISABLE is an error — not 'already disabled' for a portal that may still be serving", async () => {
    const fake = setup({ portal_connections: [{ data: null, error: null }, COMMITTED] });
    const res = await setPortalEnabled("jamesedition", false);
    expect(res.error).toMatch(/could not be read/i);
    expect(res.savedAt, "never the 'already true' success").toBeNull();
    expect(writesTo(fake, "portal_connections")).toHaveLength(0);
    expect(linesWritten(fake)).toEqual([]);
  });

  it("on an ENABLE is an error — not a first enable that INSERTs and mints a second URL", async () => {
    const fake = setup({ portal_connections: [{ data: null, error: null }, COMMITTED] });
    const res = await setPortalEnabled("jamesedition", true);
    expect(res.error).toMatch(/could not be read/i);
    expect(res.token ?? null).toBeNull();
    expect(writesTo(fake, "portal_connections")).toHaveLength(0);
  });

  it("on a settings save is an error — not an INSERT beside the row that exists", async () => {
    const fake = setup({ portal_connections: [{ data: null, error: null }, COMMITTED] });
    const res = await savePortalSettings(BLANK, settingsForm());
    expect(res.error).toMatch(/could not be read/i);
    expect(writesTo(fake, "portal_connections")).toHaveLength(0);
  });

  it("on a select is an error — not 'not enabled'", async () => {
    const fake = setup({ ...selectPages(), portal_connections: [{ data: null, error: null }] });
    const res = await selectPortal("prop-1", "jamesedition");
    expect(res.error).toMatch(/could not be read/i);
    expect(fake.calls.filter((c) => c.table === "portal_listings")).toHaveLength(0);
  });
});
