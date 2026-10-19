import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * A05 against a REAL PostgREST + Postgres behind the local gateway, as an aal2
 * admin session, through the reads AND the real pages:
 *
 *   1. the lineage of a unit under a phase is project › phase, read in two
 *      requests by primary key; a unit directly under a project is one;
 *   2. a parent in ANOTHER organisation (properties.parent_id is still a
 *      single-column key — BACKLOG) is hidden by RLS and said as "not visible",
 *      never shown and never read as "standalone"; a parent of the wrong kind
 *      is said as such;
 *   3. a phased project's availability is every unit under the project and its
 *      LIVE phases (archived units and archived phases' units left out — the
 *      container-units.ts definition), with each unit's LIVE hold only (a
 *      released hold is history), through the embedded
 *      properties!inner(parent_id) filter on reservations;
 *   4. the units page of a phased project says the true count across phases,
 *      renders the read-only overview, keeps its matrix to direct units, and
 *      carries the breadcrumb; the matrix row a unit page links to is marked;
 *   5. the unit's page has the breadcrumb and a "Part of" fact whose matrix
 *      link lands on the unit's row;
 *   6. reading changes nothing: no event is written; the chain verifies.
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const FOREIGN = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  /** every GET the session's client sends to properties — to count lineage reads */
  const gets: string[] = [];
  return { als: new AsyncLocalStorage<unknown>(), gets };
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
  useRouter: () => ({ refresh: () => {} }),
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

import PropertyDetailPage from "@/app/(app)/properties/[id]/page";
import ProjectUnitsPage from "@/app/(app)/properties/[id]/units/page";
import { AvailabilityOverview } from "@/components/features/properties/availability-overview";
import { PropertyBreadcrumb } from "@/components/features/properties/property-breadcrumb";
import { UnitsMatrix, type UnitRow } from "@/components/features/properties/units-matrix";
import { fetchContainerAvailability } from "@/lib/queries/container-availability";
import { fetchLineage } from "@/lib/queries/property-lineage";
import type { Lineage } from "@/lib/services/property-lineage";
import { formatDate } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
let o: Client;
let svc: SupabaseClient;
let admin: TestUser;
/** the admin's session, its property GETs recorded */
let session: SupabaseClient;

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

/** A render's words: React's text-node separators dropped, tags read as spaces. */
const plain = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

let seq = 0;
async function insertProperty(cols: Record<string, unknown>, org = ORG): Promise<{ id: string; reference: string }> {
  const all: Record<string, unknown> = {
    org_id: org,
    reference: `LN${TAG}${String(++seq).padStart(3, "0")}`,
    status: "available",
    property_type: "apartment",
    visibility: "private",
    ...cols,
  };
  const names = Object.keys(all);
  const { rows } = await o.query<{ id: string; reference: string }>(
    `insert into properties (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id, reference`,
    Object.values(all),
  );
  return rows[0]!;
}
async function hold(propertyId: string, status: string, contactId: string | null, expiresAt: string) {
  await o.query(
    `insert into reservations (org_id, property_id, contact_id, status, held_from, expires_at, released_at)
     values ($1, $2, $3, $4::reservation_status, now() - interval '2 days', $5::timestamptz,
             case when $4 = 'released' then now() - interval '1 day' end)`,
    [ORG, propertyId, contactId, status, expiresAt],
  );
}
const eventCount = async () =>
  Number((await o.query<{ n: string }>("select count(*) as n from events where org_id = $1", [ORG])).rows[0]!.n);

let project: { id: string; reference: string };
let phase1: { id: string; reference: string };
let archivedPhase: { id: string; reference: string };
let u1: { id: string; reference: string };
let u2: { id: string; reference: string };
let direct: { id: string; reference: string };
let archivedUnit: { id: string; reference: string };
let underArchivedPhase: { id: string; reference: string };
let standalone: { id: string; reference: string };
let underStandalone: { id: string; reference: string };
let foreignProject: { id: string; reference: string };
let underForeign: { id: string; reference: string };
let emptyPhased: { id: string; reference: string };
let phaseOnly: { id: string; reference: string };
let eventsBefore = 0;
// RELATIVE to the run (A05 review): a fixed expiry turned "Confirmed to …"
// into "lapsed" once that day passed, and then failed every hold() insert on
// reservation_window_ordered (expires_at > held_from = now() - 2 days)
const HELD_TO = new Date(Date.now() + 30 * 86_400_000).toISOString();

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `Lineage ${RUN}`, `lineage-${RUN}`);
  await ensureTestOrg(svc, FOREIGN, `Lineage foreign ${RUN}`, `lineage-foreign-${RUN}`);
  admin = await createTestUser(svc, `ln-admin-${RUN}@test.local`, "admin", ORG);
  // the same signed-in session, its GETs to properties recorded
  const base = admin.client;
  session = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => {
          if (table === "properties") ctx.gets.push(table);
          return target.from(table);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as SupabaseClient;

  project = await insertProperty({ kind: "project", title: { en: "Lineage project" }, delivery_date: "2028-03-31" });
  phase1 = await insertProperty({
    kind: "phase",
    parent_id: project.id,
    title: { en: "Phase one" },
    delivery_date: "2027-06-30",
    construction_status: "under_construction",
  });
  archivedPhase = await insertProperty({ kind: "phase", parent_id: project.id, visibility: "archived" });
  u1 = await insertProperty({ kind: "unit", parent_id: phase1.id, unit_number: "101", block: "A", asking_price: 250000, delivery_date: "2027-06-30" });
  u2 = await insertProperty({ kind: "unit", parent_id: phase1.id, unit_number: "102", block: "A", status: "reserved", delivery_date: "2027-12-31" });
  direct = await insertProperty({ kind: "unit", parent_id: project.id, unit_number: "001", transaction_type: "rent", rent_price_month: 1400, delivery_date: "2028-03-31" });
  archivedUnit = await insertProperty({ kind: "unit", parent_id: phase1.id, unit_number: "199", visibility: "archived" });
  underArchivedPhase = await insertProperty({ kind: "unit", parent_id: archivedPhase.id, unit_number: "301" });
  standalone = await insertProperty({ kind: "standalone" });
  underStandalone = await insertProperty({ kind: "unit", parent_id: standalone.id, unit_number: "9" });
  foreignProject = await insertProperty({ kind: "project" }, FOREIGN);
  // the defect BACKLOG records: parent_id is not org-bound, so this is accepted
  underForeign = await insertProperty({ kind: "unit", parent_id: foreignProject.id, unit_number: "7" });
  // a project whose only phase is still empty (just created): units nowhere
  emptyPhased = await insertProperty({ kind: "project" });
  await insertProperty({ kind: "phase", parent_id: emptyPhased.id });
  // a project whose units are ALL in its phase: none directly under it
  phaseOnly = await insertProperty({ kind: "project" });
  const phaseOnlyPhase = await insertProperty({ kind: "phase", parent_id: phaseOnly.id });
  await insertProperty({ kind: "unit", parent_id: phaseOnlyPhase.id, unit_number: "1" });

  const buyer = (
    await o.query<{ id: string }>("insert into contacts (org_id, first_name, last_name) values ($1, 'Lineage', 'Buyer') returning id", [ORG])
  ).rows[0]!.id;
  await hold(u1.id, "held", buyer, HELD_TO); // status Available + a live hold: said
  await hold(u2.id, "released", buyer, HELD_TO); // history, not a live hold
  await hold(direct.id, "confirmed", null, HELD_TO);
  await hold(underArchivedPhase.id, "held", null, HELD_TO); // under an archived phase: not this project's inventory
  eventsBefore = await eventCount();
}, 300_000);

afterAll(async () => {
  if (!o) return;
  await o.query("delete from reservations where org_id = $1", [ORG]);
  await o.query("delete from properties where org_id = $1 and kind = 'unit'", [ORG]);
  await o.query("delete from properties where org_id = $1 and kind = 'phase'", [ORG]);
  await o.query("delete from properties where org_id = any($1::uuid[])", [[ORG, FOREIGN]]);
  await o.query("delete from contacts where org_id = $1", [ORG]);
  if (admin) await svc.auth.admin.deleteUser(admin.id);
  for (const org of [ORG, FOREIGN]) {
    for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
      await o.query(`delete from ${t} where org_id = $1`, [org]);
    }
    await o.query("delete from organizations where id = $1", [org]);
  }
  await o.end();
}, 120_000);

// ---------------------------------------------------------------------------
describe("the lineage read, on the caller's client", () => {
  it("a unit under a phase: project › phase, in two reads by primary key", async () => {
    ctx.gets.length = 0;
    const l = await fetchLineage(session as never, { id: u1.id, kind: "unit", parent_id: phase1.id });
    expect(l.issue).toBeNull();
    expect(l.chain.map((n) => [n.reference, n.kind])).toEqual([
      [project.reference, "project"],
      [phase1.reference, "phase"],
    ]);
    expect(l.chain[1]!.title).toBe("Phase one");
    expect(ctx.gets).toHaveLength(2);
  });

  it("a unit directly under a project: one read", async () => {
    ctx.gets.length = 0;
    const l = await fetchLineage(session as never, { id: direct.id, kind: "unit", parent_id: project.id });
    expect(l).toMatchObject({ issue: null, chain: [{ id: project.id, kind: "project" }] });
    expect(ctx.gets).toHaveLength(1);
  });

  it("another organisation's parent is hidden by RLS — said as not visible, never shown, never 'standalone'", async () => {
    const l = await fetchLineage(session as never, { id: underForeign.id, kind: "unit", parent_id: foreignProject.id });
    expect(l.chain).toEqual([]);
    expect(l.issue?.code).toBe("parent_unreadable");
    console.log(`[evidence] cross-org parent ${foreignProject.reference}: ${l.issue?.text}`);
  });

  it("a parent of the wrong kind is said, and shown as what it is", async () => {
    const l = await fetchLineage(session as never, { id: underStandalone.id, kind: "unit", parent_id: standalone.id });
    expect(l.chain.map((n) => n.id)).toEqual([standalone.id]);
    expect(l.issue?.code).toBe("unexpected_parent_kind");
    expect(l.issue?.text).toContain(`recorded under ${standalone.reference}, a standalone`);
  });
});

describe("availability across a phased project (the container-units definition)", () => {
  it("every unit under the project and its live phases; live holds only", async () => {
    const r = await fetchContainerAvailability(session as never, { id: project.id, kind: "project" });
    expect(r.overview?.phases.map((p) => p.reference)).toEqual([phase1.reference]);
    const ids = new Set(r.overview!.units.map((u) => u.id));
    expect(ids).toEqual(new Set([u1.id, u2.id, direct.id]));
    // archived units, and an archived phase's units, are not inventory
    expect(ids.has(archivedUnit.id)).toBe(false);
    expect(ids.has(underArchivedPhase.id)).toBe(false);
    // the live holds, through properties!inner(parent_id): a released hold is history
    expect([...r.holds.keys()].sort()).toEqual([u1.id, direct.id].sort());
    expect(r.holds.get(u1.id)).toMatchObject({ status: "held", buyer: "Lineage Buyer" });
    expect(r.holds.get(direct.id)).toMatchObject({ status: "confirmed", buyer: null });
    expect(r.holds.has(underArchivedPhase.id)).toBe(false);
    const rent = r.overview!.units.find((u) => u.id === direct.id)!;
    // PostgREST numeric is a number (measured), so nothing is coerced
    expect(rent.rent_price_month).toBe(1400);
  });

  it("a phase: its own holds only, no overview", async () => {
    const r = await fetchContainerAvailability(session as never, { id: phase1.id, kind: "phase" });
    expect(r.overview).toBeNull();
    expect([...r.holds.keys()]).toEqual([u1.id]);
  });
});

describe("the REAL units page", () => {
  const unitsPage = async (id: string, search: Record<string, string> = {}) =>
    [
      ...walk(
        (await ctx.als.run(admin.client, () =>
          ProjectUnitsPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(search) }),
        )) as ReactNode,
      ),
    ];

  it("a phased project: the true count across phases, the read-only overview, the matrix of direct units", async () => {
    const tree = await unitsPage(project.id);
    const header = tree.find((e) => e.type === "p" && /units? across/.test(plain(renderToStaticMarkup(e))));
    expect(header, "the header names the count across phases").toBeTruthy();
    expect(plain(renderToStaticMarkup(header!))).toBe(
      "3 units across 1 phase (1 directly under the project) · 2 available · 1 reserved",
    );

    const overview = tree.find((e) => e.type === AvailabilityOverview);
    expect(overview, "the consolidated view renders on a phased project").toBeTruthy();
    const markup = renderToStaticMarkup(overview!);
    const html = plain(markup);
    expect(html).toContain(phase1.reference);
    expect(html).toContain("delivery 30 Jun 2027");
    expect(html).toContain("Status still says Available");
    expect(html).toContain("Lineage Buyer");
    // u2's own date differs from its phase's
    expect(html).toContain("differs from the phase");
    expect(html).not.toContain(archivedUnit.reference);
    expect(markup).not.toMatch(/<(form|select|button)\b/);

    const matrix = tree.find((e) => e.type === UnitsMatrix)!;
    const rows = matrix.props.units as UnitRow[];
    expect(rows.map((u) => u.id)).toEqual([direct.id]);
    expect(rows[0]!.hold?.label).toBe(`Confirmed to ${formatDate(HELD_TO)}`);

    const crumb = tree.find((e) => e.type === PropertyBreadcrumb)!;
    expect((crumb.props.lineage as Lineage).chain).toEqual([]);
    expect(renderToStaticMarkup(crumb)).toContain(`${project.reference}`);
  });

  it("a phase's units page: back to its project, the linked row marked, no overview", async () => {
    const tree = await unitsPage(phase1.id, { unit: u1.id });
    expect(tree.find((e) => e.type === AvailabilityOverview)).toBeUndefined();
    const crumb = tree.find((e) => e.type === PropertyBreadcrumb)!;
    const text = plain(renderToStaticMarkup(crumb));
    expect(text).toBe(`Properties › ${project.reference} Project › ${phase1.reference} Phase › Units`);
    const matrix = tree.find((e) => e.type === UnitsMatrix)!;
    expect(matrix.props.highlightId).toBe(u1.id);
    expect((matrix.props.units as UnitRow[]).map((u) => u.id)).toEqual([u1.id, u2.id]);
    expect((matrix.props.units as UnitRow[])[1]!.hold?.note).toBe("Reserved, but no live hold is recorded");
  });

  it("a ?unit= that is not an id is ignored, not queried", async () => {
    const tree = await unitsPage(phase1.id, { unit: "not-an-id" });
    expect(tree.find((e) => e.type === UnitsMatrix)!.props.highlightId).toBeNull();
  });

  it("a project whose only phase is still empty: no units anywhere, and the matrix keeps its add-first hint", async () => {
    const tree = await unitsPage(emptyPhased.id);
    const overview = tree.find((e) => e.type === AvailabilityOverview);
    expect(overview, "a phased project still gets the consolidated view").toBeTruthy();
    expect(plain(renderToStaticMarkup(overview!))).toContain("No units yet in this project or its phases.");
    const matrix = tree.find((e) => e.type === UnitsMatrix)!;
    expect(matrix.props.units).toEqual([]);
    // never "its units are in its phases" when the phases hold none
    expect(matrix.props.emptyText).toBe("No units yet — add the first one below.");
  });

  it("a project whose units are all in its phases: the empty direct matrix points at them", async () => {
    const tree = await unitsPage(phaseOnly.id);
    const matrix = tree.find((e) => e.type === UnitsMatrix)!;
    expect(matrix.props.units).toEqual([]);
    expect(matrix.props.emptyText).toBe("None — this project's units are in its phases (above).");
  });
});

describe("the REAL property page", () => {
  const detailPage = async (id: string) =>
    [
      ...walk(
        (await ctx.als.run(admin.client, () =>
          PropertyDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
        )) as ReactNode,
      ),
    ];

  it("a unit under a phase: the breadcrumb, and 'Part of' with its row in the matrix", async () => {
    const tree = await detailPage(u1.id);
    const crumb = tree.find((e) => e.type === PropertyBreadcrumb)!;
    expect((crumb.props.lineage as Lineage).chain.map((n) => n.id)).toEqual([project.id, phase1.id]);
    const partOf = tree.find((e) => e.key === "Part of");
    expect(partOf, "the Overview carries a Part of fact").toBeTruthy();
    const html = renderToStaticMarkup(partOf!);
    expect(html).toContain(`href="/properties/${phase1.id}"`);
    expect(html).toContain(`href="/properties/${project.id}"`);
    expect(html).toContain(`href="/properties/${phase1.id}/units?unit=${u1.id}#unit-${u1.id}"`);
    const kind = tree.find((e) => e.key === "Kind")!;
    expect(renderToStaticMarkup(kind)).toContain(">Unit<");
  });

  it("an archived unit: 'Part of' still names its phase, but no link to a matrix row that is not there", async () => {
    const tree = await detailPage(archivedUnit.id);
    const html = renderToStaticMarkup(tree.find((e) => e.key === "Part of")!);
    expect(html).toContain(`href="/properties/${phase1.id}"`);
    expect(html).not.toContain("/units?unit=");
    expect(plain(html)).toContain("Archived — not listed in the units matrix");
  });

  it("a unit whose parent is another organisation's: the page renders and says so", async () => {
    const tree = await detailPage(underForeign.id);
    const partOf = plain(renderToStaticMarkup(tree.find((e) => e.key === "Part of")!));
    expect(partOf).toContain("not visible to you");
    expect(partOf).not.toContain("units matrix");
    expect(partOf).not.toContain(foreignProject.id);
  });

  it("a standalone has no 'Part of' fact and a two-item trail", async () => {
    const tree = await detailPage(standalone.id);
    expect(tree.find((e) => e.key === "Part of")).toBeUndefined();
    const crumb = tree.find((e) => e.type === PropertyBreadcrumb)!;
    expect((crumb.props.lineage as Lineage)).toEqual({ chain: [], issue: null });
  });
});

describe("reading changes nothing", () => {
  it("no event was written, and the chain verifies", async () => {
    expect(await eventCount()).toBe(eventsBefore);
    const { rows } = await o.query("select ok, reason from public.verify_events_chain($1::uuid, null::bigint)", [ORG]);
    expect(rows[0]).toMatchObject({ ok: true });
  });
});
