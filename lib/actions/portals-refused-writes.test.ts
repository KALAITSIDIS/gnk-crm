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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const {
  deselectPortal,
  regeneratePortalToken,
  selectPortal,
  setPortalEnabled,
} = await import("@/lib/actions/portals");

const listing = () => ({ id: "prop-1", reference: "PAF0001", org_id: "org-1" });

function setup(pages: Record<string, FakePage[]>, role = "admin") {
  const fake = fakeClient(pages);
  state.client = fake.client;
  state.role = role;
  logEvent.mockClear();
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
});

describe("setPortalEnabled", () => {
  it("refuses a non-admin before any round trip", async () => {
    const fake = setup({ portal_connections: [{ data: null, error: null }] }, "agent");
    const res = await setPortalEnabled("jamesedition", true);
    expect(res.error).toBe("Admins only.");
    expect(fake.calls, "the database is never asked").toHaveLength(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("refuses a portal this build has no renderer for, before any round trip", async () => {
    // Bazaraki's XML spec is Pro-accounts-only, so DIALECT_RENDERERS.bazaraki
    // is null. Enabled, it would serve the empty document — which every pull
    // portal reads as "withdraw everything".
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
