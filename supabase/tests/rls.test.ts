/**
 * RLS test suite — the 12 mandatory tests from docs/04_RLS_POLICY_MATRIX.md.
 * Requires the local Supabase stack (`supabase start`). Run: npm run test:rls
 *
 * Fixtures use a per-run suffix so reruns never collide; `supabase db reset`
 * clears accumulated test data.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ORG_A,
  ORG_B,
  anonClient,
  createTestUser,
  serviceClient,
  type TestUser,
} from "./helpers";

const run = Date.now().toString(36);
const svc = serviceClient();

let adminA: TestUser; // org A admin
let agentA1: TestUser; // org A agent (assigned)
let agentA2: TestUser; // org A agent (other)
let lmA: TestUser; // org A listing manager
let agentB: TestUser; // org B agent

let propA1: string; // property assigned to agentA1
let contactA: string;
let dealA1: string; // deal owned by agentA1
let mandateA1: string; // mandate on propA1, commission 5%
let leadUnassigned: string;
let leadOwnedByA1: string;
let viewingA1: string;
let slipA1: string;
let stageSaleNew: string;
let keyA1: string; // key on propA1
let keyMoveA1: string; // checkout movement on keyA1 (append-only, test 13)

beforeAll(async () => {
  // org B fixture
  await svc
    .from("organizations")
    .upsert({ id: ORG_B, name: "Test Org B", slug: "test-org-b" }, { onConflict: "id" });

  [adminA, agentA1, agentA2, lmA, agentB] = await Promise.all([
    createTestUser(svc, `admin-a-${run}@test.local`, "admin", ORG_A),
    createTestUser(svc, `agent-a1-${run}@test.local`, "agent", ORG_A),
    createTestUser(svc, `agent-a2-${run}@test.local`, "agent", ORG_A),
    createTestUser(svc, `lm-a-${run}@test.local`, "listing_manager", ORG_A),
    createTestUser(svc, `agent-b-${run}@test.local`, "agent", ORG_B),
  ]);

  const { data: prop, error: propErr } = await svc
    .from("properties")
    .insert({
      org_id: ORG_A,
      reference: `TEST-${run}-P1`,
      property_type: "villa",
      assigned_agent_id: agentA1.id,
      asking_price: 500000,
    })
    .select("id")
    .single();
  if (propErr) throw propErr;
  propA1 = prop.id;

  const { data: contact, error: contactErr } = await svc
    .from("contacts")
    .insert({
      org_id: ORG_A,
      first_name: "Test",
      last_name: `Buyer-${run}`,
      phone_e164: `+357991${run.slice(-5)}`,
      assigned_agent_id: agentA1.id,
      created_by: agentA1.id,
    })
    .select("id")
    .single();
  if (contactErr) throw contactErr;
  contactA = contact.id;

  const { data: stage, error: stageErr } = await svc
    .from("deal_stages")
    .select("id")
    .eq("org_id", ORG_A)
    .eq("deal_type", "sale")
    .eq("sort_order", 1)
    .single();
  if (stageErr) throw stageErr;
  stageSaleNew = stage.id;

  const { data: deal, error: dealErr } = await svc
    .from("deals")
    .insert({
      org_id: ORG_A,
      deal_type: "sale",
      stage_id: stageSaleNew,
      title: `Test deal ${run}`,
      property_id: propA1,
      buyer_contact_id: contactA,
      agent_id: agentA1.id,
      created_by: agentA1.id,
    })
    .select("id")
    .single();
  if (dealErr) throw dealErr;
  dealA1 = deal.id;

  const { data: mandate, error: mandateErr } = await svc
    .from("mandates")
    .insert({
      org_id: ORG_A,
      property_id: propA1,
      type: "exclusive",
      status: "active",
      commission_pct: 5,
      commission_notes: "secret split",
      created_by: adminA.id,
    })
    .select("id")
    .single();
  if (mandateErr) throw mandateErr;
  mandateA1 = mandate.id;

  const { data: leads, error: leadsErr } = await svc
    .from("leads")
    .insert([
      { org_id: ORG_A, source: "website", message: `unassigned ${run}` },
      {
        org_id: ORG_A,
        source: "referral",
        message: `owned ${run}`,
        assigned_agent_id: agentA1.id,
      },
    ])
    .select("id");
  if (leadsErr) throw leadsErr;
  leadUnassigned = leads[0].id;
  leadOwnedByA1 = leads[1].id;

  const { data: viewing, error: viewingErr } = await svc
    .from("viewings")
    .insert({
      org_id: ORG_A,
      property_id: propA1,
      contact_id: contactA,
      agent_id: agentA1.id,
      scheduled_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (viewingErr) throw viewingErr;
  viewingA1 = viewing.id;

  const { data: slip, error: slipErr } = await svc
    .from("viewing_slips")
    .insert({
      org_id: ORG_A,
      viewing_id: viewingA1,
      signer_name: "Test Buyer",
      signature_path: `signatures/test-${run}.png`,
      signature_sha256: "0".repeat(64),
    })
    .select("id")
    .single();
  if (slipErr) throw slipErr;
  slipA1 = slip.id;

  const { data: key, error: keyErr } = await svc
    .from("property_keys")
    .insert({ org_id: ORG_A, property_id: propA1, key_code: `K-${run}` })
    .select("id")
    .single();
  if (keyErr) throw keyErr;
  keyA1 = key.id;

  const { data: keyMove, error: keyMoveErr } = await svc
    .from("key_movements")
    .insert({
      org_id: ORG_A,
      key_id: keyA1,
      action: "checkout",
      holder_name: "Fixture Holder",
      created_by: agentA1.id,
    })
    .select("id")
    .single();
  if (keyMoveErr) throw keyMoveErr;
  keyMoveA1 = keyMove.id;

  // a few org-A events so the hash chain has content (test 12)
  for (const [type, entity] of [
    ["created", "property"],
    ["created", "contact"],
    ["created", "deal"],
  ] as const) {
    const { error } = await adminA.client.from("events").insert({
      org_id: ORG_A,
      actor_id: adminA.id,
      entity_type: entity,
      entity_id: propA1,
      event_type: type,
      payload: { run },
    });
    if (error) throw error;
  }
}, 120_000);

async function selectCount(client: SupabaseClient, table: string, idCol: string, id: string) {
  const { data, error } = await client.from(table).select(idCol).eq(idCol, id);
  if (error) return { error, count: 0 };
  return { error: null, count: data.length };
}

describe("RLS matrix — 12 mandatory tests (doc 04)", () => {
  it("1. cross-org isolation: org-B user sees zero org-A rows", async () => {
    for (const [table, id] of [
      ["properties", propA1],
      ["contacts", contactA],
      ["deals", dealA1],
    ] as const) {
      const { count, error } = await selectCount(agentB.client, table, "id", id);
      expect(error, `${table} select should not error`).toBeNull();
      expect(count, `${table} must return 0 rows cross-org`).toBe(0);
    }
    const { data: events } = await agentB.client
      .from("events")
      .select("id, org_id")
      .eq("org_id", ORG_A);
    expect(events ?? []).toHaveLength(0);
  });

  it("2. anon: denied on every table", async () => {
    const anon = anonClient();
    for (const table of ["properties", "contacts", "deals", "events", "cyprus_config"]) {
      const { error } = await anon.from(table).select("*").limit(1);
      expect(error, `anon select on ${table} must be denied`).not.toBeNull();
    }
  });

  it("3. agent updates: assigned allowed, unassigned denied", async () => {
    const denied = await agentA2.client
      .from("properties")
      .update({ internal_notes: "hacked" })
      .eq("id", propA1)
      .select("id");
    expect(denied.data ?? []).toHaveLength(0);

    const allowed = await agentA1.client
      .from("properties")
      .update({ internal_notes: "note from assigned agent" })
      .eq("id", propA1)
      .select("id");
    expect(allowed.error).toBeNull();
    expect(allowed.data).toHaveLength(1);
  });

  it("4. deals: other agent denied, admin sees all", async () => {
    const other = await selectCount(agentA2.client, "deals", "id", dealA1);
    expect(other.count).toBe(0);
    const admin = await selectCount(adminA.client, "deals", "id", dealA1);
    expect(admin.count).toBe(1);
  });

  it("5. mandates: LM sees masked commission via mandates_safe; admin sees value", async () => {
    const lmSafe = await lmA.client
      .from("mandates_safe")
      .select("id, commission_pct, commission_notes")
      .eq("id", mandateA1)
      .single();
    expect(lmSafe.error).toBeNull();
    expect(lmSafe.data?.commission_pct).toBeNull();
    expect(lmSafe.data?.commission_notes).toBeNull();

    const lmBase = await selectCount(lmA.client, "mandates", "id", mandateA1);
    expect(lmBase.count, "LM has no base-table access").toBe(0);

    const adminSafe = await adminA.client
      .from("mandates_safe")
      .select("id, commission_pct")
      .eq("id", mandateA1)
      .single();
    expect(Number(adminSafe.data?.commission_pct)).toBe(5);
  });

  it("6. events: UPDATE and DELETE denied for every role", async () => {
    for (const user of [adminA, agentA1, lmA]) {
      const upd = await user.client
        .from("events")
        .update({ event_type: "tampered" })
        .eq("org_id", ORG_A)
        .select("id");
      expect(upd.error, `${user.email} UPDATE events must fail`).not.toBeNull();

      const del = await user.client.from("events").delete().eq("org_id", ORG_A).select("id");
      expect(del.error, `${user.email} DELETE events must fail`).not.toBeNull();
    }
  });

  it("7. viewing_slips: UPDATE denied for every role", async () => {
    for (const user of [adminA, agentA1]) {
      const upd = await user.client
        .from("viewing_slips")
        .update({ signer_name: "forged" })
        .eq("id", slipA1)
        .select("id");
      expect(upd.error, `${user.email} UPDATE viewing_slips must fail`).not.toBeNull();
    }
  });

  it("8. profiles: agent cannot change own role; can change own name", async () => {
    const roleChange = await agentA1.client
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", agentA1.id)
      .select("id");
    expect(roleChange.error, "role escalation must fail").not.toBeNull();

    const nameChange = await agentA1.client
      .from("profiles")
      .update({ full_name: "Renamed Agent" })
      .eq("id", agentA1.id)
      .select("id");
    expect(nameChange.error).toBeNull();
    expect(nameChange.data).toHaveLength(1);
  });

  it("9. price_history: direct INSERT denied; property price edit creates row", async () => {
    const direct = await adminA.client.from("price_history").insert({
      org_id: ORG_A,
      property_id: propA1,
      old_price: 1,
      new_price: 2,
    });
    expect(direct.error, "direct insert must fail").not.toBeNull();

    const newPrice = 510000;
    const upd = await adminA.client
      .from("properties")
      .update({ asking_price: newPrice })
      .eq("id", propA1)
      .select("id");
    expect(upd.error).toBeNull();

    const { data: history } = await adminA.client
      .from("price_history")
      .select("old_price, new_price")
      .eq("property_id", propA1)
      .order("changed_at", { ascending: false })
      .limit(1);
    expect(history).toHaveLength(1);
    expect(Number(history![0].new_price)).toBe(newPrice);
  });

  it("10. cyprus_config: non-admin INSERT/UPDATE denied; admin update allowed", async () => {
    for (const user of [agentA1, lmA]) {
      const ins = await user.client
        .from("cyprus_config")
        .insert({ key: `test_${run}_${user.id.slice(0, 4)}`, value: {} });
      expect(ins.error, `${user.email} insert must fail`).not.toBeNull();

      const upd = await user.client
        .from("cyprus_config")
        .update({ description: "tampered" })
        .eq("key", "stamp_duty")
        .select("key");
      expect((upd.data ?? []).length === 0 || upd.error !== null).toBe(true);
    }

    const adminUpd = await adminA.client
      .from("cyprus_config")
      .update({ description: "Stamp duty on purchase contracts, capped at €20,000" })
      .eq("key", "stamp_duty")
      .select("key");
    expect(adminUpd.error).toBeNull();
    expect(adminUpd.data).toHaveLength(1);
  });

  it("11. leads: agent claims unassigned; cannot touch someone else's", async () => {
    const claim = await agentA2.client
      .from("leads")
      .update({ assigned_agent_id: agentA2.id, status: "contacted" })
      .eq("id", leadUnassigned)
      .select("id");
    expect(claim.error).toBeNull();
    expect(claim.data, "claiming an unassigned lead must succeed").toHaveLength(1);

    const steal = await agentA2.client
      .from("leads")
      .update({ assigned_agent_id: agentA2.id })
      .eq("id", leadOwnedByA1)
      .select("id");
    expect(steal.data ?? [], "reassigning someone else's lead must fail").toHaveLength(0);
  });

  it("12. verify_events_chain: true on seeded activity; false after tamper; true after restore", async () => {
    const before = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(before.error).toBeNull();
    expect(before.data, "chain must verify before tamper").toBe(true);

    // Tamper via service role (test-only; app roles cannot do this — see test 6).
    // Tamper event_type, NOT payload: jsonb numerics don't survive a JS round
    // trip byte-identically (480000.00 → 480000), which would break the chain
    // permanently on restore. Strings restore exactly.
    const { data: victim } = await svc
      .from("events")
      .select("id, event_type")
      .eq("org_id", ORG_A)
      .order("id", { ascending: true })
      .limit(1)
      .single();
    const original = victim!.event_type;
    await svc.from("events").update({ event_type: "tampered" }).eq("id", victim!.id);

    const during = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(during.data, "chain must fail after tamper").toBe(false);

    await svc.from("events").update({ event_type: original }).eq("id", victim!.id);
    const after = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(after.data, "chain must verify after restore").toBe(true);
  });

  it("13. key_movements: append-only — staff INSERT allowed, UPDATE/DELETE denied for every role", async () => {
    // positive: an agent records a movement (doc 04 insert row)
    const { error: insErr } = await agentA1.client.from("key_movements").insert({
      org_id: ORG_A,
      key_id: keyA1,
      action: "return",
      holder_name: "Fixture Holder",
      created_by: agentA1.id,
    });
    expect(insErr, "agent INSERT movement must succeed").toBeNull();

    // append-only: no role may rewrite or erase history
    for (const user of [adminA, agentA1, lmA]) {
      const upd = await user.client
        .from("key_movements")
        .update({ holder_name: "rewritten" })
        .eq("id", keyMoveA1)
        .select("id");
      expect(
        upd.error !== null || (upd.data ?? []).length === 0,
        `${user.email} UPDATE key_movements must not affect rows`,
      ).toBe(true);

      const del = await user.client
        .from("key_movements")
        .delete()
        .eq("id", keyMoveA1)
        .select("id");
      expect(
        del.error !== null || (del.data ?? []).length === 0,
        `${user.email} DELETE key_movements must not affect rows`,
      ).toBe(true);
    }

    // the fixture row is intact
    const { data: still } = await svc
      .from("key_movements")
      .select("id, holder_name")
      .eq("id", keyMoveA1)
      .single();
    expect(still?.holder_name).toBe("Fixture Holder");
  });
});
