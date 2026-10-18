import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * A04 against the REAL stack (PostgREST at the hosted version, RLS, the
 * events chain): capture → match → proposal, through the real reads and the
 * real actions.
 *
 *   1. THE INBOX EMBED. The leads read's contact embed, narrowed IN the embed
 *      to active searches and one per contact (a nested filter and a nested
 *      limit): every lead still comes back; a contact with two active
 *      searches answers one, with only an archived one `[]`, with none `[]`;
 *      an unlinked lead has no contact.
 *   2. SAVE BRIEF AS SEARCH. The real `saveSearchFromEnquiry`, as an agent on a
 *      lead linked to an EXISTING contact: one search, the brief's area and
 *      district resolved, and its `requirement_added` line on the contact with
 *      the lead's id, written by the session (0138's events_insert). A second
 *      press is refused and writes nothing.
 *   3. THE PROPOSAL. The real `createShareLink` refuses an archived buyer and
 *      mints nothing; for a live buyer it mints one link bound to them,
 *      holding both picked listings, with its `created` line.
 *   4. "PROPOSED". `proposalsForContact` / `proposalsForProperty` on the
 *      agent's session: newest first, the buyer's links only, an unbound link
 *      never named, the curation narrowed to the listing asked about.
 *   5. VISIBILITY ON THE ROW. The matcher's candidate select carries
 *      `visibility`, so an off-market match says so.
 *
 * The events chain still verifies at the end. A THROWAWAY ORGANISATION,
 * deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();

const state = vi.hoisted(() => ({ queue: [] as unknown[] }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = state.queue.shift();
    if (!c) throw new Error("test harness: no client queued for this action");
    return c;
  },
}));
vi.mock("@/lib/supabase/admin", async () => {
  const h = await import("./helpers");
  return { createAdminClient: () => h.serviceClient() };
});

import { saveSearchFromEnquiry } from "@/lib/actions/leads";
import { createShareLink } from "@/lib/actions/share-links";
import {
  ACTIVE_SEARCH_FILTER,
  LEAD_CONTACT_EMBED,
  SEARCH_EMBED_TABLE,
  savedSearchState,
} from "@/lib/queries/lead-saved-search";
import { findMatchingProperties } from "@/lib/queries/matches";
import { proposalsForContact, proposalsForProperty } from "@/lib/queries/proposals-sent";
import type { MatchRequirement } from "@/lib/services/matching";

let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let agent: TestUser;
const userIds: string[] = [];
let district: string;
let area: string;
const c = { fresh: "", searching: "", retired: "", archived: "" };
const l = { fresh: "", searching: "", retired: "", unlinked: "", seller: "" };
let p1: string;
let p2: string;
let olderLink: string;
let unboundLink: string;

async function one<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T> {
  return (await pg.query(sql, args)).rows[0] as T;
}
const contact = async (name: string, archived = false) =>
  (
    await one<{ id: string }>(
      "insert into contacts (org_id, first_name, contact_types, is_archived) values ($1, $2, '{buyer}', $3) returning id",
      [ORG, `ZZMatch ${name} ${RUN}`, archived],
    )
  ).id;
const lead = async (contactId: string | null, criteria: object) =>
  (
    await one<{ id: string }>(
      `insert into leads (org_id, source, message, contact_id, criteria, assigned_agent_id)
       values ($1, 'website', $2, $3, $4, $5) returning id`,
      [ORG, `Website enquiry ZZMatch ${RUN}`, contactId, JSON.stringify(criteria), agent.id],
    )
  ).id;
const search = async (contactId: string, active: boolean) =>
  one(
    `insert into buyer_requirements (org_id, contact_id, label, transaction_type, is_active, created_by)
     values ($1, $2, $3, 'sale', $4, $5)`,
    [ORG, contactId, `ZZ search ${RUN}`, active, admin.id],
  );
const property = async (ref: string, visibility: string) =>
  (
    await one<{ id: string }>(
      `insert into properties (org_id, reference, kind, property_type, transaction_type, status, visibility,
                               district_id, asking_price, bedrooms, title)
       values ($1, $2, 'standalone', 'villa', 'sale', 'available', $3, $4, 400000, 3, $5) returning id`,
      [ORG, ref, visibility, district, JSON.stringify({ en: `ZZMatch ${ref}` })],
    )
  ).id;
/** a link as an older session or the /share-links page would have left it */
const plantLink = async (contactId: string | null, createdAt: string, propertyIds: string[]) => {
  const id = (
    await one<{ id: string }>(
      `insert into share_links (org_id, kind, token_sha256, contact_id, expires_at, created_by, created_at)
       values ($1, 'proposal', $2, $3, now() + interval '14 days', $4, $5) returning id`,
      [ORG, `zz-${randomUUID()}`, contactId, admin.id, createdAt],
    )
  ).id;
  for (const [i, pid] of propertyIds.entries()) {
    await pg.query("insert into share_link_properties (share_link_id, property_id, sort_order) values ($1, $2, $3)", [id, pid, i]);
  }
  return id;
};

const BRIEF = { looking_to: "buy", budget: "300_500k", buy_area: "", buy_property_type: "villa", bedrooms_min: "3" };

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Match ${RUN}`, `match-${RUN}`);
  admin = await createTestUser(svc, `mw-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agent = await createTestUser(svc, `mw-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);

  district = (await one<{ id: string }>("select id from districts where org_id = $1 and code = 'PAF'", [ORG])).id;
  area = (
    await one<{ id: string }>(
      "insert into areas (org_id, district_id, name) values ($1, $2, $3) returning id",
      [ORG, district, JSON.stringify({ en: `Zzarea ${TAG}` })],
    )
  ).id;
  BRIEF.buy_area = `Zzarea ${TAG}`;

  c.fresh = await contact("fresh");
  c.searching = await contact("searching");
  c.retired = await contact("retired");
  c.archived = await contact("archived", true);
  await search(c.searching, true);
  await search(c.searching, true);
  await search(c.retired, false);

  l.fresh = await lead(c.fresh, BRIEF);
  l.searching = await lead(c.searching, BRIEF);
  l.retired = await lead(c.retired, BRIEF);
  l.unlinked = await lead(null, BRIEF);
  l.seller = await lead(c.fresh, { district: "Paphos", property_type: "villa" });

  p1 = await property(`ZZM${TAG}1`, "private");
  p2 = await property(`ZZM${TAG}2`, "off_market");
  olderLink = await plantLink(c.searching, "2026-01-02T10:00:00Z", [p1]);
  unboundLink = await plantLink(null, "2026-01-03T10:00:00Z", [p1]);
});

afterAll(async () => {
  await pg.query("delete from share_link_properties where share_link_id in (select id from share_links where org_id = $1)", [ORG]);
  for (const t of ["share_links", "buyer_requirements", "notification_jobs", "tasks", "leads", "contacts", "properties", "areas"]) {
    await pg.query(`delete from ${t} where org_id = $1`, [ORG]);
  }
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts", "reference_counters"]) {
    await pg.query(`delete from ${t} where org_id = $1`, [ORG]);
  }
  await pg.query("delete from organizations where id = $1", [ORG]);
  await pg.end();
});

describe("1. the inbox's contact embed: active searches, one per contact, every lead kept", () => {
  it("answers has / none / none / no contact — never drops a lead for having no search", async () => {
    const ids = [l.fresh, l.searching, l.retired, l.unlinked];
    const res = await agent.client
      .from("leads")
      .select(`id, ${LEAD_CONTACT_EMBED}` as const)
      .in("id", ids)
      .eq(...ACTIVE_SEARCH_FILTER)
      .limit(1, { referencedTable: SEARCH_EMBED_TABLE });
    expect(res.error).toBeNull();
    const byId = new Map((res.data ?? []).map((r) => [r.id as string, r]));
    expect(byId.size, "a lead whose contact has no search still comes back").toBe(4);

    const embed = (id: string) =>
      (byId.get(id) as unknown as { contacts: { buyer_requirements?: unknown; is_archived: boolean } | null }).contacts;
    expect(embed(l.searching)!.buyer_requirements, "two active searches answer one").toHaveLength(1);
    expect(embed(l.retired)!.buyer_requirements, "an archived search does not count").toEqual([]);
    expect(embed(l.fresh)!.buyer_requirements).toEqual([]);
    expect(embed(l.unlinked)).toBeNull();
    expect(embed(l.fresh)!.is_archived).toBe(false);

    expect(savedSearchState(embed(l.searching))).toBe("has");
    expect(savedSearchState(embed(l.retired))).toBe("none");
    expect(savedSearchState(embed(l.unlinked))).toBe("unknown");
  });
});

describe("2. Save brief as search, on a lead linked to an existing contact", () => {
  it("writes one search from the brief — area and district resolved — and its line on the contact, naming the lead", async () => {
    state.queue.push(agent.client);
    const r = await saveSearchFromEnquiry(l.fresh);
    expect(r.error).toBeNull();
    expect(r.note ?? null).toBeNull();

    const rows = (
      await pg.query(
        `select id, label, transaction_type::text, property_types::text[] as types, area_ids, district_ids,
                budget_min, budget_max, bedrooms_min, is_active, created_by
           from buyer_requirements where contact_id = $1`,
        [c.fresh],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: "From website enquiry",
      transaction_type: "sale",
      types: ["villa"],
      area_ids: [area],
      district_ids: [district],
      bedrooms_min: 3,
      is_active: true,
      created_by: agent.id,
    });
    expect(Number(rows[0].budget_min)).toBe(300000);
    expect(Number(rows[0].budget_max)).toBe(500000);

    const ev = await one<{ actor_id: string; payload: Record<string, unknown> }>(
      "select actor_id, payload from events where org_id = $1 and entity_type = 'contact' and entity_id = $2 and event_type = 'requirement_added'",
      [ORG, c.fresh],
    );
    expect(ev.actor_id, "written by the session, as itself").toBe(agent.id);
    expect(ev.payload).toEqual({ requirement_id: rows[0].id, label: "From website enquiry", via: "website_enquiry", lead_id: l.fresh });
  });

  it("a second press, a contact that already has a search, a seller's enquiry and an unlinked lead are refused — nothing written", async () => {
    const before = await one<{ n: number }>("select count(*)::int as n from buyer_requirements where org_id = $1", [ORG]);
    const cases: [string, RegExp][] = [
      [l.fresh, /already has a saved search/],
      [l.searching, /already has a saved search/],
      [l.seller, /no buyer's brief/],
      [l.unlinked, /link or create the contact first/i],
    ];
    for (const [leadId, message] of cases) {
      state.queue.push(agent.client);
      expect((await saveSearchFromEnquiry(leadId)).error).toMatch(message);
    }
    const after = await one<{ n: number }>("select count(*)::int as n from buyer_requirements where org_id = $1", [ORG]);
    expect(after.n).toBe(before.n);
  });
});

let minted: string;

describe("3. a proposal bound to the buyer, from the match rows", () => {
  it("refuses an archived buyer and mints nothing", async () => {
    const before = await one<{ n: number }>("select count(*)::int as n from share_links where org_id = $1", [ORG]);
    state.queue.push(agent.client);
    const res = await createShareLink({ property_ids: [p1], contact_id: c.archived });
    expect(res.error).toMatch(/archived/);
    expect(res.path).toBeNull();
    const after = await one<{ n: number }>("select count(*)::int as n from share_links where org_id = $1", [ORG]);
    expect(after.n).toBe(before.n);
  });

  it("mints ONE link bound to the buyer, holding both listings, with its created line", async () => {
    state.queue.push(agent.client);
    const res = await createShareLink({ property_ids: [p1, p2], contact_id: c.searching, locale: "ru" });
    expect(res.error).toBeNull();
    expect(res.notice).toBeNull();
    expect(res.path).toMatch(/^\/p\/[A-Za-z0-9_-]{43}$/);

    const link = await one<{ id: string; contact_id: string; locale: string; created_by: string }>(
      "select id, contact_id, locale, created_by from share_links where org_id = $1 and id not in ($2, $3)",
      [ORG, olderLink, unboundLink],
    );
    minted = link.id;
    expect(link).toMatchObject({ contact_id: c.searching, locale: "ru", created_by: agent.id });
    const held = (await pg.query("select property_id from share_link_properties where share_link_id = $1 order by sort_order", [minted])).rows;
    expect(held.map((r) => r.property_id)).toEqual([p1, p2]);
    const ev = await one<{ payload: Record<string, unknown> }>(
      "select payload from events where org_id = $1 and entity_type = 'share_link' and entity_id = $2 and event_type = 'created'",
      [ORG, minted],
    );
    expect(ev.payload).toMatchObject({ property_count: 2, contact_id: c.searching });
  });
});

describe("4. what was already proposed, read on the agent's session", () => {
  it("the buyer's links, newest first, each with every listing it held", async () => {
    const h = await proposalsForContact(agent.client as never, c.searching);
    expect(h.ok).toBe(true);
    if (!h.ok) return;
    expect(h.capped).toBe(false);
    expect(h.proposals.map((p) => p.id)).toEqual([minted, olderLink]);
    expect([...h.proposals[0]!.propertyIds].sort()).toEqual([p1, p2].sort());
    expect(h.proposals[1]!.propertyIds).toEqual([p1]);
  });

  it("a listing's buyer-bound links, newest first — the unbound one never named — narrowed to that listing", async () => {
    const one1 = await proposalsForProperty(agent.client as never, p1);
    expect(one1.ok).toBe(true);
    if (!one1.ok) return;
    expect(one1.proposals.map((p) => p.id)).toEqual([minted, olderLink]);
    expect(one1.proposals.every((p) => p.contactId === c.searching)).toBe(true);
    expect(one1.proposals[0]!.propertyIds, "the inner embed narrows the curation to the listing").toEqual([p1]);

    const two = await proposalsForProperty(agent.client as never, p2);
    expect(two.ok && two.proposals.map((p) => p.id)).toEqual([minted]);

    const fresh = await proposalsForContact(agent.client as never, c.fresh);
    expect(fresh).toEqual({ ok: true, proposals: [], capped: false });
  });
});

describe("5. an off-market match says so", () => {
  it("the candidate select carries visibility through PostgREST", async () => {
    const req: MatchRequirement = {
      transaction_type: "sale",
      property_types: ["villa"],
      district_ids: [district],
      area_ids: [],
      budget_min: null,
      budget_max: null,
      bedrooms_min: null,
      bedrooms_max: null,
      bathrooms_min: null,
      covered_area_min_sqm: null,
      plot_area_min_sqm: null,
      title_deed_required: false,
      vat_preference: null,
      max_sea_distance_m: null,
      delivery_by: null,
      features_required: [],
    };
    const result = await findMatchingProperties(agent.client as never, req);
    const byId = new Map(result.rows.map((r) => [r.property.id, r.property.visibility]));
    expect(byId.get(p1)).toBe("private");
    expect(byId.get(p2)).toBe("off_market");
  });

  it("the events chain still verifies", async () => {
    const v = await one<{ ok: boolean }>("select ok from public.verify_events_chain($1, null)", [ORG]);
    expect(v.ok).toBe(true);
  });
});
