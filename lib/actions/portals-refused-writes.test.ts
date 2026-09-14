import { describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * What the portal actions do when the write is REFUSED, and what they never
 * do to the feed token.
 *
 * 0095 puts two different policies behind these actions. `portal_connections`
 * is admin-only, so a listing manager toggling a portal is refused by the
 * policy — and an app that reported success would leave the settings page
 * showing a portal as enabled while no crawler was ever pointed at it.
 * `portal_listings` carries the properties_update rule verbatim, which for an
 * agent on someone else's listing raises 42501 rather than matching zero rows;
 * both endings are covered below, because one message ("your role") has to be
 * true whichever way the policy says no.
 *
 * THE TOKEN IS THE OTHER HALF. `feed_token` is the whole of a portal's proof,
 * and the database mints it on insert. An `.upsert()` carrying a freshly
 * minted one would hand every enable/disable toggle a NEW feed URL and leave
 * the portal pulling a dead one — silently, with the settings page showing
 * the new URL as if it had always been there. The last test pins the payloads
 * of both branches, which is the only place that mistake is visible.
 *
 * None of this is reachable from the e2e suite, which signs in as an admin on
 * their own org's listings — for whom no policy ever filters anything.
 */

const state = vi.hoisted(() => ({ client: null as unknown, role: "admin" as string }));
// Typed through the generic, not through named parameters: a no-arg vi.fn()
// gives an empty call tuple and tsc refuses `logEvent.mock.calls[0][1]`.
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({
    id: "actor-1",
    orgId: "org-1",
    role: state.role,
    fullName: "A. Actor",
  }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
const revalidatePath = vi.hoisted(() => vi.fn<(path: string) => void>());
vi.mock("next/cache", () => ({ revalidatePath }));

const {
  deselectPortal,
  regeneratePortalToken,
  savePortalSettings,
  selectPortal,
  setPortalEnabled,
} = await import("@/lib/actions/portals");

const listing = () => ({ id: "prop-1", reference: "PAF0001", org_id: "org-1" });

function setup(pages: Record<string, FakePage[]>, role = "admin") {
  const fake = fakeClient(pages);
  state.client = fake.client;
  state.role = role;
  logEvent.mockClear();
  revalidatePath.mockClear();
  return fake;
}

/** every insert/update/delete the action attempted, by table */
const writesTo = (fake: ReturnType<typeof fakeClient>, table: string) =>
  fake.calls.filter(
    (c) => c.table === table && ["insert", "update", "delete", "upsert"].includes(c.method),
  );

describe("selectPortal", () => {
  it("reports the refusal when the insert wrote nothing at all", async () => {
    const fake = setup({
      properties: [{ data: listing(), error: null }],
      portal_connections: [{ data: { enabled: true }, error: null }],
      portal_listings: [{ data: [], error: null }], // the INSERT — filtered away
    });
    const res = await selectPortal("prop-1", "jamesedition");
    expect(res.error, "the desk is told whose refusal it was").toMatch(/your role/i);
    expect(res.savedAt).toBeNull();
    expect(
      logEvent,
      "no portal_selected for a listing that reached no portal",
    ).not.toHaveBeenCalled();
    expect(writesTo(fake, "portal_listings")).toHaveLength(1);
  });

  it("treats the duplicate key as the intent already met — success, and no second event", async () => {
    // (property_id, portal) is the primary key: someone selected it already,
    // and THEIR event is the one that happened.
    setup({
      properties: [{ data: listing(), error: null }],
      portal_connections: [{ data: { enabled: true }, error: null }],
      portal_listings: [
        { data: null, error: { message: "duplicate key value", code: "23505" } },
      ],
    });
    const res = await selectPortal("prop-1", "jamesedition");
    expect(res.error).toBeNull();
    expect(res.savedAt).not.toBeNull();
    expect(logEvent, "the first selection already logged it").not.toHaveBeenCalled();
    expect(
      revalidatePath,
      "the row is there but this page thought otherwise — refresh it",
    ).toHaveBeenCalledWith("/properties/prop-1");
  });

  it("names the policy refusal when RLS raises it", async () => {
    setup({
      properties: [{ data: listing(), error: null }],
      portal_connections: [{ data: { enabled: true }, error: null }],
      portal_listings: [
        { data: null, error: { message: "new row violates row-level security", code: "42501" } },
      ],
    });
    const res = await selectPortal("prop-1", "jamesedition");
    expect(res.error).toMatch(/your role/i);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("refuses a portal nobody enabled, without touching the selection table", async () => {
    const fake = setup({
      properties: [{ data: listing(), error: null }],
      portal_connections: [{ data: null, error: null }], // no connection row
      portal_listings: [{ data: [{ portal: "jamesedition" }], error: null }],
    });
    const res = await selectPortal("prop-1", "jamesedition");
    expect(res.error).toMatch(/not enabled/i);
    expect(
      fake.calls.filter((c) => c.table === "portal_listings"),
      "the selection table is never reached",
    ).toHaveLength(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("logs exactly once, on the property, when the insert lands", async () => {
    setup({
      properties: [{ data: listing(), error: null }],
      portal_connections: [{ data: { enabled: true }, error: null }],
      portal_listings: [{ data: [{ portal: "jamesedition" }], error: null }],
    });
    const res = await selectPortal("prop-1", "jamesedition");
    expect(res.error).toBeNull();
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][1]).toMatchObject({
      entityType: "property",
      entityId: "prop-1",
      eventType: "portal_selected",
      payload: { portal: "jamesedition", reference: "PAF0001" },
    });
  });

  it("takes the event's org from the LISTING, not from whoever is looking", async () => {
    /*
     * The two orgs are the same in production — RLS saw to that before the row
     * was ever returned — so this fixture is deliberately impossible. Its job
     * is not to simulate a reachable state but to tell two sources of the same
     * value apart: with `profile.orgId` the event would file itself under the
     * reader's tenant, and the assertion below is the only thing that can see
     * the difference. It is the "ask the database, not the reader" defect in
     * its smallest form.
     */
    setup({
      properties: [{ data: { ...listing(), org_id: "org-of-the-record" }, error: null }],
      portal_connections: [{ data: { enabled: true }, error: null }],
      portal_listings: [{ data: [{ portal: "jamesedition" }], error: null }],
    });
    await selectPortal("prop-1", "jamesedition");
    expect(logEvent.mock.calls[0][1]).toMatchObject({ orgId: "org-of-the-record" });
  });
});

describe("deselectPortal", () => {
  it("refuses instead of claiming a removal the delete never made", async () => {
    setup({
      properties: [{ data: listing(), error: null }],
      portal_listings: [{ data: [], error: null }], // the DELETE — zero rows
    });
    const res = await deselectPortal("prop-1", "jamesedition");
    expect(res.error).toMatch(/nothing changed/i);
    expect(
      logEvent,
      "a portal_removed line for a row still on the portal is the lie this guard exists for",
    ).not.toHaveBeenCalled();
  });

  it("logs the removal when the delete lands", async () => {
    setup({
      properties: [{ data: listing(), error: null }],
      portal_listings: [{ data: [{ portal: "jamesedition" }], error: null }],
    });
    const res = await deselectPortal("prop-1", "jamesedition");
    expect(res.error).toBeNull();
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][1]).toMatchObject({
      entityType: "property",
      eventType: "portal_removed",
      payload: { portal: "jamesedition", reference: "PAF0001" },
    });
  });

  it("files the removal under the listing's org too", async () => {
    // Same deliberately-impossible fixture as the selection side, for the
    // same reason: it is the only way to see which source the value came from.
    setup({
      properties: [{ data: { ...listing(), org_id: "org-of-the-record" }, error: null }],
      portal_listings: [{ data: [{ portal: "jamesedition" }], error: null }],
    });
    await deselectPortal("prop-1", "jamesedition");
    expect(logEvent.mock.calls[0][1]).toMatchObject({ orgId: "org-of-the-record" });
  });
});

describe("setPortalEnabled", () => {
  it("refuses a non-admin before any round trip", async () => {
    const fake = setup({ portal_connections: [{ data: null, error: null }] }, "agent");
    const res = await setPortalEnabled("jamesedition", true);
    expect(res.error).toBe("Admins only.");
    expect(fake.calls, "the database is never asked").toHaveLength(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("refuses a portal whose feed format this build cannot write, before any round trip", async () => {
    // Bazaraki's XML spec is given to Pro accounts only, so the registry marks
    // it `spec: "pending"` — and THAT is the clause that fires here. The
    // `!DIALECT_RENDERERS[dialect]` half of the gate is unreachable while the
    // two tables agree (eligibility.test.ts pins that they do); it is kept as
    // defence in depth, so a renderer pulled without its registry entry being
    // demoted cannot leave the switch flippable.
    //
    // Enabled by either route, the portal would serve the empty document —
    // which every pull portal reads as "withdraw everything".
    const fake = setup({ portal_connections: [{ data: null, error: null }] });
    const res = await setPortalEnabled("bazaraki", true);
    expect(res.error).toMatch(/cannot be enabled yet/i);
    expect(fake.calls).toHaveLength(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("refuses an unknown portal id outright", async () => {
    const fake = setup({});
    const res = await setPortalEnabled("nope", true);
    expect(res.error).toBe("Unknown portal.");
    expect(fake.calls).toHaveLength(0);
  });

  it("treats disabling a portal that was never connected as already true", async () => {
    // There is nothing to switch off. Inserting a disabled row would mint a
    // feed token nobody asked for, and the event would put `portal_disabled`
    // on the organisation's timeline for a portal that was never enabled — a
    // line in an append-only log describing something that did not happen.
    const fake = setup({ portal_connections: [{ data: null, error: null }] });
    const res = await setPortalEnabled("jamesedition", false);
    expect(res.error, "nothing to do is not a failure").toBeNull();
    expect(res.savedAt).not.toBeNull();
    expect(writesTo(fake, "portal_connections"), "and nothing is written").toHaveLength(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("reports the refusal when the write matched no row", async () => {
    setup({
      portal_connections: [
        { data: { id: "conn-1", settings: {} }, error: null }, // the read
        { data: [], error: null }, // the UPDATE — filtered away
      ],
    });
    const res = await setPortalEnabled("jamesedition", true);
    expect(res.error).toMatch(/your role/i);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("never names feed_token — on the insert branch or the update branch", async () => {
    // THE DEFECT THIS PINS: one `.upsert({ …, feed_token: newToken() })` would
    // rotate the URL on every toggle. The database's column default mints the
    // token on insert; nothing here may.
    const fresh = setup({
      portal_connections: [
        { data: null, error: null }, // no row yet
        { data: [{ id: "conn-1" }], error: null }, // the INSERT
      ],
    });
    expect((await setPortalEnabled("jamesedition", true)).error).toBeNull();
    const inserts = fresh.argsOf("portal_connections", "insert");
    expect(inserts, "a first enable INSERTs").toHaveLength(1);
    expect(fresh.argsOf("portal_connections", "upsert"), "and never upserts").toHaveLength(0);
    expect(inserts[0]![0]).toEqual({
      org_id: "org-1",
      portal: "jamesedition",
      enabled: true,
      updated_by: "actor-1",
    });
    expect(Object.keys(inserts[0]![0] as object)).not.toContain("feed_token");

    const existing = setup({
      portal_connections: [
        { data: { id: "conn-1", settings: {} }, error: null }, // the row is there
        { data: [{ id: "conn-1" }], error: null }, // the UPDATE
      ],
    });
    expect((await setPortalEnabled("jamesedition", false)).error).toBeNull();
    const updates = existing.argsOf("portal_connections", "update");
    expect(updates, "a later toggle UPDATEs").toHaveLength(1);
    expect(updates[0]![0]).toEqual({ enabled: false, updated_by: "actor-1" });
    expect(
      Object.keys(updates[0]![0] as object),
      "a toggle must never rotate the portal's feed URL",
    ).not.toContain("feed_token");
    expect(logEvent.mock.calls[0][1]).toMatchObject({
      entityType: "organization",
      eventType: "portal_disabled",
      payload: { portal: "jamesedition" },
    });
  });
});

describe("savePortalSettings", () => {
  const EMAIL = "sales@example.com";
  const PHONE = "+357 26 000000";

  const form = () => {
    const fd = new FormData();
    fd.set("portal", "jamesedition");
    fd.set("contact_number", PHONE);
    fd.set("email", EMAIL);
    return fd;
  };

  const blank = { error: null, savedAt: null };

  it("refuses instead of reporting a save the row never took", async () => {
    setup({
      portal_connections: [
        { data: { id: "conn-1" }, error: null }, // the read
        { data: [], error: null }, // the UPDATE — filtered away
      ],
    });
    const res = await savePortalSettings(blank, form());
    expect(res.error).toMatch(/nothing saved/i);
    expect(res.savedAt).toBeNull();
    expect(
      logEvent,
      "no settings event for contact details the connection does not carry",
    ).not.toHaveBeenCalled();
  });

  it("creates the connection when there is none, still without naming feed_token", async () => {
    // Filling in the contact details before flipping the switch is the
    // ordinary order of work, so this is an INSERT — and the token is the
    // database's to mint here exactly as it is on the enable path.
    const fake = setup({
      portal_connections: [
        { data: null, error: null }, // no row yet
        { data: [{ id: "conn-1" }], error: null }, // the INSERT
      ],
    });
    const res = await savePortalSettings(blank, form());
    expect(res.error).toBeNull();
    const inserts = fake.argsOf("portal_connections", "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![0]).toEqual({
      org_id: "org-1",
      portal: "jamesedition",
      settings: { contact_number: PHONE, whatsapp_number: "", email: EMAIL },
      updated_by: "actor-1",
    });
    expect(Object.keys(inserts[0]![0] as object)).not.toContain("feed_token");
    expect(fake.argsOf("portal_connections", "upsert")).toHaveLength(0);
  });

  it("logs the key NAMES and none of the values", async () => {
    /*
     * The event chain is append-only and hash-linked, and erasure cannot reach
     * it (0017). A contact e-mail written into a payload by value is therefore
     * written for ever, in the one table an Article 17 request cannot touch —
     * which is why the settings themselves live in a mutable `jsonb` column
     * and the event records only which fields were edited.
     */
    setup({
      portal_connections: [
        { data: { id: "conn-1" }, error: null },
        { data: [{ id: "conn-1" }], error: null },
      ],
    });
    const res = await savePortalSettings(blank, form());
    expect(res.error).toBeNull();
    expect(logEvent).toHaveBeenCalledTimes(1);

    const event = logEvent.mock.calls[0][1];
    expect(event).toMatchObject({
      entityType: "organization",
      entityId: "org-1",
      eventType: "portal_settings_updated",
    });
    const payload = (event as { payload: { portal: string; keys: string[] } }).payload;
    expect(payload.portal).toBe("jamesedition");
    expect([...payload.keys].sort()).toEqual(["contact_number", "email", "whatsapp_number"]);

    // The claim, tested rather than asserted in a comment: no submitted VALUE
    // reaches the chain anywhere in the payload, however nested.
    const serialized = JSON.stringify(payload);
    expect(serialized, "the e-mail address entered the event log").not.toContain(EMAIL);
    expect(serialized, "the phone number entered the event log").not.toContain(PHONE);
  });
});

describe("regeneratePortalToken", () => {
  it("refuses when there is no connection to rotate", async () => {
    setup({ portal_connections: [{ data: [], error: null }] });
    const res = await regeneratePortalToken("jamesedition");
    expect(res.error).toMatch(/no connection to rotate/i);
    expect(
      logEvent,
      "no portal_token_regenerated for a URL that did not change",
    ).not.toHaveBeenCalled();
  });

  it("writes a fresh 64-hex token and logs it when the row is there", async () => {
    const fake = setup({ portal_connections: [{ data: [{ id: "conn-1" }], error: null }] });
    const res = await regeneratePortalToken("jamesedition");
    expect(res.error).toBeNull();
    const payload = fake.argsOf("portal_connections", "update")[0]![0] as {
      feed_token: string;
    };
    // 0095's CHECK constraint is exactly this shape
    expect(payload.feed_token).toMatch(/^[0-9a-f]{64}$/);
    expect(logEvent.mock.calls[0][1]).toMatchObject({
      entityType: "organization",
      eventType: "portal_token_regenerated",
      payload: { portal: "jamesedition" },
    });
  });
});
