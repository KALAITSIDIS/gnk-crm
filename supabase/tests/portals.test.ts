/**
 * 0095 — portal syndication. Who may write the connection, who may select a
 * listing, what a token reveals, and that "on a portal" ⊆ "on the site" can
 * actually FAIL. Requires the local stack: npm run test:rls
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eligibilityInputFromProperty } from "@/lib/services/portals/eligibility";
import { PORTAL_ID_PATTERN } from "@/lib/services/portals/registry";
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
let publicId = "";
let privateId = "";
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

  const { data: conn, error } = await svc
    .from("portal_connections")
    .upsert({ org_id: ORG_A, portal: PORTAL, enabled: true }, { onConflict: "org_id,portal" })
    .select("feed_token")
    .single();
  if (error) throw new Error(error.message);
  token = conn.feed_token as string;

  publicId = await mkProperty(ORG_A, ref("P"), "public", agentA.id);
  privateId = await mkProperty(ORG_A, ref("X"), "private", null);
  orgBPropertyId = await mkProperty(ORG_B, ref("B"), "public", null);

  const { data: media, error: mErr } = await svc
    .from("property_media")
    .insert([
      { org_id: ORG_A, property_id: publicId, kind: "photo", path_full: `t/${run}_1_full.webp`, path_jpeg: `t/${run}_1_jpeg.jpg`, is_cover: true, sort_order: 0, alt: { en: "Front" } },
      // `alt` is NOT NULL, and PostgREST sends an explicit null for a key one row
      // in a batch omits — so every row names it, and these two name themselves
      // so a leak into `images` would be obvious rather than an empty object.
      { org_id: ORG_A, property_id: publicId, kind: "photo", path_full: `t/${run}_2_full.webp`, path_jpeg: null, is_cover: false, sort_order: 1, alt: { en: "No JPEG" } },
      { org_id: ORG_A, property_id: publicId, kind: "floor_plan", path_full: `t/${run}_3_full.webp`, path_jpeg: `t/${run}_3_jpeg.jpg`, is_cover: false, sort_order: 2, alt: { en: "Floor plan" } },
    ])
    .select("id");
  if (mErr) throw new Error(mErr.message);
  mediaIds = (media ?? []).map((m) => m.id as string);
});

afterAll(async () => {
  await svc.from("property_media").delete().in("id", mediaIds);
  await svc.from("properties").delete().in("id", [publicId, privateId, orgBPropertyId]);
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
    const upd = await adminA.client.from("portal_connections").update({ settings: { email: "x@y.zz" } }).eq("portal", PORTAL).select("id");
    expect(upd.error).toBeNull();
    expect(upd.data).toHaveLength(1);
    const a = await anon.from("portal_connections").select("feed_token");
    expect(a.error?.code ?? "42501").toBe("42501");
  });

  it("the database's portal-id check agrees with the registry's PORTAL_ID_PATTERN", async () => {
    expect(PORTAL_ID_PATTERN.test("Not-Valid")).toBe(false);
    const bad = await svc.from("portal_connections").insert({ org_id: ORG_A, portal: "Not-Valid" });
    expect(bad.error?.code).toBe("23514");
    expect(PORTAL_ID_PATTERN.test("zz_probe")).toBe(true);
    const good = await svc.from("portal_connections").insert({ org_id: ORG_A, portal: "zz_probe" }).select("id").single();
    expect(good.error).toBeNull();
    await svc.from("portal_connections").delete().eq("id", good.data!.id);
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

  it("a delete by someone who may not edit the listing matches 0 rows", async () => {
    const del = await adminB.client.from("portal_listings").delete().eq("property_id", publicId).select("portal");
    expect(del.data).toHaveLength(0);
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
  afterAll(async () => {
    await svc.from("portal_listings").delete().in("property_id", [publicId, privateId]);
    await svc.from("portal_connections").update({ enabled: true }).eq("feed_token", token);
  });

  const siteRefs = async () =>
    ((await anon.rpc("public_listings", { p_org_slug: "test-org-a", p_limit: 100 })).data ?? []).map((r: { reference: string }) => r.reference);
  const portalRefs = async () =>
    ((await anon.rpc("portal_supplement", { p_token: token })).data ?? []).map((r: { reference: string }) => r.reference);

  it("a wrong token answers nothing; the right one answers the org slug", async () => {
    const wrong = await anon.rpc("portal_connection_by_token", { p_portal: PORTAL, p_token: "f".repeat(64) });
    expect(wrong.error).toBeNull();
    expect(wrong.data).toHaveLength(0);
    const right = await anon.rpc("portal_connection_by_token", { p_portal: PORTAL, p_token: token });
    expect(right.data?.[0]).toMatchObject({ org_slug: "test-org-a", enabled: true });
    const otherPortal = await anon.rpc("portal_connection_by_token", { p_portal: "properstar", p_token: token });
    expect(otherPortal.data).toHaveLength(0);
  });

  it("portal_supplement returns the selected public listing with exact coords and only JPEG photos, never the private one", async () => {
    const { data, error } = await anon.rpc("portal_supplement", { p_token: token });
    expect(error).toBeNull();
    const refs = (data ?? []).map((r: { reference: string }) => r.reference);
    expect(refs).toContain(ref("P"));
    expect(refs).not.toContain(ref("X"));
    const row = (data ?? []).find((r: { reference: string }) => r.reference === ref("P"))!;
    // lat is the second POINT coordinate, lng the first — a swapped st_x/st_y fails here
    expect(row.lat).toBeCloseTo(34.88, 5);
    expect(row.lng).toBeCloseTo(32.38, 5);
    expect(row.location_approx).toBe(false);
    expect(row.images).toEqual([{ jpeg: `t/${run}_1_jpeg.jpg`, alt: { en: "Front" } }]);
  });

  it("the supplement's predicate is the site feed's: a sold listing leaves both", async () => {
    await svc.from("properties").update({ status: "sold" }).eq("id", publicId);
    expect(await portalRefs()).not.toContain(ref("P"));
    expect(await siteRefs()).not.toContain(ref("P"));
    await svc.from("properties").update({ status: "available" }).eq("id", publicId);
  });

  // ADDED (Task 6 review): the pin must be able to fail in both directions.
  it("…and a listing made private leaves both, then returns to both when made public again", async () => {
    expect(await portalRefs()).toContain(ref("P"));
    expect(await siteRefs()).toContain(ref("P"));
    await svc.from("properties").update({ visibility: "private" }).eq("id", publicId);
    expect(await portalRefs()).not.toContain(ref("P"));
    expect(await siteRefs()).not.toContain(ref("P"));
    await svc.from("properties").update({ visibility: "public" }).eq("id", publicId);
    expect(await portalRefs()).toContain(ref("P"));
    expect(await siteRefs()).toContain(ref("P"));
  });

  // ADDED (Task 5 review): the toggle's copy of THE PREDICATE agrees with SQL on the same row.
  it("eligibilityInputFromProperty.isPublic agrees with public_listings on the same row", async () => {
    const readRow = async (id: string) => {
      const { data } = await svc
        .from("properties")
        .select("visibility, status, transaction_type, asking_price, rent_price_month, currency, public_description, property_type")
        .eq("id", id)
        .single();
      return { ...data!, districtName: null, areaName: null, jpegPhotoCount: 0, coords: null };
    };
    expect(eligibilityInputFromProperty(await readRow(publicId)).isPublic).toBe(true);
    expect(await siteRefs()).toContain(ref("P"));
    await svc.from("properties").update({ status: "reserved" }).eq("id", publicId);
    expect(eligibilityInputFromProperty(await readRow(publicId)).isPublic).toBe(false);
    expect(await siteRefs()).not.toContain(ref("P"));
    await svc.from("properties").update({ status: "available" }).eq("id", publicId);
    expect(eligibilityInputFromProperty(await readRow(privateId)).isPublic).toBe(false);
  });

  it("a disabled connection answers an empty supplement", async () => {
    await svc.from("portal_connections").update({ enabled: false }).eq("feed_token", token);
    const sup = await anon.rpc("portal_supplement", { p_token: token });
    expect(sup.data).toHaveLength(0);
  });

  it("note_portal_pull records the pull, clamped", async () => {
    const { error } = await anon.rpc("note_portal_pull", { p_token: token, p_ua: "Test Crawler/1.0", p_count: -5 });
    expect(error).toBeNull();
    const { data } = await svc.from("portal_connections").select("last_pulled_ua, last_pull_count, last_pulled_at").eq("feed_token", token).single();
    expect(data).toMatchObject({ last_pulled_ua: "Test Crawler/1.0", last_pull_count: 0 });
    expect(data?.last_pulled_at).not.toBeNull();
  });

  it("anon cannot read either table directly", async () => {
    const a = await anon.from("portal_listings").select("portal");
    expect(a.error?.code ?? "42501").toBe("42501");
  });
});
