import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEAL_EXPORT_SELECT } from "@/lib/services/deal-export";
import { PROPERTY_EXPORT_BASE_SELECT } from "@/lib/services/property-export";
import { mandateEmbed, parsePropertyFilters } from "@/lib/queries/properties-list";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * The exports' contact embeds resolve against the live schema — before AND
 * after migration 0139 (T-contact-links-org-isolation, release 1 of 2).
 *
 * The deals and properties CSV exports embed their parties with a PostgREST
 * hint, because each table has two links onto contacts. They hinted by COLUMN
 * (`contacts!buyer_contact_id`), and a column hint answers PGRST200 once its
 * key is composite (measured on 0123 / 0126's keys) — 0139 makes all ten
 * links onto contacts `(org_id, <col>) → contacts (org_id, id)`, so the
 * exports would have 500ed the moment it applied. They now hint by CONSTRAINT
 * NAME, and 0139 keeps every name, so the same strings resolve on both sides.
 * Nothing else would catch a regression: the routes cast the rows
 * `as unknown as`, so no type check sees an unresolved hint.
 *
 * This file runs at 0138 in release 1's CI and, unchanged, at 0139 in the
 * migration's: that second run is the proof the release order is safe.
 */

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);

let svc: SupabaseClient;
let o: Client;
let admin: TestUser;
const userIds: string[] = [];

const ids = { buyer: "", seller: "", owner: "", developer: "", deal: "", property: "" };

async function contact(first: string, last: string): Promise<string> {
  const { data, error } = await svc
    .from("contacts")
    .insert({ org_id: ORG, contact_kind: "person", first_name: first, last_name: last })
    .select("id")
    .single();
  if (error) throw new Error(`contact ${first}: ${error.message}`);
  return data.id as string;
}

beforeAll(async () => {
  svc = serviceClient();
  o = new Client({ connectionString: DB_URL });
  await o.connect();
  await ensureTestOrg(svc, ORG, `contact embeds ${RUN}`, `contact-embeds-${RUN}`);
  admin = await createTestUser(svc, `ce-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);

  ids.buyer = await contact("Bella", `Buyer ${RUN}`);
  ids.seller = await contact("Sam", `Seller ${RUN}`);
  ids.owner = await contact("Olga", `Owner ${RUN}`);
  ids.developer = await contact("Dimitris", `Developer ${RUN}`);

  const { data: stage, error: stageErr } = await svc
    .from("deal_stages")
    .select("id")
    .eq("org_id", ORG)
    .eq("deal_type", "sale")
    .order("sort_order")
    .limit(1)
    .single();
  if (stageErr) throw new Error(`stage: ${stageErr.message}`);
  const { data: deal, error: dealErr } = await svc
    .from("deals")
    .insert({
      org_id: ORG,
      stage_id: stage.id,
      title: `Embed deal ${RUN}`,
      deal_type: "sale",
      buyer_contact_id: ids.buyer,
      seller_contact_id: ids.seller,
    })
    .select("id")
    .single();
  if (dealErr) throw new Error(`deal: ${dealErr.message}`);
  ids.deal = deal.id as string;

  const { data: district, error: districtErr } = await svc
    .from("districts")
    .select("id")
    .eq("org_id", ORG)
    .eq("code", "PAF")
    .single();
  if (districtErr) throw new Error(`district: ${districtErr.message}`);
  const { data: property, error: propErr } = await svc
    .from("properties")
    .insert({
      org_id: ORG,
      reference: `CE${RUN}`.slice(0, 20),
      kind: "project",
      property_type: "apartment",
      transaction_type: "sale",
      district_id: district.id,
      owner_contact_id: ids.owner,
      developer_contact_id: ids.developer,
      assigned_agent_id: admin.id,
    })
    .select("id")
    .single();
  if (propErr) throw new Error(`property: ${propErr.message}`);
  ids.property = property.id as string;
  // a mandate, so the export's inner-joined mandate embed returns the row too
  const { error: mandateErr } = await svc
    .from("mandates")
    .insert({ org_id: ORG, property_id: ids.property, type: "exclusive", owner_contact_id: ids.owner });
  if (mandateErr) throw new Error(`mandate: ${mandateErr.message}`);
});

afterAll(async () => {
  await o.query("delete from mandates where org_id = $1", [ORG]);
  await o.query("delete from deals where org_id = $1", [ORG]);
  await o.query("delete from properties where org_id = $1", [ORG]);
  await o.query("delete from contacts where org_id = $1", [ORG]);
  for (const id of userIds) {
    const { error } = await svc.auth.admin.deleteUser(id);
    if (error) console.warn(`afterAll: auth user ${id} not deleted: ${error.message}`);
  }
  await o.query("delete from profiles where org_id = $1", [ORG]);
  await o.query("delete from events where org_id = $1", [ORG]);
  await o.query("delete from events_chain_checkpoint where org_id = $1", [ORG]);
  await o.query("delete from chain_checks where org_id = $1", [ORG]);
  await o.query("delete from deal_stages where org_id = $1", [ORG]);
  await o.query("delete from districts where org_id = $1", [ORG]);
  await o.query("delete from organizations where id = $1", [ORG]);
  await o.end();
});

describe("the exports' party embeds resolve, through PostgREST, as an aal2 session", () => {
  it("lib/services/deal-export.ts: buyer and seller", async () => {
    const r = await admin.client.from("deals").select(DEAL_EXPORT_SELECT).eq("id", ids.deal).single();
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    const row = r.data as unknown as {
      buyer: { display_name: string } | null;
      seller: { display_name: string } | null;
    };
    expect(row.buyer?.display_name).toBe(`Bella Buyer ${RUN}`);
    expect(row.seller?.display_name).toBe(`Sam Seller ${RUN}`);
  });

  // exactly as app/(app)/properties/export/route.ts builds it: the base
  // select plus the mandate embed, plain or inner-joined by the filter
  for (const sp of [{}, { mandate: "active" }]) {
    const embed = mandateEmbed(parsePropertyFilters(sp));
    it(`lib/services/property-export.ts as the route builds it (${embed}): owner, developer and agent`, async () => {
      const r = await admin.client
        .from("properties")
        .select(`${PROPERTY_EXPORT_BASE_SELECT}, ${embed}`)
        .eq("id", ids.property)
        .single();
      expect(r.error, JSON.stringify(r.error)).toBeNull();
      const row = r.data as unknown as {
        owner: { display_name: string } | null;
        developer: { display_name: string } | null;
        agent: { full_name: string } | null;
      };
      expect(row.owner?.display_name).toBe(`Olga Owner ${RUN}`);
      expect(row.developer?.display_name).toBe(`Dimitris Developer ${RUN}`);
      expect(row.agent?.full_name).toBe(`Test admin ce-admin-${RUN}@test.local`);
    });
  }
});

describe("every constraint a hint names exists, on the column it is named for", () => {
  // The names the release-1 hints use, and the existing enquiry-suggestions
  // hint (`leads!leads_contact_id_fkey`). 0139 keeps each name and adds
  // org_id in FRONT of the column, so the LAST key column stays the link —
  // this holds at 0138 and at 0139 alike.
  const HINTED = [
    ["deals_buyer_contact_id_fkey", "deals", "buyer_contact_id"],
    ["deals_seller_contact_id_fkey", "deals", "seller_contact_id"],
    ["properties_owner_contact_id_fkey", "properties", "owner_contact_id"],
    ["properties_developer_contact_id_fkey", "properties", "developer_contact_id"],
    ["properties_assigned_agent_id_fkey", "properties", "assigned_agent_id"],
    ["leads_contact_id_fkey", "leads", "contact_id"],
  ] as const;
  it.each(HINTED)("%s → %s.%s", async (name, table, column) => {
    const { rows } = await o.query<{ tbl: string; col: string }>(
      `select c.conrelid::regclass::text as tbl, a.attname as col
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[array_upper(c.conkey, 1)]
        where c.contype = 'f' and c.connamespace = 'public'::regnamespace and c.conname = $1`,
      [name],
    );
    expect(rows).toEqual([{ tbl: table, col: column }]);
  });
});
