import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * F03 through the REAL property page, worklist page, admin dashboard line and
 * Details action, against a REAL PostgREST + Postgres behind the local
 * gateway, as aal2 sessions (an admin and a listing manager):
 *
 *   1. a public, available listing with NO photograph scores 85 — above the
 *      publish threshold — and is now named as public WITHOUT A WEBSITE
 *      ESSENTIAL: in the worklist (for the admin AND the listing manager, whose
 *      mandates come through mandates_safe), on the dashboard line (which is
 *      amber and names it, while saying separately that every public listing
 *      clears 70), and in the property page's readiness panel. A private
 *      no-photo listing is not called public;
 *   2. the dashboard and the worklist are one computation: the same listing,
 *      the same fresh score;
 *   3. a project's build contradiction and the units inheriting it are ONE
 *      group in the worklist, and a unit's page says where it is corrected; a
 *      unit that no longer inherits the build columns stands alone;
 *   4. for an approximate (centroid) point the ring, the stored score, the
 *      worklist and the publish gate's refusal all say the same number — the
 *      gate builds its input through buildQualityInput now;
 *   5. the gate POLICY is unchanged (part F is the operator's open decision,
 *      BACKLOG LST-09): an 85-point listing with no photograph still
 *      publishes, with no override event — and is then flagged, not blocked;
 *   6. reading changes nothing: no listing's visibility moves and no event is
 *      written by any of the renders; the event chain verifies.
 *
 * A THROWAWAY ORGANISATION, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `listing-readiness-${RUN}`;
const DELIVERY_PASSED = "The delivery date has passed and the build is not recorded as finished.";

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>() };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound()");
  },
  redirect: (to: string) => {
    throw new Error(`redirect(${to})`);
  },
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/services/site-revalidate", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifySiteAfter: vi.fn(),
  notifySiteIfPublic: vi.fn(async () => {}),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("./helpers");
  return { createAdminClient: () => h.serviceClient() };
});
// the dashboard line's strings, from the real English messages
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const en = (await import("@/messages/en.json")).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({
        locale: "en",
        messages: en,
        namespace: namespace as never,
        onError: (e) => {
          throw e;
        },
      }),
  };
});

import PropertyDetailPage from "@/app/(app)/properties/[id]/page";
import PropertyWorklistPage from "@/app/(app)/properties/worklist/page";
import { ListingHealth } from "@/components/features/dashboard/listing-health";
import { ListingReadiness } from "@/components/features/properties/listing-readiness";
import { QualityWorklist } from "@/components/features/properties/quality-worklist";
import { QualityScoreRing } from "@/components/features/shared/quality-score-ring";
import { updatePropertySection } from "@/lib/actions/properties";
import { recomputeQualityScore, type QualityScoreResult } from "@/lib/services/quality-score";
import type { Worklist } from "@/lib/services/quality-worklist";
import { detailsFormPost } from "@/lib/testing/details-form-post";

// ---------------------------------------------------------------------------
let o: Client;
let svc: SupabaseClient;
let admin: TestUser;
let manager: TestUser;
const userIds: string[] = [];

type Element = ReactElement<Record<string, unknown>>;
function* walk(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!isValidElement(node)) return;
  const el = node as Element;
  yield el;
  yield* walk(el.props.children);
}

async function pageTree(user: TestUser, id: string): Promise<Element[]> {
  const root = (await ctx.als.run(user.client, () =>
    PropertyDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
  )) as ReactNode;
  return [...walk(root)];
}
async function readiness(user: TestUser, id: string) {
  const tree = await pageTree(user, id);
  const panel = tree.find((e) => e.type === ListingReadiness);
  const ring = tree.find((e) => e.type === QualityScoreRing);
  if (!panel || !ring) throw new Error("the page rendered no readiness panel or no ring");
  return {
    quality: panel.props.quality as QualityScoreResult,
    buildSource: panel.props.buildSource as { id: string; reference: string } | null,
    ringScore: ring.props.score as number,
    html: renderToStaticMarkup(panel),
  };
}
async function worklistOf(user: TestUser): Promise<Worklist> {
  const root = (await ctx.als.run(user.client, () => PropertyWorklistPage())) as ReactNode;
  const el = [...walk(root)].find((e) => e.type === QualityWorklist);
  if (!el) throw new Error("the page rendered no worklist");
  return el.props.worklist as Worklist;
}
async function dashboardLine(user: TestUser): Promise<string> {
  const el = (await ctx.als.run(user.client, () => ListingHealth())) as ReactElement;
  return renderToStaticMarkup(el);
}
const lineText = (html: string, key: string) =>
  (html.match(new RegExp(`<li[^>]*data-line="${key}"[^>]*>([\\s\\S]*?)</li>`))?.[1] ?? "")
    .replace(/<[^>]+>/g, "")
    .trim();

let seq = 0;
async function insertProperty(cols: Record<string, unknown>): Promise<{ id: string; reference: string }> {
  const all: Record<string, unknown> = {
    org_id: ORG,
    reference: `LR${TAG}${String(++seq).padStart(3, "0")}`,
    status: "available",
    ...cols,
  };
  const names = Object.keys(all);
  const { rows } = await o.query<{ id: string; reference: string }>(
    `insert into properties (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id, reference`,
    Object.values(all),
  );
  return rows[0]!;
}
async function mandate(propertyId: string) {
  await o.query("insert into mandates (org_id, property_id, type, status) values ($1, $2, 'exclusive', 'active')", [ORG, propertyId]);
}
async function photos(propertyId: string, n: number) {
  await o.query(
    `insert into property_media (org_id, property_id, kind, path_thumb, is_cover, sort_order, content_sha256)
     select $1::uuid, $2::uuid, 'photo', format('properties/%s/%s.jpg', $2::uuid, s), s = 1, s,
            encode(sha256(convert_to($2::text || '-' || s, 'UTF8')), 'hex')
       from generate_series(1, $3::int) s`,
    [ORG, propertyId, n],
  );
}
const stored = async (id: string) =>
  (await o.query<{ quality_score: number; visibility: string }>("select quality_score, visibility from properties where id = $1", [id])).rows[0]!;
const eventCount = async () =>
  Number((await o.query<{ n: string }>("select count(*) as n from events where org_id = $1", [ORG])).rows[0]!.n);

// fixtures
let contactId = "";
let nophoto: { id: string; reference: string };
let privateNophoto: { id: string; reference: string };
let full: { id: string; reference: string };
let approx: { id: string; reference: string };
let gateNophoto: { id: string; reference: string };
let project: { id: string; reference: string };
let unitA: { id: string; reference: string };
let unitB: { id: string; reference: string };
let unitEdited: { id: string; reference: string };

/** Everything but photographs: 85 points (cover 5 and six photos 10 are the gap). */
const complete = () => ({
  property_type: "apartment",
  kind: "standalone",
  title: { en: "Readiness flat" },
  public_description: { en: "A bright flat near the sea. ".repeat(12) },
  asking_price: 265000,
  covered_area_sqm: 88,
  bedrooms: 2,
  bathrooms: 1,
  location: "SRID=4326;POINT(32.4297 34.7720)",
  location_approx: false,
  title_deed_status: "separate",
  permit_status: "full",
  assigned_agent_id: admin.id,
  owner_contact_id: contactId,
});

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `Listing readiness ${RUN}`, SLUG);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `lr-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  manager = await createTestUser(svc, `lr-lm-${RUN}@test.local`, "listing_manager", ORG);
  userIds.push(manager.id);
  contactId = (await o.query<{ id: string }>("insert into contacts (org_id, first_name) values ($1, 'Owner') returning id", [ORG])).rows[0]!.id;

  const published = new Date(Date.now() - 12 * 86_400_000).toISOString();
  nophoto = await insertProperty({ ...complete(), visibility: "public", published_at: published });
  await mandate(nophoto.id);
  privateNophoto = await insertProperty({ ...complete(), visibility: "private" });
  await mandate(privateNophoto.id);
  full = await insertProperty({ ...complete(), visibility: "public", published_at: published });
  await mandate(full.id);
  await photos(full.id, 6);
  // a centroid stand-in, no mandate, no photos: 100 - 15 - 10 - 10 = 65
  approx = await insertProperty({ ...complete(), visibility: "private", location_approx: true });
  gateNophoto = await insertProperty({ ...complete(), visibility: "private" });
  await mandate(gateNophoto.id);

  // a project whose delivery date has passed unfinished, and its units
  project = await insertProperty({
    property_type: "apartment",
    kind: "project",
    visibility: "private",
    title: { en: "Readiness project" },
    construction_status: "under_construction",
    delivery_date: "2025-03-31",
  });
  const unit = (inherited: string[]) =>
    insertProperty({
      property_type: "apartment",
      kind: "unit",
      parent_id: project.id,
      visibility: "private",
      construction_status: "under_construction",
      delivery_date: "2025-03-31",
      inherited_fields: inherited,
    });
  unitA = await unit(["construction_status", "delivery_date", "features"]);
  unitB = await unit(["delivery_date"]);
  // edited since: the same values, but its own now
  unitEdited = await unit(["features"]);

  for (const p of [nophoto, privateNophoto, full, approx, gateNophoto, project, unitA, unitB, unitEdited]) {
    await ctx.als.run(admin.client, () => recomputeQualityScore(admin.client as never, p.id));
  }
}, 300_000);

afterAll(async () => {
  if (!o) return;
  await o.query("delete from property_media where org_id = $1", [ORG]);
  await o.query("delete from mandates where org_id = $1", [ORG]);
  await o.query("delete from properties where org_id = $1 and kind = 'unit'", [ORG]);
  await o.query("delete from properties where org_id = $1", [ORG]);
  await o.query("delete from contacts where org_id = $1", [ORG]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await o.query(`delete from ${t} where org_id = $1`, [ORG]);
  }
  await o.query("delete from organizations where id = $1", [ORG]);
  await o.end();
}, 120_000);

// ---------------------------------------------------------------------------
describe("a public listing with no photograph (85 points) is named as public without a website essential", () => {
  it("the stored score is 85 — above the threshold, which is why it read as healthy", async () => {
    expect((await stored(nophoto.id)).quality_score).toBe(85);
    expect((await stored(full.id)).quality_score).toBe(100);
  });

  for (const who of ["admin", "listing manager"] as const) {
    it(`the worklist names it, and only it, for the ${who}`, async () => {
      const w = await worklistOf(who === "admin" ? admin : manager);
      const named = w.publicMissingEssentials.map((e) => [e.property.reference, e.property.score, e.missing.map((m) => m.key)]);
      console.log(`[evidence] ${who} publicMissingEssentials ${JSON.stringify(named)}; belowThreshold ${JSON.stringify(w.belowThreshold.map((p) => p.reference))}`);
      expect(named).toEqual([[nophoto.reference, 85, ["cover"]]]);
      // a separate statement: it clears the threshold
      expect(w.belowThreshold.map((p) => p.reference)).not.toContain(nophoto.reference);
      expect(w.publicCount).toBe(2);
    });
  }

  it("the dashboard line names it under website essentials, is not green, and says completeness apart", async () => {
    const html = await dashboardLine(admin);
    console.log(`[evidence] dashboard essentials: ${lineText(html, "essentials")} | completeness: ${lineText(html, "completeness")}`);
    expect(html).toContain('data-listing-health="attention"');
    expect(lineText(html, "essentials")).toBe(
      `Website essentials: 1 public listing lacks what the site needs — ${nophoto.reference} (cover photo).`,
    );
    expect(lineText(html, "completeness")).toBe("Completeness: all 2 public listings score 70 or more.");
  });

  it("its page says so in visible text, with the cover linked to the Media tab", async () => {
    const r = await readiness(admin, nophoto.id);
    expect(r.ringScore).toBe(85);
    expect(r.quality.essentialsMissing.map((i) => i.key)).toEqual(["cover"]);
    expect(r.html).toContain("Public on the website without:");
    expect(r.html).toMatch(new RegExp(`href="/properties/${nophoto.id}\\?tab=media"[^>]*>cover photo</a>`));
  });

  it("a private listing missing the same photograph is not called public", async () => {
    const r = await readiness(admin, privateNophoto.id);
    expect(r.html).toContain("Needed before it goes on the website:");
    expect(r.html).not.toContain("Public on the website without");
  });
});

describe("a project's build contradiction and the units inheriting it (one group)", () => {
  it("the worklist lists the project once, with the two units that inherit it; the edited unit stands alone", async () => {
    const w = await worklistOf(admin);
    const groups = w.buildConflictGroups
      .filter((g) => g.source.property.reference.startsWith(`LR${TAG}`))
      .map((g) => [g.source.property.reference, g.source.label, g.inheritedBy.map((p) => p.reference)]);
    console.log(`[evidence] build groups ${JSON.stringify(groups)}`);
    expect(groups).toEqual([
      [project.reference, DELIVERY_PASSED, [unitA.reference, unitB.reference]],
      [unitEdited.reference, DELIVERY_PASSED, []],
    ]);
    expect(w.buildConflicts).toHaveLength(4);
  });

  it("a unit's page says where the contradiction is corrected — on the project", async () => {
    const r = await readiness(admin, unitA.id);
    expect(r.buildSource).toEqual({ id: project.id, reference: project.reference });
    expect(r.html).toContain(`Inherited from`);
    expect(r.html).toContain(`href="/properties/${project.id}/units"`);
    const own = await readiness(admin, unitEdited.id);
    expect(own.buildSource).toBeNull();
    expect(own.html).toMatch(new RegExp(`href="/properties/${unitEdited.id}\\?tab=details"[^>]*>Details tab</a>`));
  });

  it("the dashboard counts four contradictions, two to correct, on a line of their own", async () => {
    const html = await dashboardLine(admin);
    expect(lineText(html, "warnings")).toBe("Data warnings across live listings: 4 build contradictions (2 to correct).");
  });
});

describe("one input builder: the ring, the stored score, the worklist and the gate agree", () => {
  it("for an approximate point, all four say 65", async () => {
    const st = (await stored(approx.id)).quality_score;
    const r = await readiness(admin, approx.id);
    const w = await worklistOf(admin);
    const inWorklist = w.categories.flatMap((c) => c.properties).find((p) => p.id === approx.id)?.score;
    const before = await ctx.als.run(admin.client, async () =>
      (await admin.client.from("properties").select("*").eq("id", approx.id).single()).data as Record<string, unknown>,
    );
    const res = await ctx.als.run(admin.client, () =>
      updatePropertySection({ error: null, savedAt: null }, detailsFormPost(before, { visibility: "public" })),
    );
    console.log(`[evidence] approximate point: stored ${st}, ring ${r.ringScore}, worklist ${inWorklist}, gate "${res.error}"`);
    expect(st).toBe(65);
    expect(r.ringScore).toBe(65);
    expect(inWorklist).toBe(65);
    expect(res.error).toBe('Quality score 65 is below 70. Tick "Override publish gate" to publish anyway.');
    expect((await stored(approx.id)).visibility).toBe("private");
  });

  it("the gate POLICY is unchanged: an 85-point listing with no photograph publishes, with no override — then is flagged", async () => {
    const before = await ctx.als.run(admin.client, async () =>
      (await admin.client.from("properties").select("*").eq("id", gateNophoto.id).single()).data as Record<string, unknown>,
    );
    const res = await ctx.als.run(admin.client, () =>
      updatePropertySection({ error: null, savedAt: null }, detailsFormPost(before, { visibility: "public" })),
    );
    expect(res.error).toBeNull();
    expect((await stored(gateNophoto.id)).visibility).toBe("public");
    const types = (
      await o.query<{ event_type: string }>("select event_type from events where org_id = $1 and entity_id = $2 order by id", [ORG, gateNophoto.id])
    ).rows.map((r) => r.event_type);
    expect(types).toEqual(["updated"]);
    const w = await worklistOf(manager);
    expect(w.publicMissingEssentials.map((e) => e.property.reference).sort()).toEqual(
      [nophoto.reference, gateNophoto.reference].sort(),
    );
  });
});

describe("reading changes nothing", () => {
  it("no visibility moves and no event is written by any page or the dashboard line", async () => {
    const events = await eventCount();
    const visibility = (await o.query("select id, visibility from properties where org_id = $1 order by id", [ORG])).rows;
    await worklistOf(admin);
    await worklistOf(manager);
    await dashboardLine(admin);
    for (const p of [nophoto, privateNophoto, unitA, approx]) await readiness(admin, p.id);
    expect(await eventCount()).toBe(events);
    expect((await o.query("select id, visibility from properties where org_id = $1 order by id", [ORG])).rows).toEqual(visibility);
    expect((await stored(nophoto.id)).visibility).toBe("public");
  });

  it("the organisation's event chain verifies", async () => {
    const { rows } = await o.query("select ok, reason from public.verify_events_chain($1::uuid, null::bigint)", [ORG]);
    expect(rows[0]).toMatchObject({ ok: true });
  });
});
