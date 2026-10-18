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
 * block 3 portal_feed_supplement's predicate drifted from public_listings — so
 * a listing can be on a portal while off the site — or selection stopped
 * gating the feed and every public listing is being syndicated, or the stored
 * digest opens the feed again (0150 / 0151: the readers take the URL's token
 * and hash it themselves); in block 4 the restore pack's 0150 / 0151 row
 * stopped reading the posture it pins.
 *
 * 0150 / 0151 moved this file from 0097's digest-taking functions
 * (portal_connection_by_token, portal_supplement, note_portal_pull — dropped)
 * to portal_feed_connection(p_portal, p_token), portal_feed_supplement(p_token)
 * and the service-role-only record_portal_pull. Every containment test kept
 * its assertion; only the call changed. The rest of 0150's surface (telemetry
 * history, export revisions, the migrations) is portal-feed-integrity.test.ts.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
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
import { REVERT_0150_SQL } from "./revert-0150";
import { REVERT_0151_SQL } from "./revert-0151";

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
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
  // Since 0150 the readers take the TOKEN and hash it themselves; the digest
  // is what a copy of the column holds, and opens nothing.
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
  // `images` says which row leaked rather than showing an empty object. Each
  // also carries a DIFFERENT original size (0150 hands width/height to the
  // portal check), so a size swapped between photos, or width and height
  // swapped within one, fails the images assertion below.
  const { data: media, error: mErr } = await svc
    .from("property_media")
    .insert([
      { org_id: ORG_A, property_id: publicId, kind: "photo", path_full: `properties/${publicId}/${run}_1_full.webp`, path_jpeg: `properties/${publicId}/${run}_1_jpeg.jpg`, is_cover: true, sort_order: 1, alt: { en: "Front" }, width: 4000, height: 3000 },
      { org_id: ORG_A, property_id: publicId, kind: "photo", path_full: `properties/${publicId}/${run}_2_full.webp`, path_jpeg: `properties/${publicId}/${run}_2_jpeg.jpg`, is_cover: false, sort_order: 0, alt: { en: "Garden" }, width: 1200, height: 900 },
      { org_id: ORG_A, property_id: publicId, kind: "photo", path_full: `properties/${publicId}/${run}_3_full.webp`, path_jpeg: null, is_cover: false, sort_order: 2, alt: { en: "No JPEG" }, width: 3000, height: 2000 },
      { org_id: ORG_A, property_id: publicId, kind: "floor_plan", path_full: `properties/${publicId}/${run}_4_full.webp`, path_jpeg: `properties/${publicId}/${run}_4_jpeg.jpg`, is_cover: false, sort_order: 3, alt: { en: "Floor plan" }, width: 2000, height: 1000 },
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
  const supplement = () => anon.rpc("portal_feed_supplement", { p_token: token });
  const onPortal = async (reference: string) => {
    const { data, error } = await supplement();
    expect(error).toBeNull();
    return (data ?? []).some((r: { reference: string }) => r.reference === reference);
  };

  it("a wrong token answers nothing; the right one answers the org slug and how many listings the supplement holds", async () => {
    const wrong = await anon.rpc("portal_feed_connection", { p_portal: PORTAL, p_token: "f".repeat(64) });
    expect(wrong.error).toBeNull();
    expect(wrong.data).toHaveLength(0);
    const right = await anon.rpc("portal_feed_connection", { p_portal: PORTAL, p_token: token });
    expect(right.error).toBeNull();
    expect(right.data).toHaveLength(1);
    expect(right.data?.[0]).toMatchObject({ org_slug: "test-org-a", enabled: true, settings: { email: "x@y.zz" } });
    // selected_count is what the route refuses a shorter supplement against;
    // compared with the supplement itself rather than a literal, so a selection
    // another run left behind in ORG_A cannot make it flaky
    const sup = await supplement();
    expect(sup.error).toBeNull();
    expect(right.data?.[0]?.selected_count).toBe((sup.data ?? []).length);
    expect(right.data?.[0]?.selected_count).toBeGreaterThanOrEqual(1);
    const otherPortal = await anon.rpc("portal_feed_connection", { p_portal: "properstar", p_token: token });
    expect(otherPortal.error).toBeNull();
    expect(otherPortal.data).toHaveLength(0);
  });

  it("selected_count counts the selected listings the site would show: one fewer once the listing is sold", async () => {
    const count = async () => {
      const r = await anon.rpc("portal_feed_connection", { p_portal: PORTAL, p_token: token });
      expect(r.error).toBeNull();
      return r.data?.[0]?.selected_count as number;
    };
    const before = await count();
    await svc.from("properties").update({ status: "sold" }).eq("id", publicId);
    expect(await count()).toBe(before - 1);
  });

  // 0150 / 0151: the stored value is what every export, dump and member's
  // read holds. Hashed again it is not the stored value, so it opens nothing —
  // and 0097's digest-taking door is gone from the API, not merely unused.
  it("the stored digest passed as the token opens nothing, and 0097's digest-taking readers are gone", async () => {
    const { data: stored } = await svc
      .from("portal_connections")
      .select("feed_token_sha256")
      .eq("org_id", ORG_A)
      .eq("portal", PORTAL)
      .single();
    expect(stored?.feed_token_sha256).toBe(tokenSha256);
    const c = await anon.rpc("portal_feed_connection", { p_portal: PORTAL, p_token: tokenSha256 });
    expect(c.error).toBeNull();
    expect(c.data).toEqual([]);
    const s = await anon.rpc("portal_feed_supplement", { p_token: tokenSha256 });
    expect(s.error).toBeNull();
    expect(s.data).toEqual([]);
    // the token itself still opens the same connection — so the empty answers
    // above are the hash refusing the digest, not a broken fixture
    expect(await onPortal(ref("P"))).toBe(true);
    for (const [fn, args] of [
      ["portal_connection_by_token", { p_portal: PORTAL, p_token_sha256: tokenSha256 }],
      ["portal_supplement", { p_token_sha256: tokenSha256 }],
    ] as const) {
      const old = await anon.rpc(fn, args);
      expect(old.error?.code, fn).toBe("PGRST202");
      expect(old.data, fn).toBeNull();
    }
  });

  it("portal_feed_supplement returns the selected public listing with exact coords and only JPEG photos, never the private one", async () => {
    const { data, error } = await supplement();
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
    // with no JPEG rendition and the floor plan are not photographs a portal gets.
    // 0150: each photo carries its ORIGINAL pixel size, from which the CRM
    // derives the JPEG a portal receives and checks a portal's minimum.
    expect(row.images).toEqual([
      { jpeg: `properties/${publicId}/${run}_1_jpeg.jpg`, alt: { en: "Front" }, width: 4000, height: 3000 },
      { jpeg: `properties/${publicId}/${run}_2_jpeg.jpg`, alt: { en: "Garden" }, width: 1200, height: 900 },
    ]);

    // the other direction: an approximate location is flagged as such, so a
    // dialect that must not publish an exact point can tell (afterEach restores)
    await svc.from("properties").update({ location_approx: true }).eq("id", publicId);
    const again = await supplement();
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
  it("portal_feed_supplement withholds the point of an approximate listing and hands it back once exact again", async () => {
    await svc.from("properties").update({ location_approx: true }).eq("id", publicId);
    const approx = await supplement();
    expect(approx.error).toBeNull();
    const withheld = (approx.data ?? []).find((r: { reference: string }) => r.reference === ref("P"))!;
    expect(withheld.location_approx).toBe(true);
    expect(withheld.lat).toBeNull();
    expect(withheld.lng).toBeNull();

    await svc.from("properties").update({ location_approx: false }).eq("id", publicId);
    const exact = await supplement();
    expect(exact.error).toBeNull();
    const returned = (exact.data ?? []).find((r: { reference: string }) => r.reference === ref("P"))!;
    expect(returned.location_approx).toBe(false);
    expect(returned.lat).toBeCloseTo(34.88, 5);
    expect(returned.lng).toBeCloseTo(32.38, 5);
  });

  // ADDED (0150): the export revision hashes the rendered listing, photo order
  // included, so a tie on (is_cover, sort_order, created_at) resolved one way
  // on this pull and the other way on the next would move the listing's date
  // with nothing changed. 0150 ends the order on m.id. The two photos are
  // inserted LARGER id first, so the heap — and any sort that keeps its
  // input order on a tie — would answer them the wrong way round without the
  // tie-break. An unknown size answers null, never an invented number.
  it("the photo order ends on id: two photos tied on sort_order and created_at come back in id order on every read", async () => {
    const [low, high] = [randomUUID(), randomUUID()].sort();
    const createdAt = "2026-01-02T03:04:05.000Z";
    const tied = (id: string, n: number, size: { width: number | null; height: number | null }) => ({
      id,
      org_id: ORG_A,
      property_id: publicId,
      kind: "photo" as const,
      path_full: `properties/${publicId}/${run}_tie${n}_full.webp`,
      path_jpeg: `properties/${publicId}/${run}_tie${n}_jpeg.jpg`,
      is_cover: false,
      sort_order: 9,
      created_at: createdAt,
      alt: { en: `Tie ${n}` },
      ...size,
    });
    try {
      const first = await svc.from("property_media").insert(tied(high, 2, { width: null, height: null }));
      expect(first.error).toBeNull();
      const second = await svc.from("property_media").insert(tied(low, 1, { width: 800, height: 600 }));
      expect(second.error).toBeNull();

      const expected = [
        { jpeg: `properties/${publicId}/${run}_1_jpeg.jpg`, alt: { en: "Front" }, width: 4000, height: 3000 },
        { jpeg: `properties/${publicId}/${run}_2_jpeg.jpg`, alt: { en: "Garden" }, width: 1200, height: 900 },
        { jpeg: `properties/${publicId}/${run}_tie1_jpeg.jpg`, alt: { en: "Tie 1" }, width: 800, height: 600 },
        { jpeg: `properties/${publicId}/${run}_tie2_jpeg.jpg`, alt: { en: "Tie 2" }, width: null, height: null },
      ];
      for (let i = 0; i < 5; i++) {
        const { data, error } = await supplement();
        expect(error).toBeNull();
        const row = (data ?? []).find((r: { reference: string }) => r.reference === ref("P"))!;
        expect(row.images, `read ${i + 1}`).toEqual(expected);
      }
    } finally {
      await svc.from("property_media").delete().in("id", [low, high]);
    }
  });

  // ADDED (Task 7 review): without this, deleting the portal_listings join from
  // portal_feed_supplement (0097: portal_supplement) would leave every other
  // test in this file green.
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
      // 0150's eligibility reads the photos' sizes (jpegPhotos) rather than a
      // count; isPublic, the field under test, reads neither
      const input: PropertyEligibilityInput = { ...row, districtName: null, areaName: null, jpegPhotos: [], coords: null };
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
    // the selection is non-empty while enabled, so the empty answer below is
    // the switch, not an empty fixture
    expect(await onPortal(ref("P"))).toBe(true);
    await svc.from("portal_connections").update({ enabled: false }).eq("feed_token_sha256", tokenSha256);
    const sup = await supplement();
    expect(sup.error).toBeNull();
    expect(sup.data).toHaveLength(0);
    // …and the lookup says so, with nothing counted, so the route serves the
    // empty document on purpose rather than refusing a "short" supplement
    const lookup = await anon.rpc("portal_feed_connection", { p_portal: PORTAL, p_token: token });
    expect(lookup.error).toBeNull();
    expect(lookup.data?.[0]).toMatchObject({ enabled: false, selected_count: 0 });
  });

  // REPLACED (0150): note_portal_pull was anon-callable and wrote whatever
  // user-agent and count it was sent, so a token or digest holder could keep
  // "Last pulled" fresh over a dead integration. Its successor
  // record_portal_pull is the route's alone (service_role, the admin client).
  // 0095's reason for recording a DISABLED connection's pulls still holds —
  // that a portal keeps pulling a feed the desk switched off is worth seeing
  // on the settings page — so the record lands against a disabled row too.
  it("record_portal_pull: anon is refused (42501) and writes nothing; the service role records, a disabled connection included", async () => {
    await svc.from("portal_connections").update({ enabled: false }).eq("feed_token_sha256", tokenSha256);
    const args = (ua: string) => ({
      p_token: token,
      p_ua: ua,
      p_outcome: "disabled",
      p_served: 0,
      p_selected: null,
      p_excluded: null,
      p_reason: null,
      p_detail: {},
    });
    const recorded = await svc.rpc("record_portal_pull", args("Test Crawler/1.0"));
    expect(recorded.error).toBeNull();
    const read = async () => {
      const { data, error } = await svc
        .from("portal_connections")
        .select("last_pulled_ua, last_pull_count, last_pulled_at, last_pull_outcome, enabled")
        .eq("feed_token_sha256", tokenSha256)
        .single();
      expect(error).toBeNull();
      return data;
    };
    const after = await read();
    expect(after).toMatchObject({ last_pulled_ua: "Test Crawler/1.0", last_pull_count: 0, last_pull_outcome: "disabled", enabled: false });
    expect(after?.last_pulled_at).not.toBeNull();

    // anon holds the token here — the old forgery's exact shape — and still
    // moves nothing: the row reads as the service role left it
    const forged = await anon.rpc("record_portal_pull", args("Forged/1.0"));
    expect(forged.error?.code).toBe("42501");
    expect(await read()).toEqual(after);
    // …and 0097's anon writer is gone from the API, so nothing else forges it
    const old = await anon.rpc("note_portal_pull", { p_token_sha256: tokenSha256, p_ua: "Forged/1.0", p_count: 999 });
    expect(old.error?.code).toBe("PGRST202");
    expect(await read()).toEqual(after);
  });

  it("anon cannot read either table directly", async () => {
    const a = await anon.from("portal_listings").select("portal");
    expect(a.error?.code).toBe("42501");
  });

  // ADDED (0150): the two tables the route's writes keep are not anon's
  // either — the history names a connection's outcomes, the export state its
  // listings' revisions.
  it("anon cannot read the pull history or the export state", async () => {
    for (const table of ["portal_pull_log", "portal_export_state"]) {
      const r = await anon.from(table).select("org_id");
      expect(r.error?.code, table).toBe("42501");
    }
  });
});

/**
 * The restore pack's 0150 / 0151 row (scripts/backup/verify-restore.sql),
 * exactly as the pack carries it: green against this database, and reading
 * each drift it exists for as drift — in rolled-back transactions, so nothing
 * here outlives the test. Here rather than in portal-feed-integrity.test.ts
 * because this is the portal suite that owns the pack's portal rows.
 */
describe("the restore pack's 0150 / 0151 row", () => {
  let pg: Client;
  beforeAll(async () => {
    pg = new Client({ connectionString: DB_URL });
    await pg.connect();
  });
  afterAll(async () => {
    await pg.end();
  });

  const rolledBack = async (fn: () => Promise<void>) => {
    await pg.query("begin");
    try {
      await fn();
    } finally {
      await pg.query("rollback");
    }
  };

  const packRow = () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const start = "  select 'SECURITY: a portal feed opens only with its URL''s token";
    const from = pack.indexOf(start);
    expect(from, "the pack carries the 0150 / 0151 row").toBeGreaterThan(0);
    return `select * from (${pack.slice(from, pack.indexOf("\n  union all\n", from))}) r(check_name, expected, actual)`;
  };
  const actual = async () => (await pg.query<{ actual: string }>(packRow())).rows[0]!.actual;

  it("passes against a database at 0151", async () => {
    const now = (await pg.query<{ expected: string; actual: string }>(packRow())).rows[0]!;
    expect(now.expected).toBe("0 0 2 2 7");
    expect(now.actual).toBe(now.expected);
  });

  it("reads 0097's digest readers back (revert 0151), and 0095's whole posture (revert 0150 too), as drift", async () => {
    await rolledBack(async () => {
      await pg.query(REVERT_0151_SQL);
      // three anon functions compare the column to their argument, and exist
      expect(await actual()).toBe("3 3 2 2 7");
      await pg.query(REVERT_0150_SQL);
      // no hashing reader, no service-role write, and a session may write
      // every pull column there still is
      expect(await actual()).toBe("3 3 0 0 0");
    });
  });

  it("reads a reader that compares the column to its argument as drift", async () => {
    await rolledBack(async () => {
      // same signature and return shape, so the grants survive the replace:
      // only the comparison changes
      await pg.query(`create or replace function public.portal_feed_supplement(p_token text)
        returns table (reference text, lat double precision, lng double precision, location_approx boolean, images jsonb)
        language sql stable security definer set search_path = public as $$
          select p.reference, null::float8, null::float8, p.location_approx, '[]'::jsonb
            from portal_connections c
            join portal_listings pl on pl.org_id = c.org_id and pl.portal = c.portal
            join properties p on p.id = pl.property_id and p.org_id = c.org_id
           where c.feed_token_sha256 = p_token and c.enabled
        $$`);
      expect(await actual()).toBe("1 0 1 2 7");
    });
  });

  it("reads a write granted beyond service_role, or a session-writable pull column, as drift", async () => {
    await rolledBack(async () => {
      await pg.query("grant execute on function public.record_portal_pull(text, text, text, integer, integer, integer, text, jsonb) to authenticated");
      expect(await actual()).toBe("0 0 2 1 7");
    });
    await rolledBack(async () => {
      await pg.query("grant execute on function public.sync_portal_export(text, jsonb) to anon");
      expect(await actual()).toBe("0 0 2 1 7");
    });
    await rolledBack(async () => {
      await pg.query("grant update (last_pulled_at) on table public.portal_connections to authenticated");
      expect(await actual()).toBe("0 0 2 2 6");
    });
    await rolledBack(async () => {
      await pg.query("grant execute on function public.portal_feed_connection(text, text) to authenticated");
      expect(await actual()).toBe("0 0 1 2 7");
    });
  });
});
