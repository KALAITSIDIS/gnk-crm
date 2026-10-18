import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * A08 PR 3 — the property page's summary strip, through the REAL page against
 * a REAL PostgREST + Postgres behind the local gateway, as aal2 sessions (an
 * admin and an agent):
 *
 *   1. the next action is ONE read of the next open task through RLS, set
 *      against the next viewing: the admin sees an earlier task assigned to
 *      someone else ("Next task"); the agent cannot see it (tasks_select), so
 *      the viewing comes first for them; a task of their own is "Your next
 *      task", an overdue one says so; done tasks and other properties' tasks
 *      never count; with nothing, "None" — and "your tasks only" for the agent;
 *   2. price, availability (Public but Reserved is said to be off the
 *      website, the rule the header note used to carry), the owner linked —
 *      the developer for a project — the responsible agent with an inactive
 *      one flagged, the mandate's type and expiry or why there is none;
 *   3. "Outstanding" is the readiness panel's count and links to the panel,
 *      which carries the anchor;
 *   4. the header: the title in the h1 beside the reference, the badges
 *      prefixed for a screen reader, ONE "Add task" on the page (in the
 *      summary); the browser-tab title is the reference only;
 *   5. reading changes nothing: no event is written; the chain verifies.
 *
 * A THROWAWAY ORGANISATION, deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();

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

import PropertyDetailPage, { generateMetadata } from "@/app/(app)/properties/[id]/page";
import { ListingReadiness } from "@/components/features/properties/listing-readiness";
import { PropertySummary } from "@/components/features/properties/property-summary";
import { MandateBadge } from "@/components/features/shared/mandate-badge";
import { AddTaskDialog } from "@/components/features/tasks/add-task-dialog";
import type { QualityScoreResult } from "@/lib/services/quality-score";

// ---------------------------------------------------------------------------
let o: Client;
let svc: SupabaseClient;
let admin: TestUser;
let agent: TestUser;
let other: TestUser;
let former: TestUser;
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

/** A render's words: React's text-node separators dropped, tags read as spaces. */
const plain = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

async function pageTree(user: TestUser, id: string): Promise<Element[]> {
  const root = (await ctx.als.run(user.client, () =>
    PropertyDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
  )) as ReactNode;
  return [...walk(root)];
}

/** The summary strip as `user` sees it: each cell's markup and words, by its data-summary name. */
async function summary(user: TestUser, id: string) {
  const tree = await pageTree(user, id);
  const el = tree.find((e) => e.type === PropertySummary);
  if (!el) throw new Error("the page rendered no summary strip");
  const html = renderToStaticMarkup(el);
  const cells = new Map<string, { term: string; html: string; text: string }>();
  for (const m of html.matchAll(
    /<div class="[^"]*" data-summary="([a-z]+)"><dt[^>]*>([\s\S]*?)<\/dt><dd[^>]*>([\s\S]*?)<\/dd><\/div>/g,
  )) {
    cells.set(m[1]!, { term: plain(m[2]!), html: m[3]!, text: plain(m[3]!) });
  }
  const cell = (name: string) => {
    const c = cells.get(name);
    if (!c) throw new Error(`no "${name}" cell in ${plain(html)}`);
    return c;
  };
  return { tree, el, html, cell };
}

let seq = 0;
async function insertProperty(cols: Record<string, unknown>): Promise<{ id: string; reference: string }> {
  const all: Record<string, unknown> = {
    org_id: ORG,
    reference: `PS${TAG}${String(++seq).padStart(3, "0")}`,
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
async function task(
  propertyId: string,
  title: string,
  dueOffset: string | null,
  assignee: string,
  createdBy: string,
  done = false,
): Promise<string> {
  const { rows } = await o.query<{ id: string }>(
    `insert into tasks (org_id, property_id, title, due_at, assignee_id, created_by, is_done, done_at)
     values ($1, $2, $3, case when $4::text is null then null else now() + $4::interval end, $5, $6, $7,
             case when $7 then now() end)
     returning id`,
    [ORG, propertyId, title, dueOffset, assignee, createdBy, done],
  );
  return rows[0]!.id;
}
const eventCount = async () =>
  Number((await o.query<{ n: string }>("select count(*) as n from events where org_id = $1", [ORG])).rows[0]!.n);

// fixtures
let ownerId = "";
let developerId = "";
/** public, available, owned, with an agent, a mandate, tasks and a viewing */
let listing: { id: string; reference: string };
/** public but reserved, rented out by the month, an inactive agent, an expired mandate, an overdue task */
let reserved: { id: string; reference: string };
/** a project with a developer and an owner, no agent, nothing scheduled */
let project: { id: string; reference: string };
/** holds a task due before all the others — which must never be another property's next action */
let elsewhere: { id: string; reference: string };
let viewingId = "";
let eventsBefore = 0;

const TITLE_OTHERS = `PS${TAG} chase the surveyor`;
const TITLE_AGENTS = `PS${TAG} send the owner the offer`;
const TITLE_DONE = `PS${TAG} done already`;
const TITLE_OVERDUE = `PS${TAG} call the tenant back`;
const TITLE_ELSEWHERE = `PS${TAG} another listing's task`;

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `Property summary ${RUN}`, `property-summary-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `ps-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agent = await createTestUser(svc, `ps-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);
  other = await createTestUser(svc, `ps-other-${RUN}@test.local`, "agent", ORG, { enrolFactor: false });
  userIds.push(other.id);
  former = await createTestUser(svc, `ps-former-${RUN}@test.local`, "agent", ORG, { enrolFactor: false });
  userIds.push(former.id);
  await o.query("update profiles set is_active = false where id = $1", [former.id]);

  ownerId = (
    await o.query<{ id: string }>(
      "insert into contacts (org_id, first_name, last_name) values ($1, 'Summary', 'Owner') returning id",
      [ORG],
    )
  ).rows[0]!.id;
  developerId = (
    await o.query<{ id: string }>(
      "insert into contacts (org_id, first_name, last_name) values ($1, 'Summary', 'Developments') returning id",
      [ORG],
    )
  ).rows[0]!.id;

  listing = await insertProperty({
    kind: "standalone",
    visibility: "public",
    published_at: new Date().toISOString(),
    title: { en: `Summary flat ${TAG}` },
    asking_price: 265000,
    owner_contact_id: ownerId,
    assigned_agent_id: agent.id,
  });
  await o.query(
    "insert into mandates (org_id, property_id, type, status, expiry_date) values ($1, $2, 'exclusive', 'active', '2099-01-12')",
    [ORG, listing.id],
  );
  // the admin's earliest: assigned to someone else, so the agent cannot see it
  await task(listing.id, TITLE_OTHERS, "1 day", other.id, admin.id);
  // the agent's own, after the viewing
  await task(listing.id, TITLE_AGENTS, "3 days", agent.id, agent.id);
  // done: never the next action, however early it was due
  await task(listing.id, TITLE_DONE, "-5 days", agent.id, agent.id, true);
  viewingId = (
    await o.query<{ id: string }>(
      "insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at) values ($1, $2, $3, $4, now() + interval '2 days') returning id",
      [ORG, listing.id, ownerId, agent.id],
    )
  ).rows[0]!.id;

  reserved = await insertProperty({
    kind: "standalone",
    status: "reserved",
    visibility: "public",
    transaction_type: "rent",
    rent_price_month: 1400,
    assigned_agent_id: former.id,
  });
  await o.query(
    "insert into mandates (org_id, property_id, type, status, start_date, expiry_date) values ($1, $2, 'open', 'expired', '2025-03-03', '2026-03-03')",
    [ORG, reserved.id],
  );
  await task(reserved.id, TITLE_OVERDUE, "-2 days", agent.id, admin.id);

  project = await insertProperty({
    kind: "project",
    owner_contact_id: ownerId,
    developer_contact_id: developerId,
    title: { en: `Summary project ${TAG}` },
  });

  elsewhere = await insertProperty({ kind: "standalone" });
  await task(elsewhere.id, TITLE_ELSEWHERE, "-10 days", agent.id, admin.id);

  eventsBefore = await eventCount();
}, 300_000);

afterAll(async () => {
  if (!o) return;
  await o.query("delete from tasks where org_id = $1", [ORG]);
  await o.query("delete from viewings where org_id = $1", [ORG]);
  await o.query("delete from mandates where org_id = $1", [ORG]);
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
describe("the next action: one task read through RLS, against the next viewing", () => {
  it("the admin: an earlier task assigned to someone else is the next task", async () => {
    const s = await summary(admin, listing.id);
    const next = s.cell("next");
    expect(next.text).toContain(`Next task: ${TITLE_OTHERS} · due `);
    expect(next.text).not.toContain("Your next task");
    expect(next.text).not.toContain(TITLE_DONE);
  });

  it("the agent cannot see that task (tasks_select) — the viewing comes before their own", async () => {
    const s = await summary(agent, listing.id);
    const next = s.cell("next");
    expect(next.text).toMatch(/^Next viewing: \d{1,2} \w{3} \d{4}, \d{2}:\d{2}/);
    // ... and says it was weighed against THEIR tasks only (A08 review): the
    // admin's earlier task for someone else is exactly what it cannot see
    expect(next.text).toMatch(/^Next viewing: [^·]+ · your tasks only/);
    expect(next.html).toContain(`href="/viewings/${viewingId}"`);
    expect(next.text).not.toContain(TITLE_OTHERS);
    expect(s.el.props.nextTask).toMatchObject({ title: TITLE_AGENTS });
  });

  it("a task of the agent's own, overdue: 'Your next task', said overdue; the admin's label is 'Next task'", async () => {
    const mine = (await summary(agent, reserved.id)).cell("next").text;
    expect(mine).toContain(`Your next task: ${TITLE_OVERDUE} · overdue · was due `);
    const admins = (await summary(admin, reserved.id)).cell("next").text;
    expect(admins).toContain(`Next task: ${TITLE_OVERDUE} · overdue`);
  });

  it("nothing scheduled: 'None' — for the agent, 'your tasks only' — and another listing's task never counts", async () => {
    expect((await summary(admin, project.id)).cell("next").text).toMatch(/^None\b/);
    expect((await summary(admin, project.id)).cell("next").text).not.toContain("your tasks only");
    expect((await summary(agent, project.id)).cell("next").text).toMatch(/^None · your tasks only/);
    for (const user of [admin, agent]) {
      for (const p of [listing, reserved, project]) {
        expect((await summary(user, p.id)).cell("next").text).not.toContain(TITLE_ELSEWHERE);
      }
    }
  });

  it("the one Add task on the page is in the Next action cell, linked to this property", async () => {
    const s = await summary(admin, listing.id);
    const dialogs = s.tree.filter((e) => e.type === AddTaskDialog);
    expect(dialogs, "the header no longer carries its own").toHaveLength(0);
    expect(s.cell("next").text).toContain("Add task");
    const inside = [...walk(PropertySummary(s.el.props as never))].filter((e) => e.type === AddTaskDialog);
    expect(inside).toHaveLength(1);
    expect(inside[0]!.props.entity).toEqual({ property_id: listing.id });
  });
});

describe("the other cells", () => {
  it("a public, available listing: price, on the website, owner linked, agent, mandate", async () => {
    const s = await summary(admin, listing.id);
    expect(s.cell("price").text).toBe("€265.000");
    expect(s.html).toContain(">Price</dt>");
    expect(s.cell("availability").text).toBe("Available · on the website");
    expect(s.cell("party").text).toBe("Summary Owner");
    expect(s.cell("party").html).toContain(`href="/contacts/${ownerId}"`);
    expect(s.html).toContain(">Owner</dt>");
    expect(s.cell("agent").text).toBe(`Test agent ps-agent-${RUN}@test.local`);
    expect(s.cell("mandate").text).toBe("Exclusive · expires 12 Jan 2099");
    expect(s.cell("mandate").html).toContain(`href="/properties/${listing.id}?tab=mandate"`);
  });

  it("public but reserved: said to be off the website, with the reason; the inactive agent flagged; the expired mandate", async () => {
    const s = await summary(agent, reserved.id);
    expect(s.cell("price").text).toBe("€1.400/mo");
    expect(s.cell("availability").text).toBe(
      "Reserved · Public, but not on the website The website only shows listings whose status is Available.",
    );
    expect(s.cell("availability").html).toContain('role="note"');
    expect(s.cell("agent").text).toBe(`Test agent ps-former-${RUN}@test.local · inactive`);
    expect(s.cell("party").text).toBe("Not recorded");
    // the admin sees every mandate: the last one expired
    expect((await summary(admin, reserved.id)).cell("mandate").text).toBe("No active mandate · expired 3 Mar 2026");
  });

  it("an agent who is not this property's agent cannot see its mandates (mandates_safe) — never told 'No mandate'", async () => {
    const s = await summary(agent, reserved.id);
    expect(s.el.props.mandates, "RLS hid the expired mandate from this agent").toEqual([]);
    expect(s.cell("mandate").text).toBe("Not visible to you");
    expect(s.tree.some((e) => e.type === MandateBadge), "no false 'No mandate' badge either").toBe(false);
    expect((await summary(agent, project.id)).cell("mandate").text).toBe("Not visible to you");
    // the agent assigned to a property sees its mandate, and the admin sees the badge
    expect((await summary(agent, listing.id)).cell("mandate").text).toBe("Exclusive · expires 12 Jan 2099");
    expect((await pageTree(admin, reserved.id)).find((e) => e.type === MandateBadge)?.props.state).toBe("expired");
  });

  it("a project: its developer, a FROM price not set, no agent, no mandate, not on the website", async () => {
    const s = await summary(admin, project.id);
    expect(s.html).toContain(">Developer</dt>");
    expect(s.cell("party").html).toContain(`href="/contacts/${developerId}"`);
    expect(s.cell("party").text).toBe("Summary Developments");
    expect(s.html).toContain(">From price</dt>");
    expect(s.cell("price").text).toBe("Not set");
    expect(s.cell("agent").text).toBe("Not assigned");
    expect(s.cell("mandate").text).toBe("No mandate");
    expect(s.cell("availability").text).toBe("Available · not on the website (Private)");
  });

  it("Outstanding is the readiness panel's count, linked to the panel — which carries the anchor", async () => {
    const s = await summary(admin, listing.id);
    const panel = s.tree.find((e) => e.type === ListingReadiness)!;
    const q = panel.props.quality as QualityScoreResult;
    const n = q.missing.length + q.warnings.length;
    expect(n, "a listing with no photograph has something outstanding").toBeGreaterThan(0);
    expect(s.cell("outstanding").text).toMatch(new RegExp(`^${n} items? — see Listing readiness`));
    expect(s.cell("outstanding").html).toContain('href="#listing-readiness"');
    // the missing items are the panel's; the strip lists none of them
    for (const item of q.missing) expect(s.cell("outstanding").text).not.toContain(item.label);
    const markup = renderToStaticMarkup(panel);
    expect(markup).toContain('id="listing-readiness"');
    expect(markup).toContain('tabindex="-1"');
  });

  it("an agent who cannot see the mandates: Outstanding leaves 'Active mandate' out and says it is not visible (A08 review)", async () => {
    const quality = (s: Awaited<ReturnType<typeof summary>>) =>
      s.tree.find((e) => e.type === ListingReadiness)!.props.quality as QualityScoreResult;
    // the admin sees the expired mandate: the criterion IS missing, and counted
    const ad = await summary(admin, reserved.id);
    const qa = quality(ad);
    expect(qa.missing.map((m) => m.key)).toContain("mandate");
    const na = qa.missing.length + qa.warnings.length;
    // (this listing also misses website essentials — "incl. website essentials")
    const essentials = qa.essentialsMissing.length > 0 ? " · incl. website essentials" : "";
    expect(ad.cell("outstanding").text).toBe(`${na} ${na === 1 ? "item" : "items"} — see Listing readiness${essentials}`);
    // the agent beside "Mandate: Not visible to you": not counted as missing
    const ag = await summary(agent, reserved.id);
    expect(ag.cell("mandate").text).toBe("Not visible to you");
    const q = quality(ag);
    expect(q.missing.map((m) => m.key)).toContain("mandate");
    const n = q.missing.length - 1 + q.warnings.length;
    expect(n).toBe(na - 1);
    expect(ag.cell("outstanding").text).toBe(
      `${n} ${n === 1 ? "item" : "items"} — see Listing readiness${essentials} · mandate not visible to you`,
    );
  });
});

describe("the header and the tab title", () => {
  it("the title in the h1 beside the reference; the badges prefixed for a screen reader; the inline note gone", async () => {
    const tree = await pageTree(admin, reserved.id);
    // the heading's text as a screen reader gets it: tags dropped WITHOUT a
    // space, so the words must carry their own
    const textOf = (el: Element) => renderToStaticMarkup(el).replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
    expect(textOf(tree.find((e) => e.type === "h1")!)).toBe(reserved.reference);
    const titled = textOf((await pageTree(admin, listing.id)).find((e) => e.type === "h1")!);
    expect(titled).toBe(`${listing.reference} Summary flat ${TAG}`);
    const srOnly = tree.filter((e) => e.type === "span" && e.props.className === "sr-only").map((e) => e.props.children);
    expect(srOnly).toEqual(expect.arrayContaining(["Mandate: ", "Status: ", "Visibility: "]));
    // the header's own "Public, but not on the site" line is replaced by the summary cell
    const headerText = tree
      .filter((e) => e.type === "span" && e.props.role === "note")
      .map((e) => plain(renderToStaticMarkup(e)));
    expect(headerText.join(" ")).not.toContain("not on the site");
  });

  it("generateMetadata: the reference, and nothing else", async () => {
    for (const user of [admin, agent]) {
      const m = await ctx.als.run(user.client, () => generateMetadata({ params: Promise.resolve({ id: listing.id }) }));
      expect(m).toEqual({ title: listing.reference });
    }
  });
});

describe("reading changes nothing", () => {
  it("no event was written, and the chain verifies", async () => {
    expect(await eventCount()).toBe(eventsBefore);
    const { rows } = await o.query("select ok, reason from public.verify_events_chain($1::uuid, null::bigint)", [ORG]);
    expect(rows[0]).toMatchObject({ ok: true });
  });
});
