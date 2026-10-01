import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";
import { toCsv } from "@/lib/services/csv";
import { VIEWING_EXPORT_SELECT, viewingCsvColumns, type ViewingExportRow } from "@/lib/services/viewing-export";

/**
 * 0129: a deal's children — offers, reservations, viewings, a converted lead —
 * and a viewing's slip belong to their parent's organisation; a hold's offer
 * too (T-deal-child-org-isolation, the deal-side sequel of 0119–0126).
 *
 * THE GAP at 0128 (measured through PostgREST, aal2 sessions of two throwaway
 * organisations): offers.deal_id, reservations.deal_id / offer_id,
 * viewings.deal_id, leads.converted_deal_id and viewing_slips.viewing_id
 * referenced their parent by id ALONE, and the insert / update policies check
 * only the CALLER's organisation. So a member of B could hang rows of B on A's
 * deal, offer or viewing; a real id (accepted) and a missing one (23503) told
 * B whether the A row exists; and B's ADMIN could sign A's viewing — after
 * which A's own slip failed unique(viewing_id) (a denial of service), and a
 * slip on an A viewing that already had one answered 23505 (whether A's
 * viewing was signed).
 *
 * Where a policy refuses first it is said: offers_insert's and
 * viewing_slips_insert's agent arms read the deal / viewing under RLS, so a B
 * AGENT meets 42501 before any key — before and after 0129. Every UPDATE, and
 * the admin arms, reach the key.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const RUN = Date.now().toString(36);

let svc: SupabaseClient;
let pg: Client;
let adminA: TestUser;
let adminB: TestUser;
let agentB: TestUser;
const userIds: string[] = [];
const stage: Record<string, string> = {};
let n = 0;

async function one<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T> {
  return (await pg.query(sql, args)).rows[0] as T;
}
const count = async (sql: string, args: unknown[] = []) => (await one<{ c: number }>(sql, args)).c;

async function newProperty(org: string) {
  n += 1;
  return (await one<{ id: string }>(
    "insert into properties (org_id, reference, property_type, status) values ($1, $2, 'apartment', 'available') returning id",
    [org, `ZZDC${RUN.slice(-4).toUpperCase()}${n}`],
  )).id;
}
async function newContact(org: string) {
  n += 1;
  return (await one<{ id: string }>("insert into contacts (org_id, first_name) values ($1, $2) returning id", [org, `ZZDC ${RUN} ${n}`])).id;
}
async function newDeal(org: string) {
  n += 1;
  return (await one<{ id: string }>(
    "insert into deals (org_id, deal_type, stage_id, title) values ($1, 'sale', $2, $3) returning id",
    [org, stage[org], `ZZDC ${RUN} ${n}`],
  )).id;
}
async function newOffer(org: string, deal: string) {
  return (await one<{ id: string }>("insert into offers (org_id, deal_id, amount) values ($1, $2, 1000) returning id", [org, deal])).id;
}
async function newViewing(org: string, agent: string, deal: string | null = null) {
  const property = await newProperty(org);
  const contact = await newContact(org);
  return (await one<{ id: string }>(
    "insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at, deal_id) values ($1, $2, $3, $4, now() + interval '1 day', $5) returning id",
    [org, property, contact, agent, deal],
  )).id;
}
const slipRow = (org: string, viewing: string, who: string) => ({
  org_id: org,
  viewing_id: viewing,
  signer_name: who,
  signature_path: `${org}/${viewing}.png`,
  signature_sha256: "0".repeat(64),
});

/** A refusal by the key: 23503, and its message names no row of A. */
function expectKeyRefusal(r: { error: { code?: string; message?: string } | null }, label: string) {
  expect(r.error?.code, `${label}: ${JSON.stringify(r.error)}`).toBe("23503");
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG_A, `DealChild A ${RUN}`, `dealchild-a-${RUN}`);
  await ensureTestOrg(svc, ORG_B, `DealChild B ${RUN}`, `dealchild-b-${RUN}`);
  adminA = await createTestUser(svc, `dc-admin-a-${RUN}@test.local`, "admin", ORG_A);
  userIds.push(adminA.id);
  adminB = await createTestUser(svc, `dc-admin-b-${RUN}@test.local`, "admin", ORG_B);
  userIds.push(adminB.id);
  agentB = await createTestUser(svc, `dc-agent-b-${RUN}@test.local`, "agent", ORG_B);
  userIds.push(agentB.id);
  for (const org of [ORG_A, ORG_B]) {
    stage[org] = (await one<{ id: string }>(
      "select id from deal_stages where org_id = $1 and deal_type = 'sale' and not is_won and not is_lost order by sort_order limit 1",
      [org],
    )).id;
  }
});

afterAll(async () => {
  const orgs = [ORG_A, ORG_B];
  for (const t of ["viewing_slips", "tasks", "reservation_installments", "reservations", "offers", "viewings", "leads", "deals", "contacts", "properties"]) {
    await pg.query(`delete from ${t} where org_id = any($1)`, [orgs]);
  }
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = any($1)`, [orgs]);
  }
  await pg.query("delete from organizations where id = any($1)", [orgs]);
  await pg.end();
});

describe("the premise: B cannot read A's deal, offer or viewing", () => {
  it("B's admin sees none of them", async () => {
    const deal = await newDeal(ORG_A);
    const offer = await newOffer(ORG_A, deal);
    const viewing = await newViewing(ORG_A, adminA.id);
    for (const [table, id] of [["deals", deal], ["offers", offer], ["viewings", viewing]] as const) {
      expect((await adminB.client.from(table).select("id").eq("id", id)).data, table).toEqual([]);
    }
  });
});

describe("B cannot hang an offer on A's deal (23503) — RED at 0128", () => {
  it("INSERT as B's admin, and a B offer re-pointed or upserted onto A's deal, are refused; nothing written", async () => {
    const dealA = await newDeal(ORG_A);
    expectKeyRefusal(await adminB.client.from("offers").insert({ org_id: ORG_B, deal_id: dealA, amount: 1 }).select("id"), "insert");
    const dealB = await newDeal(ORG_B);
    const offerB = await newOffer(ORG_B, dealB);
    expectKeyRefusal(await adminB.client.from("offers").update({ deal_id: dealA }).eq("id", offerB).select("id"), "update");
    expectKeyRefusal(
      await adminB.client.from("offers").upsert({ id: offerB, org_id: ORG_B, deal_id: dealA, amount: 1 }, { onConflict: "id" }).select("id"),
      "upsert",
    );
    expect(await count("select count(*)::int as c from offers where deal_id = $1", [dealA])).toBe(0);
  });

  it("a real A deal and a missing id read the same refusal — no oracle on A's deal ids", async () => {
    const dealA = await newDeal(ORG_A);
    const real = await adminB.client.from("offers").insert({ org_id: ORG_B, deal_id: dealA, amount: 1 }).select("id");
    const none = await adminB.client.from("offers").insert({ org_id: ORG_B, deal_id: randomUUID(), amount: 1 }).select("id");
    const shape = (e: { code?: string; message?: string; details?: string } | null) =>
      [e?.code, e?.message, e?.details?.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")];
    expect(shape(real.error)).toEqual(shape(none.error));
    expect(real.error?.code).toBe("23503");
  });
});

describe("B cannot name A's deal or offer on a hold (23503) — RED at 0128", () => {
  it("INSERT as B's agent and admin, and a B hold re-pointed, are refused", async () => {
    const dealA = await newDeal(ORG_A);
    const offerA = await newOffer(ORG_A, dealA);
    for (const [who, u] of [["agent", agentB], ["admin", adminB]] as const) {
      const property = await newProperty(ORG_B);
      const base = { org_id: ORG_B, property_id: property, expires_at: new Date(Date.now() + 86_400_000).toISOString() };
      expectKeyRefusal(await u.client.from("reservations").insert({ ...base, deal_id: dealA }).select("id"), `${who} deal`);
      expectKeyRefusal(await u.client.from("reservations").insert({ ...base, offer_id: offerA }).select("id"), `${who} offer`);
    }
    const property = await newProperty(ORG_B);
    const hold = (await one<{ id: string }>(
      "insert into reservations (org_id, property_id, expires_at) values ($1, $2, now() + interval '1 day') returning id",
      [ORG_B, property],
    )).id;
    expectKeyRefusal(await adminB.client.from("reservations").update({ deal_id: dealA }).eq("id", hold).select("id"), "update deal");
    expectKeyRefusal(await adminB.client.from("reservations").update({ offer_id: offerA }).eq("id", hold).select("id"), "update offer");
    expect(await count("select count(*)::int as c from reservations where deal_id = $1 or offer_id = $2", [dealA, offerA])).toBe(0);
  });
});

describe("B cannot name A's deal on a viewing (23503) — RED at 0128", () => {
  it("INSERT as B's agent and admin, and a B viewing re-pointed, are refused", async () => {
    const dealA = await newDeal(ORG_A);
    for (const [who, u] of [["agent", agentB], ["admin", adminB]] as const) {
      const property = await newProperty(ORG_B);
      const contact = await newContact(ORG_B);
      const r = await u.client
        .from("viewings")
        .insert({ org_id: ORG_B, property_id: property, contact_id: contact, agent_id: u.id, scheduled_at: new Date(Date.now() + 86_400_000).toISOString(), deal_id: dealA })
        .select("id");
      expectKeyRefusal(r, who);
    }
    const viewingB = await newViewing(ORG_B, agentB.id);
    expectKeyRefusal(await agentB.client.from("viewings").update({ deal_id: dealA }).eq("id", viewingB).select("id"), "update");
    expect(await count("select count(*)::int as c from viewings where deal_id = $1", [dealA])).toBe(0);
  });
});

describe("B cannot mark its lead converted into A's deal (23503) — RED at 0128", () => {
  it("B's admin re-pointing a B lead's converted_deal_id onto A's deal is refused", async () => {
    const dealA = await newDeal(ORG_A);
    const leadB = (await one<{ id: string }>("insert into leads (org_id) values ($1) returning id", [ORG_B])).id;
    expectKeyRefusal(await adminB.client.from("leads").update({ converted_deal_id: dealA }).eq("id", leadB).select("id"), "update");
    expect((await one<{ c: string | null }>("select converted_deal_id as c from leads where id = $1", [leadB])).c).toBeNull();
  });
});

describe("B cannot sign A's viewing (23503) — RED at 0128", () => {
  it("B's admin signing A's viewing is refused, and A can still sign it", async () => {
    const viewingA = await newViewing(ORG_A, adminA.id);
    expectKeyRefusal(await adminB.client.from("viewing_slips").insert(slipRow(ORG_B, viewingA, "Forged")).select("id"), "insert");
    // the denial of service at 0128: B's slip held unique(viewing_id) and A's own failed 23505
    const own = await adminA.client.from("viewing_slips").insert(slipRow(ORG_A, viewingA, "Real Signer")).select("id");
    expect(own.error, JSON.stringify(own.error)).toBeNull();
  });

  it("a slip on an A viewing that is already signed reads the same 23503 as on an unsigned one — no oracle on A's slips", async () => {
    const signed = await newViewing(ORG_A, adminA.id);
    await pg.query(
      "insert into viewing_slips (org_id, viewing_id, signer_name, signature_path, signature_sha256) values ($1, $2, 'A signer', 'x', $3)",
      [ORG_A, signed, "0".repeat(64)],
    );
    const unsigned = await newViewing(ORG_A, adminA.id);
    const a = await adminB.client.from("viewing_slips").insert(slipRow(ORG_B, signed, "Probe")).select("id");
    const b = await adminB.client.from("viewing_slips").insert(slipRow(ORG_B, unsigned, "Probe")).select("id");
    expect([a.error?.code, b.error?.code]).toEqual(["23503", "23503"]);
  });
});

describe("the keys bind every writer", () => {
  it("the service role cannot hang a B offer on A's deal, nor move a slip off its viewing's organisation", async () => {
    const dealA = await newDeal(ORG_A);
    expectKeyRefusal(await svc.from("offers").insert({ org_id: ORG_B, deal_id: dealA, amount: 1 }).select("id"), "service offer");
    const viewingA = await newViewing(ORG_A, adminA.id);
    expectKeyRefusal(await svc.from("viewing_slips").insert(slipRow(ORG_B, viewingA, "Svc")).select("id"), "service slip");
  });
});

describe("same-organisation links, embeds and deletion stay as they were", () => {
  it("A links its own offer, hold, viewing, lead and slip to its own deal and viewing", async () => {
    const deal = await newDeal(ORG_A);
    const offer = await adminA.client.from("offers").insert({ org_id: ORG_A, deal_id: deal, amount: 5 }).select("id").single();
    expect(offer.error).toBeNull();
    const property = await newProperty(ORG_A);
    const hold = await adminA.client
      .from("reservations")
      .insert({ org_id: ORG_A, property_id: property, deal_id: deal, offer_id: offer.data!.id, expires_at: new Date(Date.now() + 86_400_000).toISOString() })
      .select("id")
      .single();
    expect(hold.error, JSON.stringify(hold.error)).toBeNull();
    const viewing = await newViewing(ORG_A, adminA.id, deal);
    const lead = (await one<{ id: string }>("insert into leads (org_id) values ($1) returning id", [ORG_A])).id;
    expect((await adminA.client.from("leads").update({ converted_deal_id: deal }).eq("id", lead).select("id")).error).toBeNull();
    expect((await adminA.client.from("viewing_slips").insert(slipRow(ORG_A, viewing, "Own")).select("id")).error).toBeNull();
  });

  it("a viewing's slip still embeds as ONE object (the CSV's Signed by reads it)", async () => {
    const viewing = await newViewing(ORG_A, adminA.id);
    await pg.query(
      "insert into viewing_slips (org_id, viewing_id, signer_name, signature_path, signature_sha256) values ($1, $2, 'Embedded Signer', 'x', $3)",
      [ORG_A, viewing, "0".repeat(64)],
    );
    const r = await adminA.client.from("viewings").select("id, viewing_slips(signer_name)").eq("id", viewing).single();
    expect(r.error).toBeNull();
    expect(r.data!.viewing_slips).toEqual({ signer_name: "Embedded Signer" });
  });

  it("the viewings CSV reads the signer through that object — RED before the export's fix", async () => {
    const viewing = await newViewing(ORG_A, adminA.id);
    await pg.query(
      "insert into viewing_slips (org_id, viewing_id, signer_name, signature_path, signature_sha256) values ($1, $2, 'Csv Signer', 'x', $3)",
      [ORG_A, viewing, "0".repeat(64)],
    );
    const r = await adminA.client.from("viewings").select(VIEWING_EXPORT_SELECT).eq("id", viewing);
    expect(r.error).toBeNull();
    const csv = toCsv(viewingCsvColumns(), (r.data ?? []) as unknown as ViewingExportRow[]);
    expect(csv, "Signed by is filled for a signed viewing").toContain("Csv Signer");
  });

  it("the relationships still embed one way each: an offer's deal, a hold's deal and offer, a viewing's deal, a lead's deal", async () => {
    const deal = await newDeal(ORG_A);
    const offer = await newOffer(ORG_A, deal);
    const property = await newProperty(ORG_A);
    await pg.query(
      "insert into reservations (org_id, property_id, deal_id, offer_id, expires_at) values ($1, $2, $3, $4, now() + interval '1 day')",
      [ORG_A, property, deal, offer],
    );
    await newViewing(ORG_A, adminA.id, deal);
    await pg.query("insert into leads (org_id, converted_deal_id) values ($1, $2)", [ORG_A, deal]);
    const o = await adminA.client.from("offers").select("id, deals(id)").eq("id", offer).single();
    expect(o.error).toBeNull();
    expect(o.data!.deals).toEqual({ id: deal });
    const h = await adminA.client.from("reservations").select("deals(id), offers(id)").eq("deal_id", deal).single();
    expect(h.error).toBeNull();
    expect(h.data).toEqual({ deals: { id: deal }, offers: { id: offer } });
    const v = await adminA.client.from("viewings").select("deals(id, title)").eq("deal_id", deal).single();
    expect(v.error).toBeNull();
    expect(v.data!.deals).toMatchObject({ id: deal });
    const l = await adminA.client.from("leads").select("deals(id)").eq("converted_deal_id", deal).single();
    expect(l.error).toBeNull();
    expect(l.data!.deals).toEqual({ id: deal });
  });

  it("deleting a deal still removes its offers and clears its holds' link — the hold keeps its organisation", async () => {
    const deal = await newDeal(ORG_A);
    const offer = await newOffer(ORG_A, deal);
    const property = await newProperty(ORG_A);
    const hold = (await one<{ id: string }>(
      "insert into reservations (org_id, property_id, deal_id, expires_at) values ($1, $2, $3, now() + interval '1 day') returning id",
      [ORG_A, property, deal],
    )).id;
    await pg.query("delete from deals where id = $1", [deal]);
    expect(await count("select count(*)::int as c from offers where id = $1", [offer])).toBe(0);
    expect(await one("select deal_id, org_id::text as org from reservations where id = $1", [hold])).toEqual({ deal_id: null, org: ORG_A });
  });

  it("deleting an offer clears a hold's link to it — the hold keeps its organisation", async () => {
    const deal = await newDeal(ORG_A);
    const offer = await newOffer(ORG_A, deal);
    const property = await newProperty(ORG_A);
    const hold = (await one<{ id: string }>(
      "insert into reservations (org_id, property_id, offer_id, expires_at) values ($1, $2, $3, now() + interval '1 day') returning id",
      [ORG_A, property, offer],
    )).id;
    await pg.query("delete from offers where id = $1", [offer]);
    expect(await one("select offer_id, org_id::text as org from reservations where id = $1", [hold])).toEqual({ offer_id: null, org: ORG_A });
  });
});
