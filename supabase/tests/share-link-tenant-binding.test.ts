import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { FORBIDDEN_0041 } from "./revert-0137";
import {
  ACL_0041,
  BODY_0137_MD5,
  BODY_0146_MD5,
  EDITS_0146,
  POLICIES_0146,
  REVERT_0146_SQL,
  SHARE_LINKS_UPDATE_USING,
  SIG_0146 as SIG,
  fn0137,
  fn0146,
  readMigration0146,
} from "./revert-0146";

/**
 * A share link names, pins and shows only its own organisation's rows
 * (T-share-link-tenant, migration 0146 — an external audit's finding, verified
 * independently before this file was written).
 *
 * THE GAP (reproduced at 0145 by this file — DECISIONS T-share-link-tenant has
 * the RED count): share_link_properties_insert checked only that the LINK was
 * the caller's organisation's, never the property it names;
 * share_links_insert / _update never checked the pinned price_list_id; and
 * resolve_share_link() — the anon-callable SECURITY DEFINER behind /p/<token>
 * — read the target, the descendant walk, the pinned list and its lines, the
 * proposal's properties and the linked-row count with no organisation
 * predicate. Organisation B's staff could put A's private listing, A's whole
 * unit tree with prices, or A's unpublished list prices on B's public page;
 * and B's units hung under A's project (properties.parent_id is
 * single-column) appeared on A's own availability page.
 *
 * WHAT IT PINS:
 *   1. an aal2 org-B admin's direct PostgREST insert into share_link_properties
 *      naming an org-A property — proposal or availability target — is
 *      refused 42501, and so is a missing id (no oracle); B's own is accepted
 *      — and so it is for B's agent and listing manager (the new check reads
 *      properties through THEIR RLS; a listing not assigned to them included);
 *   2. a share_links insert or update pinning A's price list is refused
 *      42501 (a missing id too); B's own list and none are accepted, and a
 *      revoke still works (an agent's and a listing manager's own included);
 *      an update naming A's staff member as the link's creator — whom the
 *      public page shows as its agent — is refused 42501 (a missing profile
 *      too), a B colleague is accepted;
 *   3. rows written by a trusted path (the service role — as a row from
 *      before 0146 would be) are not shown: a proposal omits A's property and
 *      does not count it; a B link aimed at A's project resolves to nothing;
 *      B's unit and phase hung under A's project do not appear on A's page;
 *      a B link pinning A's list shows none of A's numbers; a B link naming
 *      A's staff member as its creator shows no agent;
 *   4. a link whose rows are all its own organisation's resolves to the SAME
 *      payload as on 0137's body — proposal, live and pinned availability —
 *      against a literal captured on the base schema;
 *   5. the function's shape: 0137's body but the nine edits, 0041's ACL and
 *      exposure guard; the three policies' exact texts, each the only
 *      permissive policy for its command (permissive policies OR together);
 *   6. 0146 itself, inside rolled-back transactions: it replays over its
 *      rollback text, its preflight refuses every drift it names (a sibling
 *      permissive policy included), each postflight guard refuses the weakened
 *      body it names — with ITS message, not the md5 pin's — the rollback
 *      brings the leak back, and the restore pack's 0146 row reads true now
 *      and false without it;
 *   7. a killed run of this file leaves nothing behind once the next run's
 *      beforeAll has swept: organisation, users, profiles, events, rows.
 *
 * Sections 1–3 write through PostgREST and the service role (committed: a
 * session and anon cannot see an uncommitted row) — in two THROWAWAY
 * organisations, removed at the end as postgres; a killed run's organisations
 * are removed whole in beforeAll (section 7). Sections 4–6 run as postgres in
 * transactions that are always rolled back. Requires the local Supabase
 * stack. Run: npm run test:rls
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-6).toUpperCase();
const NAME_A = "share tenant A";
const NAME_B = "share tenant B";

let svc: SupabaseClient;
let o: Client;
let adminA: TestUser;
let adminB: TestUser;
let agentB: TestUser;
let lmB: TestUser;
/** A's admin's phone: a marker B's page must not carry. */
const A_PHONE = "+35799424242";

/** Committed fixtures (sections 1–3). Each reference and price is a marker a payload must or must not carry. */
const f = {
  listingA: "", projA: "", phaseA: "", unitA1: "", unitA2: "", plA: "", projPlantA: "", unitPlantA: "",
  listingB: "", projB: "", unitB1: "", plB: "",
};
const ref = (s: string) => `ST${TAG}-${s}`;
const A_LISTING_TITLE = `A private listing ${TAG}`;
const A_LIST_DATE = "2031-07-15";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const mint = () => randomBytes(32).toString("base64url");
const inAWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

async function svcInsert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await svc.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data as { id: string }).id;
}
const property = (org: string, r: string, over: Record<string, unknown> = {}) =>
  svcInsert("properties", { org_id: org, reference: ref(r), property_type: "apartment", ...over });

/** A link written by the service role (a trusted path — as a row from before 0146 would be), with its rows in order. */
async function svcLink(org: string, by: string, extra: Record<string, unknown>, propertyIds: string[]) {
  const token = mint();
  const id = await svcInsert("share_links", {
    org_id: org, token_sha256: sha(token), expires_at: inAWeek(), created_by: by, ...extra,
  });
  for (const [i, property_id] of propertyIds.entries()) {
    const { error } = await svc.from("share_link_properties").insert({ share_link_id: id, property_id, sort_order: i });
    if (error) throw new Error(`share_link_properties: ${error.message}`);
  }
  return { id, token };
}
/** A link minted by `who` through PostgREST, as the app's actions do. */
async function sessionLink(who: TestUser, org: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await who.client
    .from("share_links")
    .insert({ org_id: org, token_sha256: sha(mint()), expires_at: inAWeek(), created_by: who.id, ...extra })
    .select("id")
    .single();
  return { id: (data as { id: string } | null)?.id ?? "", error };
}
async function resolveAsAnon(token: string) {
  const { data, error } = await anonClient().rpc("resolve_share_link", { p_token_sha256: sha(token) });
  expect(error).toBeNull();
  return data as Record<string, unknown> | null;
}

/** The rows a stale run of this file can leave naming the other organisation's rows, cleared first. */
async function clearOrgs(orgIds: string[]) {
  if (!orgIds.length) return;
  await o.query("delete from share_links where org_id = any($1::uuid[])", [orgIds]); // cascades its rows
  await o.query(
    "delete from share_link_properties where property_id in (select id from properties where org_id = any($1::uuid[]))",
    [orgIds],
  );
  // children before parents (parent_id is ON DELETE RESTRICT; B rows may hang under A's)
  for (let i = 0; i < 10; i++) {
    const { rowCount } = await o.query(
      `delete from properties p where p.org_id = any($1::uuid[])
          and not exists (select 1 from properties c where c.parent_id = p.id)`,
      [orgIds],
    );
    if (!rowCount) break;
  }
}

/** Throwaway organisations removed whole, as postgres: their rows, users, profiles, events and reference data. */
async function removeOrgs(orgIds: string[]) {
  if (!orgIds.length) return;
  await clearOrgs(orgIds);
  const users = await o.query<{ id: string }>("select id from profiles where org_id = any($1::uuid[])", [orgIds]);
  for (const { id } of users.rows) {
    const { error } = await svc.auth.admin.deleteUser(id); // its profile goes with it (on delete cascade)
    if (error) console.warn(`removeOrgs: auth user ${id} not deleted: ${error.message}`);
  }
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "areas", "districts"]) {
    await o.query(`delete from ${t} where org_id = any($1::uuid[])`, [orgIds]);
  }
  await o.query("delete from organizations where id = any($1::uuid[])", [orgIds]);
}

/** A killed earlier run's throwaway organisations (this file's names), never `except` — removed whole. */
async function sweepStaleRuns(except: string[]) {
  const stale = await o.query<{ id: string }>(
    "select id from organizations where name like any($1::text[]) and not (id = any($2::uuid[]))",
    [[`${NAME_A} %`, `${NAME_B} %`], except],
  );
  await removeOrgs(stale.rows.map((r) => r.id));
}

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await sweepStaleRuns([ORG_A, ORG_B]);

  await ensureTestOrg(svc, ORG_A, `${NAME_A} ${RUN}`, `share-tenant-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `${NAME_B} ${RUN}`, `share-tenant-b-${RUN}`);
  adminA = await createTestUser(svc, `st-a-${RUN}@test.local`, "admin", ORG_A);
  adminB = await createTestUser(svc, `st-b-${RUN}@test.local`, "admin", ORG_B);
  agentB = await createTestUser(svc, `st-b-ag-${RUN}@test.local`, "agent", ORG_B);
  lmB = await createTestUser(svc, `st-b-lm-${RUN}@test.local`, "listing_manager", ORG_B);
  const phone = await svc.from("profiles").update({ phone_e164: A_PHONE }).eq("id", adminA.id);
  if (phone.error) throw new Error(`profiles: ${phone.error.message}`);

  // organisation A: a private listing, a phased project, a pinned price list, and a project B will plant under
  f.listingA = await property(ORG_A, "LA", { visibility: "private", title: { en: A_LISTING_TITLE }, asking_price: 420001 });
  f.projA = await property(ORG_A, "PA", { kind: "project", visibility: "private", title: { en: "A project" } });
  f.phaseA = await property(ORG_A, "PA-P1", { kind: "phase", parent_id: f.projA, status: "available" });
  f.unitA1 = await property(ORG_A, "PA-U1", { kind: "unit", parent_id: f.phaseA, status: "available", asking_price: 410001 });
  f.unitA2 = await property(ORG_A, "PA-U2", { kind: "unit", parent_id: f.projA, status: "available", asking_price: 410002 });
  f.plA = await svcInsert("price_lists", { org_id: ORG_A, project_id: f.projA, version: 7, effective_date: A_LIST_DATE });
  f.projPlantA = await property(ORG_A, "PP", { kind: "project", title: { en: "A planted-under project" } });
  f.unitPlantA = await property(ORG_A, "PP-U1", { kind: "unit", parent_id: f.projPlantA, status: "available", asking_price: 440001 });

  // organisation B: its own listing, project, unit and list
  f.listingB = await property(ORG_B, "LB", { visibility: "public", title: { en: "B listing" }, asking_price: 520001 });
  f.projB = await property(ORG_B, "PB", { kind: "project", title: { en: "B project" } });
  f.unitB1 = await property(ORG_B, "PB-U1", { kind: "unit", parent_id: f.projB, status: "available", asking_price: 510001 });
  f.plB = await svcInsert("price_lists", { org_id: ORG_B, project_id: f.projB, version: 1, effective_date: "2030-01-01" });

  // A's list quotes A's unit, and (a line of A's own list naming B's unit — price_list_items_insert checks only the
  // list's organisation) B's unit: the number a B link pinning A's list would put on B's page
  const items = await svc.from("price_list_items").insert([
    { price_list_id: f.plA, unit_id: f.unitA1, list_price: 430001 },
    { price_list_id: f.plA, unit_id: f.unitB1, list_price: 430002 },
    { price_list_id: f.plB, unit_id: f.unitB1, list_price: 520777 },
  ]);
  if (items.error) throw new Error(`price_list_items: ${items.error.message}`);
});

afterAll(async () => {
  await removeOrgs([ORG_A, ORG_B]);
  await o.end();
});

// ---------------------------------------------------------------------------
describe("1. a session's share link names only its own organisation's properties", () => {
  it("B's admin cannot add A's private listing to B's own proposal link (42501); B's own listing is accepted", async () => {
    const link = await sessionLink(adminB, ORG_B);
    expect(link.error).toBeNull();
    const foreign = await adminB.client.from("share_link_properties").insert({ share_link_id: link.id, property_id: f.listingA, sort_order: 0 });
    console.log(`[evidence] B's link + A's listing: ${foreign.error?.code ?? "accepted"}`);
    expect(foreign.error?.code, "A's property on B's link").toBe("42501");
    const own = await adminB.client.from("share_link_properties").insert({ share_link_id: link.id, property_id: f.listingB, sort_order: 1 });
    expect(own.error, "B's own property").toBeNull();
  });

  it("B's admin cannot aim an availability link at A's project (42501); at B's own project it is accepted", async () => {
    const link = await sessionLink(adminB, ORG_B, { kind: "availability" });
    expect(link.error).toBeNull();
    const foreign = await adminB.client.from("share_link_properties").insert({ share_link_id: link.id, property_id: f.projA, sort_order: 0 });
    console.log(`[evidence] B's availability link aimed at A's project: ${foreign.error?.code ?? "accepted"}`);
    expect(foreign.error?.code, "A's project as B's target").toBe("42501");
    const own = await adminB.client.from("share_link_properties").insert({ share_link_id: link.id, property_id: f.projB, sort_order: 0 });
    expect(own.error, "B's own project").toBeNull();
  });

  it("a property id that does not exist reads the same 42501 as A's (no existence oracle)", async () => {
    const link = await sessionLink(adminB, ORG_B);
    expect(link.error).toBeNull();
    const missing = await adminB.client.from("share_link_properties").insert({ share_link_id: link.id, property_id: randomUUID(), sort_order: 0 });
    console.log(`[evidence] B's link + a missing property: ${missing.error?.code ?? "accepted"}`);
    expect(missing.error?.code).toBe("42501");
  });

  it("A's admin still cannot add a row to B's link (0023's clause, kept)", async () => {
    const link = await sessionLink(adminB, ORG_B);
    expect(link.error).toBeNull();
    const r = await adminA.client.from("share_link_properties").insert({ share_link_id: link.id, property_id: f.listingA, sort_order: 0 });
    expect(r.error?.code).toBe("42501");
  });

  it("B's agent and listing manager — not admins, the listing not assigned to them — add B's own listing and target B's own project; A's are refused", async () => {
    // the new check reads properties through the CALLER's RLS: a role-scoped properties_select would refuse these
    for (const who of [agentB, lmB]) {
      const link = await sessionLink(who, ORG_B);
      expect(link.error, `${who.email}: proposal link`).toBeNull();
      const own = await who.client.from("share_link_properties").insert({ share_link_id: link.id, property_id: f.listingB, sort_order: 0 });
      expect(own.error, `${who.email}: B's own listing`).toBeNull();
      const foreign = await who.client.from("share_link_properties").insert({ share_link_id: link.id, property_id: f.listingA, sort_order: 1 });
      expect(foreign.error?.code, `${who.email}: A's listing`).toBe("42501");
      const avail = await sessionLink(who, ORG_B, { kind: "availability" });
      expect(avail.error, `${who.email}: availability link`).toBeNull();
      const target = await who.client.from("share_link_properties").insert({ share_link_id: avail.id, property_id: f.projB, sort_order: 0 });
      expect(target.error, `${who.email}: B's own project`).toBeNull();
    }
  });
});

describe("2. a session's share link pins only its own organisation's price list", () => {
  it("an insert pinning A's list is refused 42501, and so is a missing list; B's own list and none are accepted", async () => {
    const foreign = await sessionLink(adminB, ORG_B, { kind: "availability", price_list_id: f.plA });
    const missing = await sessionLink(adminB, ORG_B, { kind: "availability", price_list_id: randomUUID() });
    console.log(`[evidence] B's insert pinning A's list: ${foreign.error?.code ?? "accepted"}; a missing list: ${missing.error?.code ?? "accepted"}`);
    expect(foreign.error?.code, "A's list").toBe("42501");
    expect(missing.error?.code, "a missing list — the same answer").toBe("42501");
    expect((await sessionLink(adminB, ORG_B, { kind: "availability", price_list_id: f.plB })).error, "B's own list").toBeNull();
    expect((await sessionLink(adminB, ORG_B, { kind: "availability", price_list_id: null })).error, "no list").toBeNull();
  });

  it("an update re-pinning B's link to A's list is refused 42501 and changes nothing; to none and back to B's own it is accepted", async () => {
    const link = await sessionLink(adminB, ORG_B, { kind: "availability", price_list_id: f.plB });
    expect(link.error).toBeNull();
    const foreign = await adminB.client.from("share_links").update({ price_list_id: f.plA }).eq("id", link.id).select("id");
    console.log(`[evidence] B's update re-pinning to A's list: ${foreign.error?.code ?? `accepted (${foreign.data?.length} row)`}`);
    expect(foreign.error?.code).toBe("42501");
    const now = await o.query("select price_list_id from share_links where id = $1", [link.id]);
    expect(now.rows[0].price_list_id).toBe(f.plB);
    const none = await adminB.client.from("share_links").update({ price_list_id: null }).eq("id", link.id).select("id");
    expect(none.error).toBeNull();
    expect(none.data).toHaveLength(1);
    const back = await adminB.client.from("share_links").update({ price_list_id: f.plB }).eq("id", link.id).select("id");
    expect(back.error).toBeNull();
    expect(back.data).toHaveLength(1);
  });

  it("a revoke still works — on a link pinning its own organisation's list and on one pinning none", async () => {
    for (const price_list_id of [f.plB, null]) {
      const link = await sessionLink(adminB, ORG_B, { kind: "availability", price_list_id });
      expect(link.error).toBeNull();
      const r = await adminB.client
        .from("share_links")
        .update({ revoked_at: new Date().toISOString(), revoked_by: adminB.id })
        .eq("id", link.id)
        .is("revoked_at", null)
        .select("id");
      expect(r.error, `revoke (${price_list_id ? "pinned" : "live"})`).toBeNull();
      expect(r.data).toHaveLength(1);
    }
  });

  it("B's agent and listing manager pin B's own list, are refused A's, and revoke their own link", async () => {
    for (const who of [agentB, lmB]) {
      const link = await sessionLink(who, ORG_B, { kind: "availability", price_list_id: f.plB });
      expect(link.error, `${who.email}: B's own list`).toBeNull();
      const foreign = await sessionLink(who, ORG_B, { kind: "availability", price_list_id: f.plA });
      expect(foreign.error?.code, `${who.email}: A's list`).toBe("42501");
      const r = await who.client
        .from("share_links")
        .update({ revoked_at: new Date().toISOString(), revoked_by: who.id })
        .eq("id", link.id)
        .is("revoked_at", null)
        .select("id");
      expect(r.error, `${who.email}: revoke`).toBeNull();
      expect(r.data).toHaveLength(1);
    }
  });

  it("an update naming A's staff member as the link's creator (the page's agent) is refused 42501, and so is a missing profile; a B colleague is accepted", async () => {
    const link = await sessionLink(adminB, ORG_B);
    expect(link.error).toBeNull();
    const foreign = await adminB.client.from("share_links").update({ created_by: adminA.id }).eq("id", link.id).select("id");
    const missing = await adminB.client.from("share_links").update({ created_by: randomUUID() }).eq("id", link.id).select("id");
    console.log(`[evidence] B's update naming A's admin as creator: ${foreign.error?.code ?? `accepted (${foreign.data?.length} row)`}; a missing profile: ${missing.error?.code ?? "accepted"}`);
    expect(foreign.error?.code, "A's profile").toBe("42501");
    expect(missing.error?.code, "a missing profile — the same answer").toBe("42501");
    const now = await o.query("select created_by from share_links where id = $1", [link.id]);
    expect(now.rows[0].created_by).toBe(adminB.id);
    const colleague = await adminB.client.from("share_links").update({ created_by: agentB.id }).eq("id", link.id).select("id");
    expect(colleague.error, "a B colleague").toBeNull();
    expect(colleague.data).toHaveLength(1);
  });
});

describe("3. the public page shows only the link's own organisation's rows, whoever wrote them", () => {
  it("a B proposal holding A's listing omits it, and does not count it", async () => {
    const l = await svcLink(ORG_B, adminB.id, {}, [f.listingB, f.listingA]);
    const p = await resolveAsAnon(l.token);
    const refs = (p!.properties as { reference: string }[]).map((x) => x.reference);
    console.log(`[evidence] B proposal [B, A]: shows ${JSON.stringify(refs)}, property_count ${String(p!.property_count)}`);
    expect(refs).toEqual([ref("LB")]);
    expect(p!.property_count, "another organisation's row is not counted").toBe(1);
    const text = JSON.stringify(p);
    expect(text).not.toContain(A_LISTING_TITLE);
    expect(text).not.toContain("420001");
  });

  it("a B availability link aimed at A's project — pinning A's list too — resolves to nothing", async () => {
    for (const extra of [{ kind: "availability" }, { kind: "availability", price_list_id: f.plA }]) {
      const l = await svcLink(ORG_B, adminB.id, extra, [f.projA]);
      const p = await resolveAsAnon(l.token);
      console.log(`[evidence] B availability → A's project${"price_list_id" in extra ? " pinned to A's list" : ""}: ${p === null ? "null" : `units ${JSON.stringify(p.units)}`}`);
      expect(p, "another organisation's project is not a target").toBeNull();
    }
  });

  it("B's unit and B's phase (with its unit) hung under A's project do not appear on A's own availability page", async () => {
    await property(ORG_B, "PLANT-U", { kind: "unit", parent_id: f.projPlantA, status: "available", asking_price: 590001 });
    const phase = await property(ORG_B, "PLANT-P", { kind: "phase", parent_id: f.projPlantA, status: "available" });
    await property(ORG_B, "PLANT-PU", { kind: "unit", parent_id: phase, status: "available", asking_price: 590002 });
    const l = await svcLink(ORG_A, adminA.id, { kind: "availability" }, [f.projPlantA]);
    const p = await resolveAsAnon(l.token);
    const refs = (p!.units as { reference: string }[]).map((u) => u.reference);
    console.log(`[evidence] A's availability page with B rows planted under it: units ${JSON.stringify(refs)}, phases ${JSON.stringify(p!.phases)}`);
    expect(refs).toEqual([ref("PP-U1")]);
    expect(p!.phases).toEqual([]);
    expect(p!.unit_count).toBe(1);
    const text = JSON.stringify(p);
    for (const marker of ["590001", "590002", ref("PLANT-P")]) expect(text).not.toContain(marker);
  });

  it("a B availability link on B's own project pinning A's list shows none of A's numbers — and no live price either", async () => {
    const l = await svcLink(ORG_B, adminB.id, { kind: "availability", price_list_id: f.plA }, [f.projB]);
    const p = await resolveAsAnon(l.token);
    console.log(`[evidence] B's own project pinned to A's list: price_list ${JSON.stringify(p!.price_list)}, units ${JSON.stringify((p!.units as { reference: string; price: unknown }[]).map((u) => [u.reference, u.price]))}`);
    expect(p!.price_list, "A's version and date are not shown").toBeNull();
    const units = p!.units as { reference: string; price: unknown }[];
    expect(units.map((u) => [u.reference, u.price])).toEqual([[ref("PB-U1"), null]]);
    expect(p!.unpriced_count).toBe(1);
    const text = JSON.stringify(p);
    for (const marker of ["430002", A_LIST_DATE, "510001"]) expect(text).not.toContain(marker);
  });

  it("a B link naming A's staff member as its creator shows no agent — not A's name, email or phone (proposal and availability)", async () => {
    for (const [extra, ids] of [[{}, [f.listingB]], [{ kind: "availability" }, [f.projB]]] as const) {
      const l = await svcLink(ORG_B, adminA.id, extra, [...ids]);
      const p = await resolveAsAnon(l.token);
      console.log(`[evidence] B ${"kind" in extra ? "availability" : "proposal"} link created_by A's admin: agent ${JSON.stringify(p!.agent)}`);
      expect(p!.agent, "another organisation's staff member is not shown").toBeNull();
      const text = JSON.stringify(p);
      for (const marker of [adminA.email, A_PHONE]) expect(text).not.toContain(marker);
    }
  });

  it("controls: A's own phased project, live and pinned to A's own list, still shows A's units, A's quoted price and A's agent", async () => {
    const live = await resolveAsAnon((await svcLink(ORG_A, adminA.id, { kind: "availability" }, [f.projA])).token);
    expect((live!.units as { reference: string }[]).map((u) => u.reference).sort()).toEqual([ref("PA-U1"), ref("PA-U2")].sort());
    expect(live!.agent).toEqual({ name: `Test admin ${adminA.email}`, email: adminA.email, phone: A_PHONE });
    const pinned = await resolveAsAnon((await svcLink(ORG_A, adminA.id, { kind: "availability", price_list_id: f.plA }, [f.projA])).token);
    expect(pinned!.price_list).toEqual({ version: 7, effective_date: A_LIST_DATE });
    const prices = Object.fromEntries((pinned!.units as { reference: string; price: unknown }[]).map((u) => [u.reference, u.price]));
    expect(prices).toEqual({ [ref("PA-U1")]: 430001, [ref("PA-U2")]: null });
    const prop = await resolveAsAnon((await svcLink(ORG_A, adminA.id, {}, [f.listingA])).token);
    expect((prop!.properties as { reference: string }[]).map((x) => x.reference)).toEqual([ref("LA")]);
    expect(prop!.agent).toEqual({ name: `Test admin ${adminA.email}`, email: adminA.email, phone: A_PHONE });
  });
});

// ---------------------------------------------------------------------------
// Sections 4–6: as postgres, in transactions that are always rolled back.
async function rolledBack(body: (notices: string[]) => Promise<void>) {
  const notices: string[] = [];
  const onNotice = (m: { message?: string }) => notices.push(m.message ?? "");
  o.on("notice", onNotice);
  await o.query("begin");
  await o.query("set local lock_timeout = '5s'");
  try {
    await body(notices);
  } finally {
    await o.query("rollback");
    o.off("notice", onNotice);
  }
}
async function bodyMd5() {
  const { rows } = await o.query<{ md5: string }>(`select md5(replace(prosrc, E'\\r', '')) as md5 from pg_proc where oid = '${SIG}'::regprocedure`);
  return rows[0]!.md5;
}
async function prosrc() {
  const { rows } = await o.query<{ src: string }>(`select prosrc as src from pg_proc where oid = '${SIG}'::regprocedure`);
  return rows[0]!.src;
}
/** The three policies as pg_get_expr renders them under 0146's fixed search_path. */
async function policyTexts() {
  await o.query(`set local search_path = "$user", public, extensions`);
  const { rows } = await o.query<{ name: string; q: string | null; c: string | null; cmd: string; permissive: boolean; roles: string }>(
    `select p.polname as name, pg_get_expr(p.polqual, p.polrelid) as q, pg_get_expr(p.polwithcheck, p.polrelid) as c,
            p.polcmd::text as cmd, p.polpermissive as permissive, p.polroles::text as roles
       from pg_policy p
      where p.polrelid in ('public.share_links'::regclass, 'public.share_link_properties'::regclass)
        and p.polname in ('share_link_properties_insert', 'share_links_insert', 'share_links_update')
      order by 1`,
  );
  return Object.fromEntries(rows.map((r) => [r.name, r]));
}
async function resolvePg(token: string) {
  const { rows } = await o.query<{ p: Record<string, unknown> | null }>("select resolve_share_link($1) as p", [sha(token)]);
  return rows[0]!.p;
}

/**
 * Inside a transaction: a fully deterministic same-organisation fixture in ORG_A — fixed references, dates, prices,
 * expiry, agent and organisation names, a district and an area, photos (one cover, one non-photo row), an archived
 * listing (dropped but counted), a phased project with a direct unit, a sold, an archived, a draft and an unpriced
 * unit, and a pinned list that omits one unit. Returns the three links' tokens.
 */
async function deterministicFixture() {
  await o.query("set local timezone = 'UTC'");
  await o.query("update organizations set name = 'Deterministic Estates' where id = $1", [ORG_A]);
  await o.query("update profiles set full_name = 'Dee Agent', email = 'dee@example.test', phone_e164 = '+35799000000' where id = $1", [adminA.id]);
  const district = (await o.query<{ id: string }>("select id from districts where org_id = $1 and code = 'PAF'", [ORG_A])).rows[0]!.id;
  const area = (await o.query<{ id: string }>(
    `insert into areas (org_id, district_id, name) values ($1, $2, '{"en": "Kato Paphos", "el": "Κάτω Πάφος"}'::jsonb) returning id`,
    [ORG_A, district],
  )).rows[0]!.id;
  const prop = async (r: string, cols: Record<string, unknown>) => {
    const keys = ["org_id", "reference", ...Object.keys(cols)];
    const vals = [ORG_A, `DET-${r}`, ...Object.values(cols)];
    const { rows } = await o.query<{ id: string }>(
      `insert into properties (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      vals,
    );
    return rows[0]!.id;
  };
  const p1 = await prop("V1", {
    property_type: "villa", visibility: "public", status: "available", transaction_type: "sale",
    title: { en: "Villa One", el: "Βίλα Ένα" }, short_description: { en: "Sea view" }, public_description: { en: "Three bedrooms by the sea." },
    asking_price: 500000, covered_area_sqm: 180, plot_area_sqm: 600, bedrooms: 3, bathrooms: 2, parking_spaces: 2,
    year_built: 2015, energy_class: "A", features: ["pool", "sea_view"], district_id: district, area_id: area,
  });
  const p2 = await prop("A2", {
    property_type: "apartment", visibility: "private", status: "available", transaction_type: "rent",
    title: { en: "Flat Two" }, rent_price_month: 1500, bedrooms: 2, district_id: district,
  });
  const p3 = await prop("X3", { property_type: "house", visibility: "archived", title: { en: "Retired" }, asking_price: 1 });
  for (const [kind, card, cover, sort] of [["photo", "properties/x/card-b.webp", false, 1], ["photo", "properties/x/card-a.webp", true, 2], ["floor_plan", "properties/x/plan.webp", false, 0]] as const) {
    await o.query(
      `insert into property_media (org_id, property_id, kind, path_card, path_full, is_cover, sort_order, alt)
       values ($1, $2, $3, $4, $5, $6, $7, '{"en": "A view"}'::jsonb)`,
      [ORG_A, p1, kind, card, card.replace("card", "full"), cover, sort],
    );
  }
  const proj = await prop("PROJ", {
    kind: "project", property_type: "apartment", visibility: "private", title: { en: "Det Project", ru: "Проект" },
    delivery_date: "2028-03-31", construction_status: "under construction", district_id: district, area_id: area,
  });
  const phase = await prop("PROJ-P1", { kind: "phase", parent_id: proj, property_type: "apartment", title: { en: "Phase 1" }, delivery_date: "2029-09-30", status: "available" });
  const unit = (r: string, parent: string, over: Record<string, unknown>) =>
    prop(r, { kind: "unit", parent_id: parent, property_type: "apartment", status: "available", block: "A", bedrooms: 2, covered_area_sqm: 85, asking_price: 255000, ...over });
  const u1 = await unit("U001", proj, { unit_number: "001", asking_price: 300000 });
  await unit("P1-U101", phase, { unit_number: "101", floor_number: 1, veranda_sqm: 12 });
  const u2 = await unit("P1-U102", phase, { unit_number: "102", status: "sold" });
  await unit("P1-U103", phase, { unit_number: "103", visibility: "archived" });
  await unit("P1-U104", phase, { unit_number: "104", status: "draft" });
  await unit("P1-U105", phase, { unit_number: "105", asking_price: null });
  const pl = (await o.query<{ id: string }>(
    "insert into price_lists (org_id, project_id, version, effective_date) values ($1, $2, 1, '2026-08-01') returning id",
    [ORG_A, proj],
  )).rows[0]!.id;
  await o.query("insert into price_list_items (price_list_id, unit_id, list_price) values ($1, $2, 290000), ($1, $3, 240000)", [pl, u1, u2]);

  const link = async (cols: Record<string, unknown>, propertyIds: string[]) => {
    const token = `det-${Object.keys(cols).join("-")}-${propertyIds.length}-${String(cols.locale)}`;
    const { rows } = await o.query<{ id: string }>(
      `insert into share_links (org_id, token_sha256, expires_at, created_by, title, message, locale, kind, price_list_id)
       values ($1, $2, '2099-12-31T00:00:00Z', $3, $4, $5, $6, $7, $8) returning id`,
      [ORG_A, sha(token), adminA.id, cols.title, cols.message, cols.locale, cols.kind, cols.price_list_id ?? null],
    );
    for (const [i, id] of propertyIds.entries()) {
      await o.query("insert into share_link_properties (share_link_id, property_id, sort_order) values ($1, $2, $3)", [rows[0]!.id, id, i]);
    }
    return token;
  };
  return {
    proposal: await link({ title: "For you", message: "Three picks", locale: "el", kind: "proposal" }, [p1, p2, p3]),
    live: await link({ title: "Availability", message: null, locale: "en", kind: "availability" }, [proj]),
    pinned: await link({ title: "Quoted", message: "As quoted", locale: "ru", kind: "availability", price_list_id: pl }, [proj]),
  };
}

/** resolve_share_link's payloads for the deterministic fixture, captured on the BASE schema (0145: 0137's body). */
const SNAPSHOT_0137: Record<"proposal" | "live" | "pinned", unknown> = {
  "proposal": {
    "org": {
      "name": "Deterministic Estates"
    },
    "agent": {
      "name": "Dee Agent",
      "email": "dee@example.test",
      "phone": "+35799000000"
    },
    "title": "For you",
    "locale": "el",
    "message": "Three picks",
    "expires_at": "2099-12-31T00:00:00+00:00",
    "properties": [
      {
        "area": "Κάτω Πάφος",
        "media": [
          {
            "alt": "A view",
            "card": "properties/x/card-a.webp",
            "full": "properties/x/full-a.webp"
          },
          {
            "alt": "A view",
            "card": "properties/x/card-b.webp",
            "full": "properties/x/full-b.webp"
          }
        ],
        "title": "Βίλα Ένα",
        "bedrooms": 3,
        "currency": "EUR",
        "district": "Πάφος",
        "features": [
          "pool",
          "sea_view"
        ],
        "bathrooms": 2,
        "reference": "DET-V1",
        "year_built": 2015,
        "asking_price": 500000,
        "energy_class": "A",
        "plot_area_sqm": 600,
        "property_type": "villa",
        "parking_spaces": 2,
        "covered_area_sqm": 180,
        "rent_price_month": null,
        "transaction_type": "sale",
        "short_description": "Sea view",
        "public_description": "Three bedrooms by the sea."
      },
      {
        "area": null,
        "media": [],
        "title": "Flat Two",
        "bedrooms": 2,
        "currency": "EUR",
        "district": "Πάφος",
        "features": [],
        "bathrooms": null,
        "reference": "DET-A2",
        "year_built": null,
        "asking_price": null,
        "energy_class": null,
        "plot_area_sqm": null,
        "property_type": "apartment",
        "parking_spaces": null,
        "covered_area_sqm": null,
        "rent_price_month": 1500,
        "transaction_type": "rent",
        "short_description": null,
        "public_description": null
      }
    ],
    "property_count": 3
  },
  "live": {
    "org": {
      "name": "Deterministic Estates"
    },
    "kind": "availability",
    "agent": {
      "name": "Dee Agent",
      "email": "dee@example.test",
      "phone": "+35799000000"
    },
    "title": "Availability",
    "units": [
      {
        "block": "A",
        "price": 300000,
        "status": "available",
        "bedrooms": 2,
        "bathrooms": null,
        "reference": "DET-U001",
        "unit_number": "001",
        "veranda_sqm": null,
        "floor_number": null,
        "property_type": "apartment",
        "phase_reference": null,
        "covered_area_sqm": 85
      },
      {
        "block": "A",
        "price": 255000,
        "status": "available",
        "bedrooms": 2,
        "bathrooms": null,
        "reference": "DET-P1-U101",
        "unit_number": "101",
        "veranda_sqm": 12,
        "floor_number": 1,
        "property_type": "apartment",
        "phase_reference": "DET-PROJ-P1",
        "covered_area_sqm": 85
      },
      {
        "block": "A",
        "price": 255000,
        "status": "sold",
        "bedrooms": 2,
        "bathrooms": null,
        "reference": "DET-P1-U102",
        "unit_number": "102",
        "veranda_sqm": null,
        "floor_number": null,
        "property_type": "apartment",
        "phase_reference": "DET-PROJ-P1",
        "covered_area_sqm": 85
      },
      {
        "block": "A",
        "price": null,
        "status": "available",
        "bedrooms": 2,
        "bathrooms": null,
        "reference": "DET-P1-U105",
        "unit_number": "105",
        "veranda_sqm": null,
        "floor_number": null,
        "property_type": "apartment",
        "phase_reference": "DET-PROJ-P1",
        "covered_area_sqm": 85
      }
    ],
    "locale": "en",
    "phases": [
      {
        "title": "Phase 1",
        "status": "available",
        "reference": "DET-PROJ-P1",
        "delivery_date": "2029-09-30",
        "construction_status": null
      }
    ],
    "message": null,
    "project": {
      "area": "Kato Paphos",
      "kind": "project",
      "title": "Det Project",
      "currency": "EUR",
      "district": "Paphos",
      "features": [],
      "reference": "DET-PROJ",
      "energy_class": null,
      "delivery_date": "2028-03-31",
      "property_type": "apartment",
      "short_description": null,
      "public_description": null,
      "construction_status": "under construction"
    },
    "expires_at": "2099-12-31T00:00:00+00:00",
    "price_list": null,
    "unit_count": 4,
    "price_source": "live",
    "unpriced_count": 0,
    "available_count": 3
  },
  "pinned": {
    "org": {
      "name": "Deterministic Estates"
    },
    "kind": "availability",
    "agent": {
      "name": "Dee Agent",
      "email": "dee@example.test",
      "phone": "+35799000000"
    },
    "title": "Quoted",
    "units": [
      {
        "block": "A",
        "price": 290000,
        "status": "available",
        "bedrooms": 2,
        "bathrooms": null,
        "reference": "DET-U001",
        "unit_number": "001",
        "veranda_sqm": null,
        "floor_number": null,
        "property_type": "apartment",
        "phase_reference": null,
        "covered_area_sqm": 85
      },
      {
        "block": "A",
        "price": null,
        "status": "available",
        "bedrooms": 2,
        "bathrooms": null,
        "reference": "DET-P1-U101",
        "unit_number": "101",
        "veranda_sqm": 12,
        "floor_number": 1,
        "property_type": "apartment",
        "phase_reference": "DET-PROJ-P1",
        "covered_area_sqm": 85
      },
      {
        "block": "A",
        "price": 240000,
        "status": "sold",
        "bedrooms": 2,
        "bathrooms": null,
        "reference": "DET-P1-U102",
        "unit_number": "102",
        "veranda_sqm": null,
        "floor_number": null,
        "property_type": "apartment",
        "phase_reference": "DET-PROJ-P1",
        "covered_area_sqm": 85
      },
      {
        "block": "A",
        "price": null,
        "status": "available",
        "bedrooms": 2,
        "bathrooms": null,
        "reference": "DET-P1-U105",
        "unit_number": "105",
        "veranda_sqm": null,
        "floor_number": null,
        "property_type": "apartment",
        "phase_reference": "DET-PROJ-P1",
        "covered_area_sqm": 85
      }
    ],
    "locale": "ru",
    "phases": [
      {
        "title": "Phase 1",
        "status": "available",
        "reference": "DET-PROJ-P1",
        "delivery_date": "2029-09-30",
        "construction_status": null
      }
    ],
    "message": "As quoted",
    "project": {
      "area": "Kato Paphos",
      "kind": "project",
      "title": "Проект",
      "currency": "EUR",
      "district": "Пафос",
      "features": [],
      "reference": "DET-PROJ",
      "energy_class": null,
      "delivery_date": "2028-03-31",
      "property_type": "apartment",
      "short_description": null,
      "public_description": null,
      "construction_status": "under construction"
    },
    "expires_at": "2099-12-31T00:00:00+00:00",
    "price_list": {
      "version": 1,
      "effective_date": "2026-08-01"
    },
    "unit_count": 4,
    "price_source": "price_list",
    "unpriced_count": 2,
    "available_count": 3
  }
};

describe("4. a link whose rows are all its own organisation's resolves exactly as before", () => {
  it("proposal, live and pinned availability: the same payload on 0137's body and on this one — and the base literal", async () => {
    await rolledBack(async () => {
      const t = await deterministicFixture();
      await o.query("savepoint det");
      await o.query(REVERT_0146_SQL());
      expect(await bodyMd5(), "the base body").toBe(BODY_0137_MD5);
      const base = { proposal: await resolvePg(t.proposal), live: await resolvePg(t.live), pinned: await resolvePg(t.pinned) };
      await o.query("rollback to savepoint det");
      const now = { proposal: await resolvePg(t.proposal), live: await resolvePg(t.live), pinned: await resolvePg(t.pinned) };
      console.log(`[evidence] deterministic payloads (body ${await bodyMd5()}): ${JSON.stringify(now)}`);
      expect(now).toEqual(base);
      expect(JSON.stringify(now)).toBe(JSON.stringify(base));
      expect(now, "the literal captured on the base schema").toEqual(SNAPSHOT_0137);
      // the fixture exercises what it claims to
      expect((now.proposal as { property_count: number; properties: unknown[] }).property_count).toBe(3);
      expect((now.proposal as { properties: unknown[] }).properties).toHaveLength(2);
      expect((now.live as { units: unknown[] }).units).toHaveLength(4);
      expect((now.pinned as { unpriced_count: number }).unpriced_count).toBe(2);
    });
  });
});

describe("5. the function and the three policies, as 0146 leaves them", () => {
  it("a volatile definer owned by postgres, search_path public, returning jsonb, one overload, 0041's ACL, this file's body", async () => {
    const { rows } = await o.query(
      `select p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig, p.provolatile, p.prorettype::regtype::text as ret, p.proacl::text as acl,
              (select count(*)::int from pg_proc q where q.pronamespace = 'public'::regnamespace and q.proname = 'resolve_share_link') as overloads
         from pg_proc p where p.oid = '${SIG}'::regprocedure`,
    );
    expect(rows[0]).toEqual({ prosecdef: true, owner: "postgres", proconfig: ["search_path=public"], provolatile: "v", ret: "jsonb", acl: ACL_0041, overloads: 1 });
    expect(await bodyMd5()).toBe(BODY_0146_MD5);
  });

  it("the body is 0137's but the nine edits — on the database and in the file", async () => {
    const now = await prosrc();
    let before = "";
    await rolledBack(async () => {
      await o.query(REVERT_0146_SQL());
      before = await prosrc();
    });
    let undone = now;
    for (const [from, to] of EDITS_0146) {
      expect(undone.split(to).length - 1, `the edit is in the body once: ${to}`).toBe(1);
      undone = undone.replace(to, () => from);
    }
    expect(undone).toBe(before);
    let file = fn0137();
    for (const [from, to] of EDITS_0146) file = file.replace(from, () => to);
    expect(fn0146()).toBe(file);
  });

  it("0041's exposure guard: no forbidden column name appears in the function's source", async () => {
    const src = await prosrc();
    for (const w of FORBIDDEN_0041) expect(src, w).not.toContain(w);
  });

  it("the three policies: exactly 0146's checks, share_links_update's USING untouched, each permissive for PUBLIC", async () => {
    await rolledBack(async () => {
      const p = await policyTexts();
      for (const [name, want] of Object.entries(POLICIES_0146)) {
        expect(p[name]?.c, name).toBe(want.after);
        expect(p[name]?.permissive, name).toBe(true);
        expect(p[name]?.roles, name).toBe("{0}");
      }
      expect(p.share_link_properties_insert!.cmd).toBe("a");
      expect(p.share_links_insert!.cmd).toBe("a");
      expect(p.share_links_update!.cmd).toBe("w");
      expect(p.share_links_update!.q).toBe(SHARE_LINKS_UPDATE_USING);
    });
  });

  it("each binding is the only permissive policy for its command — permissive policies OR together, so a sibling would undo it", async () => {
    const { rows } = await o.query(
      `select (select count(*)::int from pg_policy p where p.polrelid = 'public.share_link_properties'::regclass and p.polpermissive and p.polcmd in ('a', '*')) as slp_insert,
              (select count(*)::int from pg_policy p where p.polrelid = 'public.share_links'::regclass and p.polpermissive and p.polcmd in ('a', '*')) as links_insert,
              (select count(*)::int from pg_policy p where p.polrelid = 'public.share_links'::regclass and p.polpermissive and p.polcmd in ('w', '*')) as links_update`,
    );
    expect(rows[0]).toEqual({ slp_insert: 1, links_insert: 1, links_update: 1 });
  });

  it("share_link_properties has no UPDATE path: no UPDATE / ALL permissive policy, no API role's UPDATE grant", async () => {
    const { rows } = await o.query(
      `select (select count(*)::int from pg_policy p where p.polrelid = 'public.share_link_properties'::regclass and p.polpermissive and p.polcmd in ('w', '*')) as policies,
              has_table_privilege('authenticated', 'public.share_link_properties', 'update') as auth,
              has_table_privilege('anon', 'public.share_link_properties', 'update') as anon`,
    );
    expect(rows[0]).toEqual({ policies: 0, auth: false, anon: false });
  });
});

describe("6. the migration itself (rolled back)", () => {
  it("replays over its rollback text: preflight, postflight, the diagnostic as its last row, the same body and policies as applied", async () => {
    await rolledBack(async (notices) => {
      await o.query(REVERT_0146_SQL());
      expect(await bodyMd5()).toBe(BODY_0137_MD5);
      const reverted = await policyTexts();
      for (const [name, want] of Object.entries(POLICIES_0146)) expect(reverted[name]?.c, `${name} reverted`).toBe(want.before);
      const res = await o.query(readMigration0146());
      const results = Array.isArray(res) ? res : [res];
      expect(results[results.length - 1]!.rows[0].existing_rows).toMatch(/^link_rows_across_orgs=\d+ pinned_lists_across_orgs=\d+ rows_under_a_foreign_parent=\d+ creators_across_orgs=\d+$/);
      expect(notices.some((m) => m.startsWith("0146: preflight passed"))).toBe(true);
      expect(notices.some((m) => m.startsWith("0146: postflight passed"))).toBe(true);
      expect(await bodyMd5()).toBe(BODY_0146_MD5);
      const after = await policyTexts();
      for (const [name, want] of Object.entries(POLICIES_0146)) expect(after[name]?.c, name).toBe(want.after);
    });
  });

  it("the rollback recipe brings the leak back: a B proposal shows A's listing and A's agent, B's unit shows on A's page, A's list on B's", async () => {
    await rolledBack(async () => {
      const plant = async (org: string, extra: Record<string, unknown>, ids: string[]) => {
        const token = mint();
        const { rows } = await o.query<{ id: string }>(
          "insert into share_links (org_id, token_sha256, expires_at, kind, price_list_id, created_by) values ($1, $2, now() + interval '1 day', $3, $4, $5) returning id",
          [org, sha(token), extra.kind ?? "proposal", extra.price_list_id ?? null, extra.created_by ?? null],
        );
        for (const [i, id] of ids.entries()) await o.query("insert into share_link_properties values ($1, $2, $3)", [rows[0]!.id, id, i]);
        return token;
      };
      const proposal = await plant(ORG_B, { created_by: adminA.id }, [f.listingB, f.listingA]);
      const foreignTarget = await plant(ORG_B, { kind: "availability" }, [f.projA]);
      // a project of A's own for this case (section 3's plants are committed under f.projPlantA)
      const unitRow = (org: string, r: string, parent: string) =>
        o.query("insert into properties (org_id, reference, property_type, kind, parent_id, status, asking_price) values ($1, $2, 'apartment', 'unit', $3, 'available', 590009)", [org, ref(r), parent]);
      const rbProj = (await o.query<{ id: string }>("insert into properties (org_id, reference, property_type, kind) values ($1, $2, 'apartment', 'project') returning id", [ORG_A, ref("RB-PROJ")])).rows[0]!.id;
      await unitRow(ORG_A, "RB-OWN", rbProj);
      await unitRow(ORG_B, "RB-PLANT", rbProj);
      const aPage = await plant(ORG_A, { kind: "availability" }, [rbProj]);
      const pinned = await plant(ORG_B, { kind: "availability", price_list_id: f.plA }, [f.projB]);

      const shown = async () => ({
        proposal: ((await resolvePg(proposal))!.properties as { reference: string }[]).map((x) => x.reference),
        agent: ((await resolvePg(proposal))!.agent as { email: string } | null)?.email ?? null,
        foreignTarget: (await resolvePg(foreignTarget)) !== null,
        aPage: ((await resolvePg(aPage))!.units as { reference: string }[]).map((u) => u.reference).sort(),
        pinned: (await resolvePg(pinned))!.price_list,
      });
      await o.query("savepoint s");
      await o.query(REVERT_0146_SQL());
      const leaked = await shown();
      await o.query("rollback to savepoint s");
      const bound = await shown();
      console.log(`[evidence] rollback recipe: ${JSON.stringify(leaked)}; 0146: ${JSON.stringify(bound)}`);
      expect(leaked).toEqual({
        proposal: [ref("LB"), ref("LA")],
        agent: adminA.email,
        foreignTarget: true,
        aPage: [ref("RB-OWN"), ref("RB-PLANT")].sort(),
        pinned: { version: 7, effective_date: A_LIST_DATE },
      });
      expect(bound).toEqual({ proposal: [ref("LB")], agent: null, foreignTarget: false, aPage: [ref("RB-OWN")], pinned: null });
    });
  });

  it("the diagnostic counts exactly what it names — and repairs nothing", async () => {
    const diagnostic = async () => {
      await o.query("savepoint d");
      await o.query(REVERT_0146_SQL());
      const res = await o.query(readMigration0146());
      const results = Array.isArray(res) ? res : [res];
      const m = /^link_rows_across_orgs=(\d+) pinned_lists_across_orgs=(\d+) rows_under_a_foreign_parent=(\d+) creators_across_orgs=(\d+)$/.exec(results[results.length - 1]!.rows[0].existing_rows);
      await o.query("rollback to savepoint d");
      expect(m, "the last row's shape").not.toBeNull();
      return { links: Number(m![1]), lists: Number(m![2]), parents: Number(m![3]), creators: Number(m![4]) };
    };
    await rolledBack(async () => {
      const before = await diagnostic();
      const { rows } = await o.query<{ id: string }>(
        "insert into share_links (org_id, token_sha256, expires_at, kind, price_list_id, created_by) values ($1, $2, now() + interval '1 day', 'availability', $3, $4) returning id",
        [ORG_B, sha(mint()), f.plA, adminA.id],
      ); // a list across organisations, and a creator across organisations
      await o.query(
        "insert into share_links (org_id, token_sha256, expires_at, created_by) values ($1, $2, now() + interval '1 day', $3)",
        [ORG_B, sha(mint()), adminB.id],
      ); // a creator of its own: not counted
      await o.query("insert into share_link_properties values ($1, $2, 0), ($1, $3, 1)", [rows[0]!.id, f.projB, f.listingA]); // one row across, one not
      await o.query("insert into properties (org_id, reference, property_type, kind, parent_id) values ($1, $2, 'apartment', 'unit', $3)", [ORG_B, ref("DIAG"), f.projA]); // under a foreign parent
      await o.query("insert into properties (org_id, reference, property_type, kind, parent_id) values ($1, $2, 'apartment', 'unit', $3)", [ORG_A, ref("DIAG2"), f.projA]); // under its own: not counted
      const after = await diagnostic();
      expect(after).toEqual({ links: before.links + 1, lists: before.lists + 1, parents: before.parents + 1, creators: before.creators + 1 });
      const left = await o.query("select count(*)::int as n from share_link_properties where share_link_id = $1", [rows[0]!.id]);
      expect(left.rows[0].n, "nothing repaired").toBe(2);
    });
  });

  /** The file with `text` changed, applied over the rollback text inside a rolled-back transaction: it must refuse with `refusal`. */
  async function refusedBy(bad: string, refusal: RegExp) {
    expect(bad, "the change is in the file").not.toBe(readMigration0146());
    await rolledBack(async () => {
      await o.query(REVERT_0146_SQL());
      await o.query("savepoint s");
      await expect(o.query(bad)).rejects.toThrow(refusal);
      await o.query("rollback to savepoint s");
      expect(await bodyMd5(), "the replaced body goes with the refusal").toBe(BODY_0137_MD5);
    });
  }

  // The file's own text, weakened: EACH postflight guard must refuse it with ITS message. The body's md5 pin runs
  // after them — were it first, it would answer every one of these and a guard that could never raise would pass.
  for (const [i, [from, to]] of EDITS_0146.entries()) {
    it(`the postflight's predicate guard refuses the file with edit ${i + 1} undone`, async () => {
      await refusedBy(
        readMigration0146().replace(to, () => from),
        /0146 postflight: resolve_share_link does not carry every organisation predicate this file writes/,
      );
    });
  }

  it("the postflight's throttle guard refuses the file with 0137's organisation bound dropped from a throttle", async () => {
    await refusedBy(
      readMigration0146().replace("         and org_id      = v_link.org_id\n         and actor_id    is null\n", "         and actor_id    is null\n"),
      /0146 postflight: the two `opened` throttles are not both bounded by the link's organisation and a null actor/,
    );
  });

  it("the postflight's exposure guard refuses a body that names a forbidden column", async () => {
    await refusedBy(
      readMigration0146().replace(
        "    -- 0146: the target is a property of the link's own organisation, or none\n",
        "    -- 0146: the target is a property of the link's own organisation, or none — never its internal_notes\n",
      ),
      /0146 postflight: resolve_share_link names the forbidden column internal_notes/,
    );
  });

  it("the postflight's md5 pin refuses a body every other guard accepts", async () => {
    await refusedBy(
      readMigration0146().replace(
        "-- throttle: one `opened` event per link per Cyprus day (see header)",
        "-- throttle: one `opened` event per link per Cyprus day (see the header)",
      ),
      /0146 postflight: resolve_share_link's body is not this file's/,
    );
  });

  const PRICE_CLAUSE =
    "    -- 0146: a pinned price list is the caller's organisation's\n    and (price_list_id is null\n         or exists (select 1 from price_lists pl\n                     where pl.id = share_links.price_list_id and pl.org_id = (select current_org_id())))\n";
  const CLAUSES: [keyof typeof POLICIES_0146, string, string][] = [
    [
      "share_link_properties_insert",
      "property",
      "    -- 0146: and so is the property it names (an availability link's target too)\n    and exists (select 1 from properties p\n                 where p.id = share_link_properties.property_id and p.org_id = (select current_org_id()))\n",
    ],
    ["share_links_insert", "price list", PRICE_CLAUSE],
    ["share_links_update", "price list", PRICE_CLAUSE],
    [
      "share_links_update",
      "creator",
      "    -- 0146: and so is the profile it names as its creator (the page shows it as the link's agent)\n    and (created_by is null\n         or exists (select 1 from profiles pf\n                     where pf.id = share_links.created_by and pf.org_id = (select current_org_id())))\n",
    ],
  ];
  for (const [name, what, clause] of CLAUSES) {
    it(`the postflight refuses the file with ${name}'s 0146 ${what} clause dropped`, async () => {
      const m = readMigration0146();
      const at = m.indexOf(`alter policy ${name} on`);
      const end = m.indexOf("  );", at);
      expect(m.slice(at, end)).toContain(clause);
      await refusedBy(m.slice(0, at) + m.slice(at, end).replace(clause, "") + m.slice(end), new RegExp(`0146 postflight: ${name} is not this file's`));
    });
  }

  it("the postflight refuses a file that adds a permissive sibling beside a binding (permissive policies OR together)", async () => {
    const m = readMigration0146();
    const at = m.indexOf("-- ---------------------------------------------------------------------------\n-- Postflight");
    expect(at).toBeGreaterThan(0);
    await refusedBy(
      `${m.slice(0, at)}create policy zz_links_update_probe on public.share_links for update using (true);\n\n${m.slice(at)}`,
      /0146 postflight: a permissive INSERT \/ UPDATE policy sits beside the three this file binds/,
    );
  });

  const drifts: [string, string | null, RegExp][] = [
    ["applied twice (the body is already 0146's)", null, /0146 aborted: resolve_share_link is not 0137's definer body/],
    ["a body that differs from 0137's", "__EDITED__", /0146 aborted: resolve_share_link is not 0137's definer body/],
    ["not a definer", `alter function ${SIG} security invoker`, /0146 aborted: resolve_share_link is not 0137's definer body \(md5 missing/],
    ["stable instead of volatile", `alter function ${SIG} stable`, /0146 aborted: resolve_share_link is not 0137's definer body \(md5 missing/],
    ["PUBLIC may call it", `grant execute on function ${SIG} to public`, /0146 aborted: resolve_share_link's ACL is not 0041's/],
    ["anon may not call it", `revoke execute on function ${SIG} from anon`, /0146 aborted: resolve_share_link's ACL is not 0041's/],
    ["an overload beside it", "create function public.resolve_share_link(p int) returns int language sql as $f$ select 0 $f$", /0146 aborted: resolve_share_link is missing or overloaded/],
    ["share_link_properties_insert drifted", "alter policy share_link_properties_insert on public.share_link_properties with check (true)", /0146 aborted: share_link_properties_insert is not 0023's check/],
    ["share_links_insert drifted", "alter policy share_links_insert on public.share_links with check (org_id = (select current_org_id()))", /0146 aborted: share_links_insert is not 0100's check/],
    ["share_links_update's USING drifted", "alter policy share_links_update on public.share_links using (true)", /0146 aborted: share_links_update is not 0100's policy/],
    ["share_links_update narrowed to a role", "alter policy share_links_update on public.share_links to authenticated", /0146 aborted: share_links_update is not 0100's policy/],
    ["an UPDATE grant on share_link_properties", "grant update on public.share_link_properties to authenticated", /0146 aborted: share_link_properties has an UPDATE path/],
    ["a permissive UPDATE policy on share_link_properties", "create policy slp_update_probe on public.share_link_properties for update using (true)", /0146 aborted: share_link_properties has an UPDATE path/],
    // permissive policies OR together: a sibling would undo the check this file adds
    ["a second permissive INSERT policy on share_link_properties", "create policy zz_slp_insert_probe on public.share_link_properties for insert with check (true)", /0146 aborted: share_link_properties_insert is not the only permissive INSERT policy on share_link_properties/],
    ["a permissive ALL policy on share_links", "create policy zz_links_all_probe on public.share_links for all using (true)", /0146 aborted: share_links_insert \/ share_links_update are not the only permissive INSERT \/ UPDATE policies on share_links/],
    ["a second permissive INSERT policy on share_links", "create policy zz_links_insert_probe on public.share_links for insert with check (true)", /0146 aborted: share_links_insert \/ share_links_update are not the only permissive INSERT \/ UPDATE policies on share_links/],
    ["a second permissive UPDATE policy on share_links", "create policy zz_links_update_probe on public.share_links for update using (true)", /0146 aborted: share_links_insert \/ share_links_update are not the only permissive INSERT \/ UPDATE policies on share_links/],
  ];
  for (const [what, drift, refusal] of drifts) {
    it(`the preflight refuses: ${what} — and changes nothing`, async () => {
      await rolledBack(async () => {
        if (drift === "__EDITED__") {
          await o.query(REVERT_0146_SQL().replace("-- throttle: one `opened` event per link per Cyprus day (see header)", "-- throttle: one per day (edited by hand)"));
        } else if (drift) {
          await o.query(REVERT_0146_SQL());
          await o.query(drift);
        }
        const md5 = await bodyMd5();
        const policies = await policyTexts();
        await o.query("savepoint s");
        await expect(o.query(readMigration0146())).rejects.toThrow(refusal);
        await o.query("rollback to savepoint s");
        expect(await bodyMd5(), "the body is as it was").toBe(md5);
        expect(await policyTexts(), "the policies are as they were").toEqual(policies);
      });
    });
  }

  it("the file refuses before it changes anything", () => {
    const sql = readMigration0146().replace(/--[^\n]*/g, "");
    const firstChange = sql.search(/^\s*(create|alter|drop|revoke|grant|comment)\b/im);
    expect(firstChange).toBeGreaterThan(0);
    expect(sql.lastIndexOf("0146 aborted")).toBeLessThan(firstChange);
    expect(sql.indexOf("0146 postflight")).toBeGreaterThan(firstChange);
  });

  it("outside one transaction it refuses before anything else (the one-transaction guard)", async () => {
    const sql = readMigration0146();
    const from = sql.indexOf("set local lock_timeout = '5s';");
    const doStart = sql.indexOf("do $$", from);
    const doEnd = sql.indexOf("end $$;", doStart) + "end $$;".length;
    expect(sql.slice(doStart, doEnd)).toMatch(/must run as ONE transaction/);
    const c = new Client({ connectionString: DB_URL });
    await c.connect();
    try {
      await c.query("set local lock_timeout = '5s'");
      await expect(c.query(sql.slice(doStart, doEnd))).rejects.toThrow(/0146 aborted: this file must run as ONE transaction/);
    } finally {
      await c.end();
    }
  });

  it("the restore pack's 0146 row reads true now, and false on the rollback text and with any one binding missing", async () => {
    const pack = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "backup", "verify-restore.sql"), "utf-8").replace(/\r\n/g, "\n");
    const from = pack.indexOf("  select 'SECURITY: a share link names, pins and shows only its own organisation''s properties, price list and agent (0146)'");
    expect(from, "the pack carries the 0146 row").toBeGreaterThan(0);
    const to = pack.indexOf("\n  union all\n", from);
    const row = `select * from (${pack.slice(from, to)}) r(check_name, expected, actual)`;
    expect((await o.query<{ expected: string; actual: string }>(row)).rows[0]).toMatchObject({ expected: "true", actual: "true" });
    const weakened: string[] = [
      REVERT_0146_SQL(),
      ...EDITS_0146.map(([from_, to_]) => fn0146().replace(to_, () => from_)),
      "alter policy share_link_properties_insert on public.share_link_properties with check (exists (select 1 from share_links s where s.id = share_link_properties.share_link_id and s.org_id = (select current_org_id())))",
      "alter policy share_links_insert on public.share_links with check (((org_id = (select current_org_id())) AND (created_by = (select auth.uid()))))",
      "alter policy share_links_update on public.share_links with check ((org_id = (select current_org_id())))",
      // share_links_update with one of its two 0146 clauses
      "alter policy share_links_update on public.share_links with check (org_id = (select current_org_id()) and (price_list_id is null or exists (select 1 from price_lists pl where pl.id = share_links.price_list_id and pl.org_id = (select current_org_id()))))",
      "alter policy share_links_update on public.share_links with check (org_id = (select current_org_id()) and (created_by is null or exists (select 1 from profiles pf where pf.id = share_links.created_by and pf.org_id = (select current_org_id()))))",
      // a permissive sibling ORs a binding away
      "create policy zz_slp_insert_probe on public.share_link_properties for insert with check (true)",
      "create policy zz_links_insert_probe on public.share_links for insert with check (true)",
      "create policy zz_links_update_probe on public.share_links for update using (true)",
      "create policy zz_links_all_probe on public.share_links for all using (true)",
    ];
    for (const install of weakened) {
      await rolledBack(async () => {
        await o.query(install);
        expect((await o.query<{ actual: string }>(row)).rows[0]!.actual, install.slice(0, 120)).toBe("false");
      });
    }
  });
});

// ---------------------------------------------------------------------------
describe("7. a killed run of this file leaves nothing behind once the next run has swept", () => {
  it("the sweep beforeAll runs removes an earlier run's organisation whole — users, profiles, events, links, properties — and never this run's", async () => {
    // what a run killed before its afterAll leaves: a throwaway organisation with a user, a listing, a link, an event
    const killed = randomUUID();
    await ensureTestOrg(svc, killed, `${NAME_B} killed-${RUN}`, `share-tenant-killed-${RUN}`);
    const user = await createTestUser(svc, `st-killed-${RUN}@test.local`, "admin", killed, { enrolFactor: false });
    const listing = await property(killed, "KILLED", { visibility: "public" });
    const l = await svcLink(killed, user.id, {}, [listing]);
    expect(await resolveAsAnon(l.token), "the link resolves (and writes its `opened` event)").not.toBeNull();

    await sweepStaleRuns([ORG_A, ORG_B]);

    const { rows } = await o.query(
      `select (select count(*)::int from organizations where id = $1) as orgs,
              (select count(*)::int from profiles where org_id = $1) as profiles,
              (select count(*)::int from auth.users where id = $2) as users,
              (select count(*)::int from events where org_id = $1) as events,
              (select count(*)::int from share_links where org_id = $1) as links,
              (select count(*)::int from properties where org_id = $1) as properties,
              (select count(*)::int from districts where org_id = $1) as districts,
              (select count(*)::int from deal_stages where org_id = $1) as stages`,
      [killed, user.id],
    );
    console.log(`[evidence] a killed run's rows after the sweep: ${JSON.stringify(rows[0])}`);
    expect(rows[0]).toEqual({ orgs: 0, profiles: 0, users: 0, events: 0, links: 0, properties: 0, districts: 0, stages: 0 });
    const own = await o.query<{ n: number }>("select count(*)::int as n from organizations where id = any($1::uuid[])", [[ORG_A, ORG_B]]);
    expect(own.rows[0]!.n, "this run's organisations are untouched").toBe(2);
  });
});
