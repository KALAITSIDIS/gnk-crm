/**
 * 0095 — portal syndication. Who may write the connection, who may select a
 * listing, what a token reveals, and that "on a portal" ⊆ "on the site" can
 * actually FAIL. Requires the local stack: npm run test:rls
 *
 * The token block's tests run in file order and share ONE property row and ONE
 * connection; each may move them, and the block's `afterEach` puts both back
 * (status available, visibility public, location_approx false, connection
 * enabled) so no test inherits another's state.
 *
 * A red test here means a rule moved, not that the test is stale: in block 1 a
 * connection policy widened (an agent or another org's admin can now write) or
 * the portal-id check drifted from the registry's PORTAL_ID_PATTERN; in block 2
 * the selection policy widened past "whoever may edit the listing", or the
 * composite tenant FK is gone and a row can name another org's property; in
 * block 3 portal_supplement's predicate drifted from public_listings — so a
 * listing can be on a portal while off the site — or selection stopped gating
 * the feed and every public listing is being syndicated.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  eligibilityInputFromProperty,
  type PropertyEligibilityInput,
} from "@/lib/services/portals/eligibility";
import { PORTAL_ID_PATTERN } from "@/lib/services/portals/registry";
import type { Database } from "@/lib/supabase/database.types";
import {
  ORG_A,
  ORG_B,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

const svc = serviceClient();
const anon = anonClient();
const run = Date.now().toString(36);
const PORTAL = "jamesedition";
const ref = (tag: string) => `ZZPRT-${tag}${run}`.slice(0, 20);

let adminA: TestUser;
let agentA: TestUser;
let adminB: TestUser;
let token = "";
let tokenSha256 = "";
let publicId = "";
let privateId = "";
let unselectedId = "";
let orgBPropertyId = "";
let mediaIds: string[] = [];

async function mkProperty(orgId: string, reference: string, visibility: "public" | "private", assigned: string | null) {
  const { data, error } = await svc
    .from("properties")
    .insert({
      org_id: orgId,
      reference,
      property_type: "villa",
      status: "available",
      visibility,
      asking_price: 500000,
      currency: "EUR",
      public_description: { en: "Test villa" },
      assigned_agent_id: assigned,
      location: "SRID=4326;POINT(32.38 34.88)",
      location_approx: false,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  await ensureTestOrg(svc, ORG_B, "Test Org B", "test-org-b");
  adminA = await createTestUser(svc, `portals-adm-${run}@example.invalid`, "admin", ORG_A, { enrolFactor: true });
  agentA = await createTestUser(svc, `portals-agt-${run}@example.invalid`, "agent", ORG_A, { enrolFactor: true });
  adminB = await createTestUser(svc, `portals-admb-${run}@example.invalid`, "admin", ORG_B, { enrolFactor: true });

  // 0097: the database holds only sha256(token). The suite mints the token
  // the way the app does and stores the digest, so it can play the portal.
  token = randomBytes(32).toString("hex");
  tokenSha256 = createHash("sha256").update(token).digest("hex");
  const { error } = await svc
    .from("portal_connections")
    .upsert(
      { org_id: ORG_A, portal: PORTAL, enabled: true, feed_token_sha256: tokenSha256 },
      { onConflict: "org_id,portal" },
    );
  if (error) throw new Error(error.message);

  publicId = await mkProperty(ORG_A, ref("P"), "public", agentA.id);
  privateId = await mkProperty(ORG_A, ref("X"), "private", null);
  // public and available but NEVER selected: the row that proves selection is the gate
  unselectedId = await mkProperty(ORG_A, ref("U"), "public", null);
  orgBPropertyId = await mkProperty(ORG_B, ref("B"), "public", null);

  // `alt` is NOT NULL, and PostgREST sends an explicit null for a key one row in
  // a batch omits — so every row names it, and each names itself so a leak into
  // `images` says which row leaked rather than showing an empty object.
  const { data: media, error: mErr } = await svc
    .from("property_media")
    .insert([
      { org_id: ORG_A, property_id: publicId, kind: "photo", path_full: `t/${run}_1_full.webp`, path_jpeg: `t/${run}_1_jpeg.jpg`, is_cover: true, sort_order: 1, alt: { en: "Front" } },
      { org_id: ORG_A, property_id: publicId, kind: "photo", path_full: `t/${run}_2_full.webp`, path_jpeg: `t/${run}_2_jpeg.jpg`, is_cover: false, sort_order: 0, alt: { en: "Garden" } },
      { org_id: ORG_A, property_id: publicId, kind: "photo", path_full: `t/${run}_3_full.webp`, path_jpeg: null, is_cover: false, sort_order: 2, alt: { en: "No JPEG" } },
      { org_id: ORG_A, property_id: publicId, kind: "floor_plan", path_full: `t/${run}_4_full.webp`, path_jpeg: `t/${run}_4_jpeg.jpg`, is_cover: false, sort_order: 3, alt: { en: "Floor plan" } },
    ])
    .select("id");
  if (mErr) throw new Error(mErr.message);
  mediaIds = (media ?? []).map((m) => m.id as string);
});

afterAll(async () => {
  await svc.from("property_media").delete().in("id", mediaIds);
  await svc.from("properties").delete().in("id", [publicId, privateId, unselectedId, orgBPropertyId]);
});

describe("portal_connections", () => {
  it("an agent cannot enable a portal (insert refused, update matches 0 rows)", async () => {
    const ins = await agentA.client.from("portal_connections").insert({ org_id: ORG_A, portal: "properstar" });
    expect(ins.error?.code).toBe("42501");
    const upd = await agentA.client.from("portal_connections").update({ enabled: false }).eq("portal", PORTAL).select("id");
    expect(upd.error).toBeNull();
    expect(upd.data).toHaveLength(0);
  });

  it("an admin of another org sees nothing and changes nothing", async () => {
    const sel = await adminB.client.from("portal_connections").select("id").eq("org_id", ORG_A);
    expect(sel.data).toHaveLength(0);
    const upd = await adminB.client.from("portal_connections").update({ enabled: false }).eq("org_id", ORG_A).select("id");
    expect(upd.data).toHaveLength(0);
  });

  it("an admin of the org may update it, and the token is never readable by anon", async () => {
    // the settings the token function is asserted to hand back in block 3
    const upd = await adminA.client.from("portal_connections").update({ settings: { email: "x@y.zz" } }).eq("portal", PORTAL).select("id");
    expect(upd.error).toBeNull();
    expect(upd.data).toHaveLength(1);
    const a = await anon.from("portal_connections").select("feed_token_sha256");
    expect(a.error?.code).toBe("42501");
  });

  it("the plaintext token is not stored anywhere: the column is gone (0097)", async () => {
    // 42703 undefined_column — the service role, which sees every column,
    // cannot read a token because there is none to read
    const gone = await svc.from("portal_connections").select("feed_token").limit(1);
    expect(gone.error?.code).toBe("42703");
    const { data } = await svc
      .from("portal_connections")
      .select("feed_token_sha256")
      .eq("org_id", ORG_A)
      .eq("portal", PORTAL)
      .single();
    expect(data?.feed_token_sha256).toBe(tokenSha256);
    expect(data?.feed_token_sha256).not.toBe(token);
  });

  it("the database's portal-id check agrees with the registry's PORTAL_ID_PATTERN", async () => {
    expect(PORTAL_ID_PATTERN.test("Not-Valid")).toBe(false);
    const bad = await svc.from("portal_connections").insert({ org_id: ORG_A, portal: "Not-Valid" });
    expect(bad.error?.code).toBe("23514");
    expect(PORTAL_ID_PATTERN.test("zz_probe")).toBe(true);
    try {
      const good = await svc.from("portal_connections").insert({ org_id: ORG_A, portal: "zz_probe" }).select("id").single();
      expect(good.error).toBeNull();
    } finally {
      // the probe is a connection with a live feed token: it leaves even if the assertion throws
      await svc.from("portal_connections").delete().eq("org_id", ORG_A).eq("portal", "zz_probe");
    }
  });
});

describe("portal_listings", () => {
  afterAll(async () => {
    await svc.from("portal_listings").delete().in("property_id", [publicId, privateId]);
  });

  it("an agent may select a listing assigned to them and not one that is not", async () => {
    const own = await agentA.client
      .from("portal_listings")
      .insert({ org_id: ORG_A, property_id: publicId, portal: PORTAL, selected_by: agentA.id });
    expect(own.error).toBeNull();
    const other = await agentA.client
      .from("portal_listings")
      .insert({ org_id: ORG_A, property_id: privateId, portal: PORTAL, selected_by: agentA.id });
    expect(other.error?.code).toBe("42501");
  });

  it("another org's admin deletes nothing (cross-org)", async () => {
    const del = await adminB.client.from("portal_listings").delete().eq("property_id", publicId).select("portal");
    expect(del.data).toHaveLength(0);
  });

  it("an org-A agent cannot remove a selection on a listing not assigned to them (0 rows), and another org's admin cannot even see it", async () => {
    const { error } = await svc.from("portal_listings").insert({ org_id: ORG_A, property_id: privateId, portal: PORTAL, selected_by: adminA.id });
    expect(error).toBeNull();
    const del = await agentA.client.from("portal_listings").delete().eq("property_id", privateId).select("portal");
    expect(del.error).toBeNull();
    expect(del.data).toHaveLength(0);
    const sel = await adminB.client.from("portal_listings").select("portal").eq("property_id", privateId);
    expect(sel.error).toBeNull();
    expect(sel.data).toHaveLength(0);
    await svc.from("portal_listings").delete().eq("property_id", privateId);
  });

  it("selecting cannot be filed under another user's name", async () => {
    const r = await agentA.client
      .from("portal_listings")
      .insert({ org_id: ORG_A, property_id: publicId, portal: "properstar", selected_by: adminA.id });
    expect(r.error?.code).toBe("42501");
  });

  // ADDED (Task 6 review): the composite tenant FK holds even outside RLS.
  it("a row cannot name another org's property, even for the service role (23503)", async () => {
    const cross = await svc
      .from("portal_listings")
      .insert({ org_id: ORG_A, property_id: orgBPropertyId, portal: PORTAL, selected_by: adminA.id });
    expect(cross.error?.code).toBe("23503");
    const { data } = await svc.from("portal_listings").select("portal").eq("property_id", orgBPropertyId);
    expect(data).toHaveLength(0);
  });
});

describe("the token functions (anon)", () => {
  beforeAll(async () => {
    await svc.from("portal_listings").upsert([
      { org_id: ORG_A, property_id: publicId, portal: PORTAL, selected_by: adminA.id },
      { org_id: ORG_A, property_id: privateId, portal: PORTAL, selected_by: adminA.id },
    ]);
  });

  // THE STATE CONTRACT. Unconditional and idempotent: every test in this block
  // starts from a public, available, exactly-located listing on an enabled
  // connection, whatever the test before it moved.
  afterEach(async () => {
    await svc
      .from("properties")
      .update({ status: "available", visibility: "public", location_approx: false })
      .eq("id", publicId);
    await svc.from("portal_connections").update({ enabled: true }).eq("feed_token_sha256", tokenSha256);
  });

  afterAll(async () => {
    await svc.from("portal_listings").delete().in("property_id", [publicId, privateId]);
  });

  // One listing by reference, so neither answer depends on how many other rows
  // the org holds; an error is a failure, never a quietly empty list.
  const onSite = async (reference: string) => {
    const { data, error } = await anon.rpc("public_listings", { p_org_slug: "test-org-a", p_limit: 1, p_offset: 0, p_reference: reference });
    expect(error).toBeNull();
    return (data ?? []).some((r: { reference: string }) => r.reference === reference);
  };
  const onPortal = async (reference: string) => {
    const { data, error } = await anon.rpc("portal_supplement", { p_token_sha256: tokenSha256 });
    expect(error).toBeNull();
    return (data ?? []).some((r: { reference: string }) => r.reference === reference);
  };

  it("a wrong token answers nothing; the right one answers the org slug", async () => {
    const wrong = await anon.rpc("portal_connection_by_token", { p_portal: PORTAL, p_token_sha256: "f".repeat(64) });
    expect(wrong.error).toBeNull();
    expect(wrong.data).toHaveLength(0);
    const right = await anon.rpc("portal_connection_by_token", { p_portal: PORTAL, p_token_sha256: tokenSha256 });
    expect(right.data?.[0]).toMatchObject({ org_slug: "test-org-a", enabled: true, settings: { email: "x@y.zz" } });
    const otherPortal = await anon.rpc("portal_connection_by_token", { p_portal: "properstar", p_token_sha256: tokenSha256 });
    expect(otherPortal.data).toHaveLength(0);
  });

  it("portal_supplement returns the selected public listing with exact coords and only JPEG photos, never the private one", async () => {
    const { data, error } = await anon.rpc("portal_supplement", { p_token_sha256: tokenSha256 });
    expect(error).toBeNull();
    const refs = (data ?? []).map((r: { reference: string }) => r.reference);
    expect(refs).toContain(ref("P"));
    expect(refs).not.toContain(ref("X"));
    const row = (data ?? []).find((r: { reference: string }) => r.reference === ref("P"))!;
    // lat is the second POINT coordinate, lng the first — a swapped st_x/st_y fails here
    expect(row.lat).toBeCloseTo(34.88, 5);
    expect(row.lng).toBeCloseTo(32.38, 5);
    expect(row.location_approx).toBe(false);
    // cover first despite its higher sort_order, then by sort_order; the photo
    // with no JPEG rendition and the floor plan are not photographs a portal gets
    expect(row.images).toEqual([
      { jpeg: `t/${run}_1_jpeg.jpg`, alt: { en: "Front" } },
      { jpeg: `t/${run}_2_jpeg.jpg`, alt: { en: "Garden" } },
    ]);

    // the other direction: an approximate location is flagged as such, so a
    // dialect that must not publish an exact point can tell (afterEach restores)
    await svc.from("properties").update({ location_approx: true }).eq("id", publicId);
    const again = await anon.rpc("portal_supplement", { p_token_sha256: tokenSha256 });
    expect(again.error).toBeNull();
    const approxRow = (again.data ?? []).find((r: { reference: string }) => r.reference === ref("P"))!;
    expect(approxRow.location_approx).toBe(true);
  });

  // ADDED (whole-branch review): the withholding must live in the SQL, not
  // in a renderer. This function is reachable by anyone holding the token
  // over PostgREST, skipping the XML route entirely, and 0054's flag means
  // "never publish this as the property's location" — the app stores an area
  // centroid under it, but a direct write (this test, an import) can flag a
  // surveyed point, so a red here is a token holder getting the exact point
  // of a listing the desk marked approximate.
  it("portal_supplement withholds the point of an approximate listing and hands it back once exact again", async () => {
    await svc.from("properties").update({ location_approx: true }).eq("id", publicId);
    const approx = await anon.rpc("portal_supplement", { p_token_sha256: tokenSha256 });
    expect(approx.error).toBeNull();
    const withheld = (approx.data ?? []).find((r: { reference: string }) => r.reference === ref("P"))!;
    expect(withheld.location_approx).toBe(true);
    expect(withheld.lat).toBeNull();
    expect(withheld.lng).toBeNull();

    await svc.from("properties").update({ location_approx: false }).eq("id", publicId);
    const exact = await anon.rpc("portal_supplement", { p_token_sha256: tokenSha256 });
    expect(exact.error).toBeNull();
    const returned = (exact.data ?? []).find((r: { reference: string }) => r.reference === ref("P"))!;
    expect(returned.location_approx).toBe(false);
    expect(returned.lat).toBeCloseTo(34.88, 5);
    expect(returned.lng).toBeCloseTo(32.38, 5);
  });

  // ADDED (Task 7 review): without this, deleting the portal_listings join from
  // portal_supplement would leave every other test in this file green.
  it("a public listing that nobody selected is on the site and NOT on the portal — selection is the gate", async () => {
    expect(await onSite(ref("U"))).toBe(true);
    expect(await onPortal(ref("U"))).toBe(false);
  });

  it("the supplement's predicate is the site feed's: a sold listing leaves both", async () => {
    await svc.from("properties").update({ status: "sold" }).eq("id", publicId);
    expect(await onPortal(ref("P"))).toBe(false);
    expect(await onSite(ref("P"))).toBe(false);
  });

  // ADDED (Task 6 review): the pin must be able to fail in both directions.
  it("…and a listing made private leaves both, then returns to both when made public again", async () => {
    expect(await onPortal(ref("P"))).toBe(true);
    expect(await onSite(ref("P"))).toBe(true);
    await svc.from("properties").update({ visibility: "private" }).eq("id", publicId);
    expect(await onPortal(ref("P"))).toBe(false);
    expect(await onSite(ref("P"))).toBe(false);
    await svc.from("properties").update({ visibility: "public" }).eq("id", publicId);
    expect(await onPortal(ref("P"))).toBe(true);
    expect(await onSite(ref("P"))).toBe(true);
  });

  // ADDED (Task 5 review): the toggle's copy of THE PREDICATE agrees with SQL on the same row.
  it("eligibilityInputFromProperty.isPublic agrees with public_listings on the same row", async () => {
    const readRow = async (id: string) => {
      const { data } = await svc
        .from("properties")
        .select("visibility, status, transaction_type, asking_price, rent_price_month, currency, public_description, property_type")
        .eq("id", id)
        .single();
      const row = data as Pick<
        Database["public"]["Tables"]["properties"]["Row"],
        | "visibility"
        | "status"
        | "transaction_type"
        | "asking_price"
        | "rent_price_month"
        | "currency"
        | "public_description"
        | "property_type"
      >;
      const input: PropertyEligibilityInput = { ...row, districtName: null, areaName: null, jpegPhotoCount: 0, coords: null };
      return input;
    };
    expect(eligibilityInputFromProperty(await readRow(publicId)).isPublic).toBe(true);
    expect(await onSite(ref("P"))).toBe(true);
    await svc.from("properties").update({ status: "reserved" }).eq("id", publicId);
    expect(eligibilityInputFromProperty(await readRow(publicId)).isPublic).toBe(false);
    expect(await onSite(ref("P"))).toBe(false);
    expect(eligibilityInputFromProperty(await readRow(privateId)).isPublic).toBe(false);
  });

  it("a disabled connection answers an empty supplement", async () => {
    await svc.from("portal_connections").update({ enabled: false }).eq("feed_token_sha256", tokenSha256);
    const sup = await anon.rpc("portal_supplement", { p_token_sha256: tokenSha256 });
    expect(sup.data).toHaveLength(0);
  });

  it("note_portal_pull records the pull, clamped", async () => {
    // 0095 leaves `and enabled` off this one deliberately: that a portal keeps
    // pulling a feed the desk switched off is worth seeing on the settings page,
    // so the pull is recorded against a DISABLED connection too.
    await svc.from("portal_connections").update({ enabled: false }).eq("feed_token_sha256", tokenSha256);
    const { error } = await anon.rpc("note_portal_pull", { p_token_sha256: tokenSha256, p_ua: "Test Crawler/1.0", p_count: -5 });
    expect(error).toBeNull();
    const { data } = await svc
      .from("portal_connections")
      .select("last_pulled_ua, last_pull_count, last_pulled_at, enabled")
      .eq("feed_token_sha256", tokenSha256)
      .single();
    expect(data).toMatchObject({ last_pulled_ua: "Test Crawler/1.0", last_pull_count: 0, enabled: false });
    expect(data?.last_pulled_at).not.toBeNull();
  });

  it("anon cannot read either table directly", async () => {
    const a = await anon.from("portal_listings").select("portal");
    expect(a.error?.code).toBe("42501");
  });
});
