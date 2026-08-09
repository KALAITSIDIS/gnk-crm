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
  SEEDED_ORG,
  anonClient,
  createTestUser,
  ensureTestOrg,
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
  // TEST-1: both orgs are suite-owned fixtures, seeded with the org-scoped
  // reference data the tests read. The dev app's org is never written to.
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  await ensureTestOrg(svc, ORG_B, "Test Org B", "test-org-b");

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

  it("11. leads: agent works/claims unassigned; cannot steal or hand off", async () => {
    // inbox flow: acting on an unassigned lead without claiming it must work
    const workUnclaimed = await agentA2.client
      .from("leads")
      .update({ status: "contacted" })
      .eq("id", leadUnassigned)
      .select("id");
    expect(workUnclaimed.error).toBeNull();
    expect(workUnclaimed.data, "updating an unassigned lead without claiming must succeed")
      .toHaveLength(1);

    const claim = await agentA2.client
      .from("leads")
      .update({ assigned_agent_id: agentA2.id, status: "contacted" })
      .eq("id", leadUnassigned)
      .select("id");
    expect(claim.error).toBeNull();
    expect(claim.data, "claiming an unassigned lead must succeed").toHaveLength(1);

    // 0009: WITH CHECK — an agent may never hand their lead to a third party
    const handoff = await agentA2.client
      .from("leads")
      .update({ assigned_agent_id: agentA1.id })
      .eq("id", leadUnassigned)
      .select("id");
    expect(handoff.error, "handing own lead to another agent must fail").not.toBeNull();

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

  it("14. deals: agent cannot hand a deal fully away; creator may change its agent", async () => {
    // 0009: WITH CHECK — the new row must keep at least one ownership anchor
    const handoff = await agentA1.client
      .from("deals")
      .update({ agent_id: agentA2.id, created_by: agentA2.id })
      .eq("id", dealA1)
      .select("id");
    expect(handoff.error, "handing a deal fully away must fail").not.toBeNull();

    // doc 04: own = agent_id OR created_by — the creator keeps an anchor,
    // so changing the working agent on a deal they created is allowed
    const reassign = await agentA1.client
      .from("deals")
      .update({ agent_id: agentA2.id })
      .eq("id", dealA1)
      .select("id");
    expect(reassign.error).toBeNull();
    expect(reassign.data).toHaveLength(1);

    // restore fixture state
    const restore = await agentA1.client
      .from("deals")
      .update({ agent_id: agentA1.id })
      .eq("id", dealA1)
      .select("id");
    expect(restore.error).toBeNull();
    expect(restore.data).toHaveLength(1);
  });

  it("15. move_deal_to_stage RPC: owner moves atomically; blocked callers write no phantom event", async () => {
    const { data: stage2, error: stage2Err } = await svc
      .from("deal_stages")
      .select("id, name")
      .eq("org_id", ORG_A)
      .eq("deal_type", "sale")
      .eq("sort_order", 2)
      .single();
    if (stage2Err) throw stage2Err;

    const stageChangedCount = async () => {
      const { count, error } = await svc
        .from("events")
        .select("id", { count: "exact", head: true })
        .eq("entity_type", "deal")
        .eq("entity_id", dealA1)
        .eq("event_type", "stage_changed");
      if (error) throw error;
      return count ?? 0;
    };
    const before = await stageChangedCount();

    // listing manager: sees all org deals but may update none — the RPC must
    // abort (0-row RLS-filtered UPDATE), leave the deal in place, and above
    // all write NO stage_changed event (0011: evidence-log integrity)
    const lmMove = await lmA.client.rpc("move_deal_to_stage", {
      p_deal_id: dealA1,
      p_stage_id: stage2.id,
    });
    expect(lmMove.error, "listing manager move must fail").not.toBeNull();

    // other agent: cannot even see the deal — RPC reports it as not found
    const otherMove = await agentA2.client.rpc("move_deal_to_stage", {
      p_deal_id: dealA1,
      p_stage_id: stage2.id,
    });
    expect(otherMove.error, "other agent move must fail").not.toBeNull();

    const { data: unmoved } = await svc
      .from("deals")
      .select("stage_id")
      .eq("id", dealA1)
      .single();
    expect(unmoved?.stage_id, "blocked moves must not change the stage").toBe(stageSaleNew);
    expect(await stageChangedCount(), "blocked moves must write no event").toBe(before);

    // owning agent: move succeeds, stage tenure restarts, and the
    // stage_changed event lands in the same transaction with the right actor
    const t0 = new Date().toISOString();
    const ownerMove = await agentA1.client.rpc("move_deal_to_stage", {
      p_deal_id: dealA1,
      p_stage_id: stage2.id,
    });
    expect(ownerMove.error).toBeNull();

    const { data: moved } = await svc
      .from("deals")
      .select("stage_id, stage_entered_at")
      .eq("id", dealA1)
      .single();
    expect(moved?.stage_id).toBe(stage2.id);
    expect(moved && moved.stage_entered_at >= t0, "stage_entered_at must restart").toBe(true);
    expect(await stageChangedCount()).toBe(before + 1);

    const { data: lastEvent } = await svc
      .from("events")
      .select("actor_id, payload")
      .eq("entity_type", "deal")
      .eq("entity_id", dealA1)
      .eq("event_type", "stage_changed")
      .order("id", { ascending: false })
      .limit(1)
      .single();
    expect(lastEvent?.actor_id).toBe(agentA1.id);
    expect((lastEvent?.payload as { to?: string })?.to).toBe(stage2.name);

    // won/lost columns stay behind the guarded flows
    const { data: wonStage } = await svc
      .from("deal_stages")
      .select("id")
      .eq("org_id", ORG_A)
      .eq("deal_type", "sale")
      .eq("is_won", true)
      .single();
    if (wonStage) {
      const wonMove = await agentA1.client.rpc("move_deal_to_stage", {
        p_deal_id: dealA1,
        p_stage_id: wonStage.id,
      });
      expect(wonMove.error, "dragging into a won column must fail").not.toBeNull();
      expect(wonMove.error?.message).toContain("guarded flow");
    }

    // restore fixture state
    const restore = await agentA1.client.rpc("move_deal_to_stage", {
      p_deal_id: dealA1,
      p_stage_id: stageSaleNew,
    });
    expect(restore.error).toBeNull();
  });

  it("16. contacts updates: owner agent allowed; other agent, LM denied; admin allowed", async () => {
    // agentA1 owns contactA (assigned + created) — update passes
    const owner = await agentA1.client
      .from("contacts")
      .update({ notes: `owner note ${run}` })
      .eq("id", contactA)
      .select("id");
    expect(owner.error).toBeNull();
    expect(owner.data).toHaveLength(1);

    // another agent is silently filtered to 0 rows (doc 04: own/created only)
    const otherAgent = await agentA2.client
      .from("contacts")
      .update({ notes: "stolen note" })
      .eq("id", contactA)
      .select("id");
    expect(otherAgent.data ?? []).toHaveLength(0);

    // listing managers have no contacts UPDATE policy at all
    const lm = await lmA.client
      .from("contacts")
      .update({ notes: "lm note" })
      .eq("id", contactA)
      .select("id");
    expect(lm.data ?? []).toHaveLength(0);

    // admin updates any org contact
    const admin = await adminA.client
      .from("contacts")
      .update({ notes: `admin note ${run}` })
      .eq("id", contactA)
      .select("id");
    expect(admin.error).toBeNull();
    expect(admin.data).toHaveLength(1);

    // the silent no-op is why the app checks row counts before logging events
    const { data: after } = await svc.from("contacts").select("notes").eq("id", contactA).single();
    expect(after?.notes).toBe(`admin note ${run}`);
  });

  it("17. tasks: assignee/creator see; only assignee or admin toggle; creator or admin delete", async () => {
    // t1: admin-created, assigned to agentA1
    const { data: t1, error: t1Err } = await svc
      .from("tasks")
      .insert({
        org_id: ORG_A,
        title: `Task admin→A1 ${run}`,
        assignee_id: agentA1.id,
        created_by: adminA.id,
      })
      .select("id")
      .single();
    expect(t1Err).toBeNull();

    // t2: agentA2-created, assigned to agentA1 (creator ≠ assignee)
    const { data: t2, error: t2Err } = await svc
      .from("tasks")
      .insert({
        org_id: ORG_A,
        title: `Task A2→A1 ${run}`,
        assignee_id: agentA1.id,
        created_by: agentA2.id,
      })
      .select("id")
      .single();
    expect(t2Err).toBeNull();

    // SELECT: assignee and creator see a task; unrelated org member and org B don't
    expect((await selectCount(agentA1.client, "tasks", "id", t1!.id)).count).toBe(1);
    expect((await selectCount(agentA2.client, "tasks", "id", t1!.id)).count).toBe(0);
    expect((await selectCount(agentA2.client, "tasks", "id", t2!.id)).count).toBe(1);
    expect((await selectCount(agentB.client, "tasks", "id", t1!.id)).count).toBe(0);

    // UPDATE: the creator can SEE t2 but is silently filtered to 0 rows —
    // exactly the hole toggleTaskDone row-guards against logging events for
    const creator = await agentA2.client
      .from("tasks")
      .update({ is_done: true })
      .eq("id", t2!.id)
      .select("id");
    expect(creator.data ?? []).toHaveLength(0);

    // …the assignee toggles fine, and admin toggles anyone's
    const assignee = await agentA1.client
      .from("tasks")
      .update({ is_done: true, done_at: new Date().toISOString() })
      .eq("id", t2!.id)
      .select("id");
    expect(assignee.error).toBeNull();
    expect(assignee.data).toHaveLength(1);
    const admin = await adminA.client
      .from("tasks")
      .update({ is_done: true, done_at: new Date().toISOString() })
      .eq("id", t1!.id)
      .select("id");
    expect(admin.error).toBeNull();
    expect(admin.data).toHaveLength(1);

    // DELETE: assignee-but-not-creator filtered; creator allowed; admin allowed
    const delAssignee = await agentA1.client.from("tasks").delete().eq("id", t2!.id).select("id");
    expect(delAssignee.data ?? []).toHaveLength(0);
    const delCreator = await agentA2.client.from("tasks").delete().eq("id", t2!.id).select("id");
    expect(delCreator.error).toBeNull();
    expect(delCreator.data).toHaveLength(1);
    const delAdmin = await adminA.client.from("tasks").delete().eq("id", t1!.id).select("id");
    expect(delAdmin.error).toBeNull();
    expect(delAdmin.data).toHaveLength(1);

    // INSERT: listing managers may create tasks (doc 04: A AG LM)
    const lmIns = await lmA.client
      .from("tasks")
      .insert({ org_id: ORG_A, title: `LM task ${run}`, assignee_id: lmA.id, created_by: lmA.id })
      .select("id")
      .single();
    expect(lmIns.error).toBeNull();

    // System tasks (`created_by` null) — the shape both cron jobs write. The
    // doc 04 row is `(assignee_id = uid OR created_by = uid)`, so a nudge is
    // reachable ONLY through its assignee: that is exactly why 0012 grew a
    // three-arm fallback and why a NULL assignee would be invisible to everyone.
    const { data: sys, error: sysErr } = await svc
      .from("tasks")
      .insert({
        org_id: ORG_A,
        title: `No contact in 14 days: fixture ${run}`,
        assignee_id: agentA1.id,
        created_by: null,
        deal_id: dealA1,
        kind: "deal_no_contact",
      })
      .select("id")
      .single();
    expect(sysErr).toBeNull();

    expect((await selectCount(agentA1.client, "tasks", "id", sys!.id)).count).toBe(1);
    expect((await selectCount(agentA2.client, "tasks", "id", sys!.id)).count).toBe(0);
    expect((await selectCount(agentB.client, "tasks", "id", sys!.id)).count).toBe(0);

    // the assignee completes it like any other task
    const sysToggle = await agentA1.client
      .from("tasks")
      .update({ is_done: true, done_at: new Date().toISOString() })
      .eq("id", sys!.id)
      .select("id");
    expect(sysToggle.error).toBeNull();
    expect(sysToggle.data).toHaveLength(1);

    // DELETE is `creator or admin`, and a system task HAS no creator — so the
    // assignee cannot delete it and only an admin can.
    const sysDelAssignee = await agentA1.client
      .from("tasks")
      .delete()
      .eq("id", sys!.id)
      .select("id");
    expect(sysDelAssignee.data ?? []).toHaveLength(0);
    const sysDelAdmin = await adminA.client.from("tasks").delete().eq("id", sys!.id).select("id");
    expect(sysDelAdmin.error).toBeNull();
    expect(sysDelAdmin.data).toHaveLength(1);

    // the CHECK constraint keeps `kind` a closed set — a typo in a future cron
    // fails loudly instead of minting tasks no surface recognises as nudges
    const badKind = await svc
      .from("tasks")
      .insert({ org_id: ORG_A, title: `bad kind ${run}`, assignee_id: agentA1.id, kind: "typo" })
      .select("id");
    expect(badKind.error).not.toBeNull();
  });

  it("18. property_keys: register/edit is admin+LM only; record_key_movement guards transitions", async () => {
    // INSERT (register): agents are denied by policy, LM allowed (doc 04)
    const agentIns = await agentA1.client
      .from("property_keys")
      .insert({ org_id: ORG_A, property_id: propA1, key_code: `K18-${run}` })
      .select("id")
      .single();
    expect(agentIns.error, "agent register must be denied").not.toBeNull();

    const lmIns = await lmA.client
      .from("property_keys")
      .insert({ org_id: ORG_A, property_id: propA1, key_code: `K18-${run}` })
      .select("id")
      .single();
    expect(lmIns.error, "LM register must succeed").toBeNull();
    const keyLM = lmIns.data!.id;

    // duplicate code: unique (org_id, key_code) — 0013
    const dup = await lmA.client
      .from("property_keys")
      .insert({ org_id: ORG_A, property_id: propA1, key_code: `K18-${run}` })
      .select("id")
      .single();
    expect(dup.error?.code, "duplicate key code must hit the unique index").toBe("23505");

    // UPDATE (keys meta): agent silently filtered to 0 rows, LM edits fine
    const agentUpd = await agentA1.client
      .from("property_keys")
      .update({ description: "agent rewrite" })
      .eq("id", keyLM)
      .select("id");
    expect(agentUpd.data ?? []).toHaveLength(0);
    const lmUpd = await lmA.client
      .from("property_keys")
      .update({ description: "front door" })
      .eq("id", keyLM)
      .select("id");
    expect(lmUpd.error).toBeNull();
    expect(lmUpd.data).toHaveLength(1);

    // cross-org blindness
    expect((await selectCount(agentB.client, "property_keys", "id", keyLM)).count).toBe(0);

    const keyEventCount = async () => {
      const { count, error } = await svc
        .from("events")
        .select("id", { count: "exact", head: true })
        .eq("entity_type", "key")
        .eq("entity_id", keyLM);
      if (error) throw error;
      return count ?? 0;
    };
    const movementCount = async () => {
      const { count, error } = await svc
        .from("key_movements")
        .select("id", { count: "exact", head: true })
        .eq("key_id", keyLM);
      if (error) throw error;
      return count ?? 0;
    };

    // RPC: org-B caller cannot even find the key
    const crossMove = await agentB.client.rpc("record_key_movement", {
      p_key_id: keyLM,
      p_action: "checkout",
      p_holder_name: "Org B Thief",
    });
    expect(crossMove.error, "cross-org movement must fail").not.toBeNull();
    expect(await movementCount(), "failed movement must write no rows").toBe(0);

    // agent checkout: movement + cache + event land together
    const checkout = await agentA1.client.rpc("record_key_movement", {
      p_key_id: keyLM,
      p_action: "checkout",
      p_holder_name: "RLS Holder",
    });
    expect(checkout.error).toBeNull();
    const { data: afterCheckout } = await svc
      .from("property_keys")
      .select("status, current_holder_name")
      .eq("id", keyLM)
      .single();
    expect(afterCheckout?.status).toBe("checked_out");
    expect(afterCheckout?.current_holder_name).toBe("RLS Holder");
    expect(await movementCount()).toBe(1);
    expect(await keyEventCount()).toBe(1);

    // double checkout: status guard aborts, nothing extra is logged
    const doubleOut = await agentA1.client.rpc("record_key_movement", {
      p_key_id: keyLM,
      p_action: "checkout",
      p_holder_name: "Second Holder",
    });
    expect(doubleOut.error?.message).toContain("return it first");
    expect(await movementCount(), "aborted checkout must write no movement").toBe(1);
    expect(await keyEventCount(), "aborted checkout must write no event").toBe(1);

    // any staff role may move keys: LM returns it, holder cache clears
    const ret = await lmA.client.rpc("record_key_movement", { p_key_id: keyLM, p_action: "return" });
    expect(ret.error).toBeNull();
    const { data: afterReturn } = await svc
      .from("property_keys")
      .select("status, current_holder_name")
      .eq("id", keyLM)
      .single();
    expect(afterReturn?.status).toBe("in_office");
    expect(afterReturn?.current_holder_name).toBeNull();

    // lost lifecycle: mark_lost blocks checkout until return recovers it
    const lost = await adminA.client.rpc("record_key_movement", {
      p_key_id: keyLM,
      p_action: "mark_lost",
    });
    expect(lost.error).toBeNull();
    const lostOut = await agentA1.client.rpc("record_key_movement", {
      p_key_id: keyLM,
      p_action: "checkout",
      p_holder_name: "Hopeful Holder",
    });
    expect(lostOut.error?.message).toContain("return it first");
    const recover = await adminA.client.rpc("record_key_movement", {
      p_key_id: keyLM,
      p_action: "return",
    });
    expect(recover.error).toBeNull();
    const { data: recovered } = await svc
      .from("property_keys")
      .select("status")
      .eq("id", keyLM)
      .single();
    expect(recovered?.status).toBe("in_office");
    expect(await movementCount()).toBe(4);
    expect(await keyEventCount()).toBe(4);

    // tidy the register fixture (movements cascade; events are append-only)
    await svc.from("property_keys").delete().eq("id", keyLM);
  });

  it("19. is_active: deactivating a profile kills a LIVE session's RLS access instantly", async () => {
    // fresh fixture user so the flag flip cannot disturb other tests
    const ghost = await createTestUser(svc, `ghost-a-${run}@test.local`, "agent", ORG_A);

    // sanity: the live session sees org data and its own profile
    const before = await ghost.client.from("properties").select("id").limit(1);
    expect(before.error).toBeNull();
    expect((before.data ?? []).length).toBeGreaterThan(0);

    // deactivate — NO ban, NO sign-out: the JWT stays perfectly valid. 0014's
    // helper gate is the only thing standing between this token and the org.
    const off = await svc.from("profiles").update({ is_active: false }).eq("id", ghost.id);
    expect(off.error).toBeNull();

    // every read dies (helpers return NULL → org predicate false everywhere)
    const props = await ghost.client.from("properties").select("id").limit(1);
    expect(props.data ?? []).toHaveLength(0);
    const ownProfile = await ghost.client.from("profiles").select("id").eq("id", ghost.id);
    expect(ownProfile.data ?? [], "even the own profile row goes dark").toHaveLength(0);

    // writes die silently (0 rows) or loudly (WITH CHECK) — never land
    const upd = await ghost.client
      .from("profiles")
      .update({ full_name: "Still Here" })
      .eq("id", ghost.id)
      .select("id");
    expect(upd.data ?? []).toHaveLength(0);
    const evt = await ghost.client
      .from("events")
      .insert({ org_id: ORG_A, entity_type: "config", event_type: "smuggled", payload: {} });
    expect(evt.error, "deactivated user must not write events").not.toBeNull();

    // reactivation restores access just as instantly (STABLE fns, no caching)
    const on = await svc.from("profiles").update({ is_active: true }).eq("id", ghost.id);
    expect(on.error).toBeNull();
    const after = await ghost.client.from("properties").select("id").limit(1);
    expect(after.error).toBeNull();
    expect((after.data ?? []).length).toBeGreaterThan(0);
  });

  it("20. stage RPCs: admin adds/reorders atomically; non-admin blocked with no phantom event", async () => {
    // operate on 'advisory' so the seeded sale stages other tests rely on stay put
    const stagesEventCount = async () => {
      const { count, error } = await svc
        .from("events")
        .select("id", { count: "exact", head: true })
        .eq("entity_type", "config")
        .eq("event_type", "stages_updated");
      if (error) throw error;
      return count ?? 0;
    };
    const advisoryStages = async () => {
      const { data, error } = await svc
        .from("deal_stages")
        .select("id, name, sort_order, is_won, is_lost")
        .eq("org_id", ORG_A)
        .eq("deal_type", "advisory")
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return data ?? [];
    };

    const before = await stagesEventCount();

    // agent add: clean refusal, nothing inserted, no event
    const agentAdd = await agentA1.client.rpc("add_deal_stage", {
      p_deal_type: "advisory",
      p_name: `Agent Smuggle ${run}`,
    });
    expect(agentAdd.error?.message).toContain("Admins only");
    expect(await stagesEventCount(), "blocked add must write no event").toBe(before);

    // admin add: lands BEFORE the terminal won/lost stages, event in-transaction
    const stageName = `RLS Stage ${run}`;
    const adminAdd = await adminA.client.rpc("add_deal_stage", {
      p_deal_type: "advisory",
      p_name: stageName,
    });
    expect(adminAdd.error).toBeNull();
    const newId = adminAdd.data as string;
    let stages = await advisoryStages();
    const added = stages.find((s) => s.id === newId);
    expect(added, "new stage must exist").toBeTruthy();
    for (const t of stages.filter((s) => s.is_won || s.is_lost)) {
      expect(t.sort_order, "terminal stages must stay last").toBeGreaterThan(added!.sort_order);
    }
    expect(await stagesEventCount()).toBe(before + 1);

    // duplicate name (case-insensitive): refused
    const dup = await adminA.client.rpc("add_deal_stage", {
      p_deal_type: "advisory",
      p_name: stageName.toUpperCase(),
    });
    expect(dup.error?.message).toContain("already exists");

    // agent reorder: clean refusal, order unchanged, no event
    const orderBefore = (await advisoryStages()).map((s) => s.id);
    const agentMove = await agentA1.client.rpc("reorder_stage", {
      p_stage_id: newId,
      p_direction: "up",
    });
    expect(agentMove.error?.message).toContain("Admins only");
    expect((await advisoryStages()).map((s) => s.id)).toEqual(orderBefore);
    expect(await stagesEventCount()).toBe(before + 1);

    // admin reorder: swaps with the previous non-terminal neighbour + event;
    // no stage is ever left parked at the -1 slot
    const adminMove = await adminA.client.rpc("reorder_stage", {
      p_stage_id: newId,
      p_direction: "up",
    });
    expect(adminMove.error).toBeNull();
    stages = await advisoryStages();
    const movable = stages.filter((s) => !s.is_won && !s.is_lost);
    expect(movable.at(-2)?.id, "stage must have moved up one slot").toBe(newId);
    expect(stages.every((s) => s.sort_order >= 0), "no stage parked at -1").toBe(true);
    expect(await stagesEventCount()).toBe(before + 2);

    // moving the top stage further up is a no-op edge, not an error
    let guard = 0;
    while (movable[0]!.id !== newId && guard++ < 10) {
      const step = await adminA.client.rpc("reorder_stage", {
        p_stage_id: newId,
        p_direction: "up",
      });
      expect(step.error).toBeNull();
      const again = await advisoryStages();
      movable.splice(0, movable.length, ...again.filter((s) => !s.is_won && !s.is_lost));
    }
    const edge = await adminA.client.rpc("reorder_stage", { p_stage_id: newId, p_direction: "up" });
    expect(edge.error, "edge move must be a silent no-op").toBeNull();

    // tidy: push the fixture stage back down to the bottom, then delete it
    // (unreferenced, so the delete-if-unreferenced policy allows it)
    guard = 0;
    while (guard++ < 10) {
      const again = await advisoryStages();
      const mv = again.filter((s) => !s.is_won && !s.is_lost);
      if (mv.at(-1)?.id === newId) break;
      const step = await adminA.client.rpc("reorder_stage", {
        p_stage_id: newId,
        p_direction: "down",
      });
      expect(step.error).toBeNull();
    }
    const del = await adminA.client.from("deal_stages").delete({ count: "exact" }).eq("id", newId);
    expect(del.error).toBeNull();
    expect(del.count).toBe(1);
  });

  it("21. chain_checks: org-scoped read for staff; writes denied for every app role", async () => {
    /**
     * TEST-2 (migration 0019). 0016 revoked EXECUTE `from public`, which — per
     * the 0010 lesson — also stripped service_role, because a function's
     * service_role EXECUTE rides on the PUBLIC default grant. The function was
     * left callable by NO role. 0019 restored service_role; anon and
     * authenticated stay revoked on purpose, since the RPC walks every event
     * in the org and must not be triggerable from a browser session.
     *
     * The original version of this test called the RPC and IGNORED the error,
     * so it passed on rows 0016 had seeded at migration time and hid the
     * regression completely. It now asserts the call SUCCEEDS.
     */
    const rpcAsService = await svc.rpc("run_chain_checks");
    expect(
      rpcAsService.error,
      "service_role must be able to refresh the chain cache on demand (0019)",
    ).toBeNull();

    for (const u of [adminA, agentA1, lmA]) {
      const { data, error } = await u.client.from("chain_checks").select("org_id, checked_at, ok");
      expect(error).toBeNull();
      expect(data, "staff must see exactly their org's row").toHaveLength(1);
      expect(data![0].org_id).toBe(ORG_A);
      expect(data![0].ok, "seeded chain must verify").toBe(true);
    }

    // cross-org blind
    const { data: bRows } = await agentB.client.from("chain_checks").select("org_id");
    expect((bRows ?? []).map((r) => r.org_id)).not.toContain(ORG_A);

    // writes: no policies + revoked grants — every mutation must fail or hit 0 rows
    const ins = await adminA.client
      .from("chain_checks")
      .insert({ org_id: ORG_A, checked_at: new Date().toISOString(), ok: false });
    expect(ins.error, "admin INSERT must fail").not.toBeNull();
    const upd = await adminA.client
      .from("chain_checks")
      .update({ ok: false })
      .eq("org_id", ORG_A)
      .select("org_id");
    expect(upd.data ?? [], "admin UPDATE must not change the cache").toHaveLength(0);
    const delChk = await adminA.client
      .from("chain_checks")
      .delete({ count: "exact" })
      .eq("org_id", ORG_A);
    expect(delChk.count ?? 0, "admin DELETE must remove nothing").toBe(0);

    // the RPC stays service/cron-only: it walks every event in the org, so no
    // browser session may trigger it (0019 restored service_role ONLY)
    const rpc = await adminA.client.rpc("run_chain_checks");
    expect(rpc.error, "run_chain_checks must be revoked from authenticated").not.toBeNull();
    const rpcAnon = await anonClient().rpc("run_chain_checks");
    expect(rpcAnon.error, "run_chain_checks must be revoked from anon").not.toBeNull();
  });

  it("22. admin_dashboard_stats: SECURITY INVOKER — org-scoped, exact, anon denied", async () => {
    // PERF-3 (migration 0018). The dashboard used to sum money in TS over
    // .limit(2000) fetches, so the € tiles silently undercounted past the cap.
    // This RPC does the group-bys in SQL and MUST stay under the caller's RLS.
    const args = {
      p_month_start: new Date(Date.now() - 365 * 86_400_000).toISOString(),
      p_d7: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      p_d30: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    };

    // anon must never reach org aggregates
    const anonRes = await anonClient().rpc("admin_dashboard_stats", args);
    expect(anonRes.error, "anon must not execute admin_dashboard_stats").not.toBeNull();

    const { data: statsA, error: errA } = await adminA.client.rpc("admin_dashboard_stats", args);
    expect(errA).toBeNull();
    expect(statsA).toBeTruthy();

    // RECONCILIATION: the aggregate must equal the row-level query it replaced.
    // This is the assertion that would have caught the original defect.
    const { data: openRows } = await adminA.client
      .from("deals")
      .select("expected_value")
      .eq("status", "open");
    const expectedTotal = (openRows ?? []).reduce(
      (s, d) => s + Number(d.expected_value ?? 0),
      0,
    );
    expect(
      Number(statsA.open_pipeline.total),
      "RPC open-pipeline sum must equal the sum of the rows RLS shows the caller",
    ).toBeCloseTo(expectedTotal, 2);
    expect(Number(statsA.open_pipeline.count)).toBe((openRows ?? []).length);

    // per-stage totals must add up to the headline figure
    const stageSum = (statsA.stages as { total: number }[]).reduce(
      (s, r) => s + Number(r.total),
      0,
    );
    expect(stageSum, "stage breakdown must reconcile with the KPI").toBeCloseTo(
      Number(statsA.open_pipeline.total),
      2,
    );

    // ORG ISOLATION: org B's agent runs the same RPC and must not see org A's
    // money. Comparing against B's own row-level query keeps this true even if
    // the fixture org later grows deals of its own.
    const { data: statsB, error: errB } = await agentB.client.rpc(
      "admin_dashboard_stats",
      args,
    );
    expect(errB).toBeNull();
    const { data: openRowsB } = await agentB.client
      .from("deals")
      .select("expected_value")
      .eq("status", "open");
    const expectedTotalB = (openRowsB ?? []).reduce(
      (s, d) => s + Number(d.expected_value ?? 0),
      0,
    );
    expect(
      Number(statsB.open_pipeline.total),
      "org B must only aggregate org B rows",
    ).toBeCloseTo(expectedTotalB, 2);
    // Org B owns no deals, so its aggregate must be empty. Asserting "B differs
    // from A" would be vacuous whenever both happen to be zero, which is why
    // this pins the absolute expectation instead.
    expect(
      (openRowsB ?? []).length,
      "fixture drift: org B should own no deals, so this assertion is meaningful",
    ).toBe(0);
    expect(
      Number(statsB.open_pipeline.count),
      "SECURITY INVOKER regression: org B is counting another org's deals",
    ).toBe(0);
    expect(
      Number(statsA.open_pipeline.count),
      "org A must see its own fixture deals",
    ).toBeGreaterThan(0);

    // shape contract the dashboard relies on
    for (const key of [
      "open_pipeline",
      "won_month",
      "stages",
      "leads7",
      "lead_sources30",
      "property_statuses",
      "top_actors30",
    ]) {
      expect(statsA, `missing ${key}`).toHaveProperty(key);
    }
    expect(Array.isArray(statsA.top_actors30)).toBe(true);
    expect(
      (statsA.top_actors30 as unknown[]).length,
      "top agents is capped at 5",
    ).toBeLessThanOrEqual(5);
  });

  it("23. TEST-1: the suite never writes into the seeded org the dev app uses", async () => {
    // The fixtures cannot be deleted afterwards -- `events` is append-only and
    // RLS denies DELETE on the business tables (guardrail 1) -- so the only
    // way to keep the dev database clean is never to dirty it. This test is
    // the guard: if someone points a fixture back at the seeded org, it fails
    // here rather than silently polluting the dev dashboard again.
    expect(ORG_A, "test org A must not be the seeded org").not.toBe(SEEDED_ORG);
    expect(ORG_B, "test org B must not be the seeded org").not.toBe(SEEDED_ORG);

    // No profile from THIS RUN may live in the seeded org.
    //
    // Scoped to `run` on purpose: earlier runs (before this fix) left ~120
    // `…@test.local` profiles in the seeded org and they cannot be removed —
    // `events` references them and is append-only. Asserting on the historical
    // total would fail forever and teach everyone to ignore this test. A
    // `supabase db reset` is the only way to clear the old ones.
    const { data: strays, error } = await svc
      .from("profiles")
      .select("email")
      .eq("org_id", SEEDED_ORG)
      .like("email", `%${run}%`);
    expect(error).toBeNull();
    expect(
      strays ?? [],
      "this run created profiles in the seeded org — a fixture is pointing at SEEDED_ORG",
    ).toEqual([]);

    // Nor may this run's fixtures have landed there.
    for (const table of ["properties", "contacts", "deals"] as const) {
      const { data: rows } = await svc
        .from(table)
        .select("id")
        .eq("org_id", SEEDED_ORG)
        .ilike(table === "deals" ? "title" : table === "contacts" ? "last_name" : "reference", `%${run}%`);
      expect(rows ?? [], `${table}: this run's fixtures leaked into the seeded org`).toEqual([]);
    }
  });

  it("24. create_followup_nudges: cycle-keyed, EOD-stamped, never orphaned, self-healing", async () => {
    const dayMs = 86_400_000;
    const iso = (ms: number) => new Date(Date.now() - ms).toISOString();

    // The job is org-wide by default; p_org keeps this test off every other
    // org, including the seeded one test 23 protects.
    const seededBefore = await svc
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", SEEDED_ORG)
      .in("kind", ["deal_no_contact", "viewing_feedback"]);

    // stale: silent 20 days, has an agent.  orphan: silent 20 days, no agent
    // and no creator — the shape that produced NULL-assignee tasks before 0012.
    // fresh: touched just now, must NOT be nudged.
    const { data: deals, error: dealsErr } = await svc
      .from("deals")
      .insert([
        {
          org_id: ORG_A,
          deal_type: "sale",
          stage_id: stageSaleNew,
          title: `Nudge stale ${run}`,
          agent_id: agentA1.id,
          created_by: agentA1.id,
          // 0025: silence is measured by last_contact_at, not last_activity_at.
          // Both are set so the fixture is unambiguous under either reading.
          last_contact_at: iso(20 * dayMs),
          last_activity_at: iso(20 * dayMs),
        },
        {
          org_id: ORG_A,
          deal_type: "sale",
          stage_id: stageSaleNew,
          title: `Nudge orphan ${run}`,
          agent_id: null,
          created_by: null,
          last_contact_at: iso(20 * dayMs),
          last_activity_at: iso(20 * dayMs),
        },
        {
          org_id: ORG_A,
          deal_type: "sale",
          stage_id: stageSaleNew,
          title: `Nudge fresh ${run}`,
          agent_id: agentA1.id,
          created_by: agentA1.id,
          // explicit, not omitted: a PostgREST bulk insert unions the keys, so
          // a column left off ONE row is sent as null rather than defaulted
          last_contact_at: new Date().toISOString(),
          last_activity_at: new Date().toISOString(),
        },
      ])
      .select("id, last_contact_at");
    expect(dealsErr).toBeNull();
    const [staleDeal, orphanDeal, freshDeal] = deals!;

    // 49h ago needs a nudge; 47h ago does not (the 48-hour threshold).
    const { data: viewings, error: viewErr } = await svc
      .from("viewings")
      .insert([
        {
          org_id: ORG_A,
          property_id: propA1,
          contact_id: contactA,
          agent_id: agentA1.id,
          scheduled_at: iso(49 * 3_600_000),
          status: "completed",
        },
        {
          org_id: ORG_A,
          property_id: propA1,
          contact_id: contactA,
          agent_id: agentA1.id,
          scheduled_at: iso(47 * 3_600_000),
          status: "completed",
        },
      ])
      .select("id");
    expect(viewErr).toBeNull();
    const [lateViewing, recentViewing] = viewings!;

    // --- the job is not callable by any app role -----------------------------
    expect((await anonClient().rpc("create_followup_nudges", { p_org: ORG_A })).error).not.toBeNull();
    expect(
      (await agentA1.client.rpc("create_followup_nudges", { p_org: ORG_A })).error,
    ).not.toBeNull();

    const nudges = async (col: "deal_id" | "viewing_id", id: string) => {
      const { data, error } = await svc
        .from("tasks")
        .select("id, due_at, assignee_id, is_done, kind")
        .eq(col, id)
        .not("kind", "is", null);
      expect(error).toBeNull();
      return data ?? [];
    };

    // --- run 1 ---------------------------------------------------------------
    expect((await svc.rpc("create_followup_nudges", { p_org: ORG_A })).error).toBeNull();

    const staleNudges = await nudges("deal_id", staleDeal.id);
    expect(staleNudges, "a deal silent for 20 days is nudged exactly once").toHaveLength(1);
    expect(await nudges("deal_id", freshDeal.id), "a deal touched today is not").toHaveLength(0);

    // due at Cyprus 23:59 of the staleness boundary — not midnight UTC, which
    // would read "overdue" for the whole of the task's final day (0012 #2)
    const cyprus = (isoStr: string) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Nicosia",
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(isoStr));
    const boundary = new Date(new Date(staleDeal.last_contact_at!).getTime() + 14 * dayMs);
    expect(cyprus(staleNudges[0].due_at!)).toBe(`${cyprus(boundary.toISOString()).slice(0, 10)}, 23:59`);

    // three-arm fallback: agent → creator → oldest active admin, never NULL
    expect(staleNudges[0].assignee_id).toBe(agentA1.id);
    const orphanNudges = await nudges("deal_id", orphanDeal.id);
    expect(orphanNudges).toHaveLength(1);

    // The invariant is "never NULL, and lands on an active admin of this org" —
    // NOT "lands on adminA". The fallback picks the org's OLDEST active admin,
    // and the fixture org accumulates admins across local reruns, so pinning
    // the identity made this pass only on a freshly reset database. CI always
    // starts fresh so it stayed green, which is exactly how such a test hides.
    expect(orphanNudges[0].assignee_id, "an orphan deal must not produce a NULL assignee")
      .not.toBeNull();
    const { data: orphanAssignee } = await svc
      .from("profiles")
      .select("role, is_active, org_id")
      .eq("id", orphanNudges[0].assignee_id!)
      .single();
    expect(orphanAssignee, "the fallback assignee must exist").not.toBeNull();
    expect(orphanAssignee!.role, "arm 3 falls back to an admin").toBe("admin");
    expect(orphanAssignee!.is_active, "an inactive admin would be invisible too").toBe(true);
    expect(orphanAssignee!.org_id, "and must be in the deal's own org").toBe(ORG_A);

    expect(await nudges("viewing_id", lateViewing.id), "49h → nudged").toHaveLength(1);
    expect(await nudges("viewing_id", recentViewing.id), "47h → not yet").toHaveLength(0);

    // --- run 2: no same-cycle re-nag (the 0006 bug 0012 was written to kill) --
    expect((await svc.rpc("create_followup_nudges", { p_org: ORG_A })).error).toBeNull();
    expect(await nudges("deal_id", staleDeal.id)).toHaveLength(1);
    expect(await nudges("viewing_id", lateViewing.id)).toHaveLength(1);

    // --- contact made: the trigger supersedes immediately, with an actor ------
    const touched = await agentA1.client
      .from("deals")
      .update({ last_contact_at: new Date().toISOString() })
      .eq("id", staleDeal.id)
      .select("id");
    expect(touched.error).toBeNull();
    expect(touched.data).toHaveLength(1);

    const afterContact = await nudges("deal_id", staleDeal.id);
    expect(afterContact, "superseded, never deleted — the row survives").toHaveLength(1);
    expect(afterContact[0].is_done, "contact closes the open nudge at edit time").toBe(true);

    const { data: supersedeEvents } = await svc
      .from("events")
      .select("actor_id, payload")
      .eq("event_type", "superseded")
      .eq("entity_id", afterContact[0].id);
    expect(supersedeEvents ?? []).toHaveLength(1);
    expect(supersedeEvents![0].actor_id, "the trigger attributes the acting user").toBe(agentA1.id);

    // --- a later silence is a NEW cycle, so a new task is minted -------------
    expect(
      (
        await svc
          .from("deals")
          .update({ last_contact_at: iso(15 * dayMs) })
          .eq("id", staleDeal.id)
      ).error,
    ).toBeNull();
    expect((await svc.rpc("create_followup_nudges", { p_org: ORG_A })).error).toBeNull();
    const secondCycle = await nudges("deal_id", staleDeal.id);
    expect(secondCycle, "a second silent period nudges again").toHaveLength(2);
    expect(secondCycle.filter((t) => !t.is_done), "and only one is open").toHaveLength(1);

    // --- closing the deal supersedes ----------------------------------------
    expect(
      (await svc.from("deals").update({ status: "won", won_at: new Date().toISOString() }).eq("id", orphanDeal.id))
        .error,
    ).toBeNull();
    expect((await nudges("deal_id", orphanDeal.id)).every((t) => t.is_done)).toBe(true);

    // --- logging feedback supersedes, and cron does not re-create ------------
    const feedback = await agentA1.client
      .from("viewings")
      .update({ feedback: { rating: 4 } })
      .eq("id", lateViewing.id)
      .select("id");
    expect(feedback.error).toBeNull();
    const afterFeedback = await nudges("viewing_id", lateViewing.id);
    expect(afterFeedback).toHaveLength(1);
    expect(afterFeedback[0].is_done).toBe(true);
    expect((await svc.rpc("create_followup_nudges", { p_org: ORG_A })).error).toBeNull();
    expect(await nudges("viewing_id", lateViewing.id)).toHaveLength(1);

    // --- p_org really scoped the job, and the chain still verifies -----------
    const seededAfter = await svc
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("org_id", SEEDED_ORG)
      .in("kind", ["deal_no_contact", "viewing_feedback"]);
    expect(seededAfter.count ?? 0, "p_org must confine the job to the fixture org").toBe(
      seededBefore.count ?? 0,
    );

    const { data: chainOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(chainOk, "the new event types keep the hash chain intact").toBe(true);
  });

  it("25. share_links: anon reads nothing, resolves only a LIVE token, and only allowlisted fields", async () => {
    const svc = serviceClient();
    const anon = anonClient();
    const { createHash, randomBytes } = await import("node:crypto");
    const mint = () => randomBytes(32).toString("base64url");
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");

    const { data: prop } = await svc
      .from("properties")
      .insert({
        org_id: ORG_A,
        reference: `SHR-${randomBytes(4).toString("hex")}`,
        property_type: "villa",
        visibility: "public",
        title: { en: "Shared villa" },
        asking_price: 500000,
        owner_net_price: 444444,
        min_acceptable_price: 455555,
        internal_notes: "NEVER-LEAK-THIS",
      })
      .select("id")
      .single();

    const mkLink = async (extra: Record<string, unknown>) => {
      const token = mint();
      const { data } = await svc
        .from("share_links")
        .insert({
          org_id: ORG_A,
          token_sha256: sha(token),
          expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          created_by: adminA.id,
          ...extra,
        })
        .select("id")
        .single();
      await svc
        .from("share_link_properties")
        .insert({ share_link_id: data!.id, property_id: prop!.id, sort_order: 0 });
      return { token, id: data!.id };
    };

    const live = await mkLink({});
    const revoked = await mkLink({ revoked_at: new Date().toISOString() });
    const expired = await mkLink({
      expires_at: new Date(Date.now() - 86_400_000).toISOString(),
    });

    // --- anon may not read the tables at all --------------------------------
    const anonLinks = await anon.from("share_links").select("id");
    expect(anonLinks.data ?? [], "anon must not read share_links").toHaveLength(0);
    const anonJoin = await anon.from("share_link_properties").select("property_id");
    expect(anonJoin.data ?? [], "anon must not read share_link_properties").toHaveLength(0);

    // --- but anon MAY resolve a live token (the buyer entry point) ----------
    const ok = await anon.rpc("resolve_share_link", { p_token_sha256: sha(live.token) });
    expect(ok.error).toBeNull();
    expect(ok.data, "a live token must resolve for anon").not.toBeNull();

    const payload = ok.data as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      [
        "agent",
        "expires_at",
        "locale",
        "message",
        "org",
        "properties",
        "property_count",
        "title",
      ].sort(),
    );

    // The exposure boundary is the point of this feature: assert the private
    // numbers and notes are absent from the WHOLE serialized payload, so a
    // future `select *` in the RPC fails here rather than in production.
    const asText = JSON.stringify(payload);
    expect(asText).not.toContain("NEVER-LEAK-THIS");
    expect(asText).not.toContain("444444");
    expect(asText).not.toContain("455555");
    expect(asText).toContain("500000");

    // --- dead tokens are indistinguishable ----------------------------------
    for (const [label, token] of [
      ["revoked", revoked.token],
      ["expired", expired.token],
      ["unknown", mint()],
    ] as const) {
      const res = await anon.rpc("resolve_share_link", { p_token_sha256: sha(token) });
      expect(res.error, `${label}: must not error`).toBeNull();
      expect(res.data, `${label} token must resolve to null`).toBeNull();
    }

    // --- the throttle: many opens, ONE event per Cyprus day -----------------
    await anon.rpc("resolve_share_link", { p_token_sha256: sha(live.token) });
    await anon.rpc("resolve_share_link", { p_token_sha256: sha(live.token) });

    const { data: after } = await svc
      .from("share_links")
      .select("view_count")
      .eq("id", live.id)
      .single();
    expect(after!.view_count, "every open is counted exactly").toBe(3);

    const { count: openedEvents } = await svc
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("entity_type", "share_link")
      .eq("entity_id", live.id)
      .eq("event_type", "opened");
    expect(openedEvents, "throttled to one opened event per Cyprus day").toBe(1);

    // --- cross-org isolation for staff --------------------------------------
    const bSees = await agentB.client.from("share_links").select("id").eq("id", live.id);
    expect(bSees.data ?? [], "org B must not see org A's links").toHaveLength(0);

    const { data: chainOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(chainOk, "share_link events keep the chain intact").toBe(true);
  });

  it("26. create_followup_nudges: a deactivated agent or creator never receives a nudge", async () => {
    // 0012 taught that a NULL assignee is invisible: /tasks and the agent
    // dashboard both filter assignee_id = me. An assignee who is DEACTIVATED is
    // worse than NULL — the task is equally invisible (test 19: is_active =
    // false kills the session), but it no longer LOOKS unassigned, so no
    // "unassigned tasks" surface can ever find it.
    //
    // Test 24 pinned this for arm 3 only ("an inactive admin would be invisible
    // too"). Arms 1 and 2 took the agent and the creator raw, so the guard
    // stopped exactly where the fallback started.
    const dayMs = 86_400_000;
    const iso = (ms: number) => new Date(Date.now() - ms).toISOString();

    const ghost = await createTestUser(svc, `ghost-agent-${run}@test.local`, "agent", ORG_A);
    const off = await svc.from("profiles").update({ is_active: false }).eq("id", ghost.id);
    expect(off.error).toBeNull();

    const { data: deals, error: dealsErr } = await svc
      .from("deals")
      .insert([
        {
          org_id: ORG_A,
          deal_type: "sale",
          stage_id: stageSaleNew,
          title: `Nudge ghost-agent ${run}`,
          agent_id: ghost.id, // arm 1 must skip this
          created_by: null,
          last_contact_at: iso(20 * dayMs),
          last_activity_at: iso(20 * dayMs),
        },
        {
          org_id: ORG_A,
          deal_type: "sale",
          stage_id: stageSaleNew,
          title: `Nudge ghost-creator ${run}`,
          agent_id: null,
          created_by: ghost.id, // arm 2 must skip this
          last_contact_at: iso(20 * dayMs),
          last_activity_at: iso(20 * dayMs),
        },
      ])
      .select("id");
    expect(dealsErr).toBeNull();
    const [ghostAgentDeal, ghostCreatorDeal] = deals!;

    const { data: viewing, error: viewErr } = await svc
      .from("viewings")
      .insert({
        org_id: ORG_A,
        property_id: propA1,
        contact_id: contactA,
        agent_id: ghost.id, // the viewing rule has the same two arms
        created_by: null,
        scheduled_at: iso(49 * 3_600_000),
        status: "completed",
      })
      .select("id")
      .single();
    expect(viewErr).toBeNull();

    expect((await svc.rpc("create_followup_nudges", { p_org: ORG_A })).error).toBeNull();

    /** The one open nudge for an entity, with its assignee's active state. */
    const assigneeOf = async (col: "deal_id" | "viewing_id", id: string) => {
      const { data: tasks, error } = await svc
        .from("tasks")
        .select("id, assignee_id")
        .eq(col, id)
        .not("kind", "is", null)
        .eq("is_done", false);
      expect(error).toBeNull();
      expect(tasks ?? [], `${col} ${id} must have exactly one open nudge`).toHaveLength(1);

      const assigneeId = tasks![0].assignee_id;
      expect(assigneeId, "a nudge with no assignee is invisible (0012)").not.toBeNull();

      const { data: profile } = await svc
        .from("profiles")
        .select("id, role, is_active, org_id")
        .eq("id", assigneeId!)
        .single();
      expect(profile, "the assignee must exist").not.toBeNull();
      return profile!;
    };

    /**
     * The assignee AS MINTED, read from the creation event rather than the task
     * row. Step 5 of the job re-homes stranded tasks in the SAME invocation that
     * creates them, so the final `tasks.assignee_id` cannot distinguish "the
     * fallback skipped the deactivated arm" from "the fallback used it and the
     * sweep cleaned up after". Verified by reverting the arms and watching this
     * test still pass on the row alone. The event is written inside step 1/2,
     * before the sweep, so it is the only witness to what the arms chose.
     */
    const mintedAssigneeOf = async (entityType: "deal" | "viewing", id: string) => {
      const { data: created, error } = await svc
        .from("events")
        .select("payload")
        .eq("entity_type", entityType)
        .eq("entity_id", id)
        .eq("event_type", "followup_task_created");
      expect(error).toBeNull();
      expect(created ?? [], `${entityType} ${id} must have one creation event`).toHaveLength(1);
      return (created![0].payload as { assignee_id: string | null }).assignee_id;
    };

    for (const [label, entityType, col, id] of [
      ["deal agent", "deal", "deal_id", ghostAgentDeal.id],
      ["deal creator", "deal", "deal_id", ghostCreatorDeal.id],
      ["viewing agent", "viewing", "viewing_id", viewing!.id],
    ] as const) {
      const minted = await mintedAssigneeOf(entityType, id);
      expect(minted, `${label}: the fallback ARM must skip a deactivated profile`).not.toBe(
        ghost.id,
      );

      const assignee = await assigneeOf(col, id);
      expect(assignee.id, `${label}: a deactivated profile must not be nudged`).not.toBe(ghost.id);
      expect(assignee.is_active, `${label}: the fallback must land on an ACTIVE profile`).toBe(true);
      expect(assignee.org_id, `${label}: and stay inside the entity's own org`).toBe(ORG_A);
    }

    // The standing invariant, stated once: no open system-generated task in this
    // org may sit on a profile nobody can sign in as.
    const { data: openSystemTasks } = await svc
      .from("tasks")
      .select("id, assignee_id, kind")
      .eq("org_id", ORG_A)
      .not("kind", "is", null)
      .not("assignee_id", "is", null)
      .eq("is_done", false);

    const { data: inactive } = await svc
      .from("profiles")
      .select("id")
      .eq("org_id", ORG_A)
      .eq("is_active", false);
    const inactiveIds = new Set((inactive ?? []).map((p) => p.id));

    const stranded = (openSystemTasks ?? []).filter((t) => inactiveIds.has(t.assignee_id!));
    expect(stranded, "open system tasks stranded on deactivated profiles").toEqual([]);

    const { data: chainOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(chainOk, "the nudge events keep the hash chain intact").toBe(true);
  });

  it("27. editing a deal does not silence its no-contact nudge", async () => {
    // B7 measures silence with deals.last_activity_at, which lib/actions/deals.ts
    // stamps on EVERY field change. So renaming a deal reads as "I spoke to the
    // buyer": trg_supersede_deal_nudges closes the open chase-up immediately and
    // records reason 'deal_contacted_or_closed' — an assertion about the world
    // that nobody made. The nightly job then declines to re-mint it, because the
    // boundary moved 14 days too.
    //
    // Contact is a claim someone makes, not a side effect of typing.
    const dayMs = 86_400_000;
    const silentSince = new Date(Date.now() - 20 * dayMs).toISOString();

    const { data: deal, error: dealErr } = await svc
      .from("deals")
      .insert({
        org_id: ORG_A,
        deal_type: "sale",
        stage_id: stageSaleNew,
        title: `Nudge edit-silence ${run}`,
        agent_id: agentA1.id,
        // Silence is now "nobody has logged contact since", not "nothing has
        // been typed since" — last_activity_at is set to the same instant so the
        // deal is unambiguously stale under either reading at the start.
        last_contact_at: silentSince,
        last_activity_at: silentSince,
      })
      .select("id")
      .single();
    expect(dealErr).toBeNull();

    expect((await svc.rpc("create_followup_nudges", { p_org: ORG_A })).error).toBeNull();

    const openNudges = async () => {
      const { data, error } = await svc
        .from("tasks")
        .select("id, is_done")
        .eq("deal_id", deal!.id)
        .eq("kind", "deal_no_contact")
        .eq("is_done", false);
      expect(error).toBeNull();
      return data ?? [];
    };

    expect(await openNudges(), "a 20-day-silent deal must get one nudge").toHaveLength(1);

    // Exactly what lib/actions/deals.ts:138 does for any edit — a title change
    // carrying the same last_activity_at stamp the generic update path applies.
    const { error: editErr } = await svc
      .from("deals")
      .update({ title: `Nudge edit-silence ${run} (renamed)`, last_activity_at: new Date().toISOString() })
      .eq("id", deal!.id);
    expect(editErr).toBeNull();

    expect(
      await openNudges(),
      "renaming a deal is not contact — the chase-up must survive the edit",
    ).toHaveLength(1);

    // And the nightly job must not close it either.
    expect((await svc.rpc("create_followup_nudges", { p_org: ORG_A })).error).toBeNull();
    expect(
      await openNudges(),
      "the nightly sweep must not treat an edit as contact",
    ).toHaveLength(1);

    // The other half, and the reason this test is not satisfied by simply
    // breaking supersede: logging contact MUST still close the chase-up.
    const [{ id: nudgeId }] = await openNudges();
    const { error: contactErr } = await svc
      .from("deals")
      .update({ last_contact_at: new Date().toISOString() })
      .eq("id", deal!.id);
    expect(contactErr).toBeNull();

    expect(await openNudges(), "logging contact must close the chase-up").toHaveLength(0);

    // And it must say WHY in terms that are true. 0020 recorded
    // 'deal_contacted_or_closed' for both causes, so the log asserted a closure
    // that may not have happened; 0025 splits them.
    const { data: why } = await svc
      .from("events")
      .select("payload")
      .eq("entity_type", "task")
      .eq("entity_id", nudgeId)
      .eq("event_type", "superseded");
    expect(why ?? [], "closing a nudge is evented").toHaveLength(1);
    expect((why![0].payload as { reason: string }).reason).toBe("deal_contacted");
  });
  it("28. org_mfa_status: admin-only, org-scoped, and never callable by anon", async () => {
    // 0028 exists because auth.mfa_factors is unreachable from the app, so an
    // admin could not see that a COLLEAGUE was password-only. It is a security
    // definer function reaching into the auth schema, which makes its grants
    // the risky part — a new one is executable by `public` (and therefore
    // `anon`) unless explicitly revoked, and missing that is what migration
    // 0021 got wrong.

    // anon must not be able to call it at all.
    const anonCall = await anonClient().rpc("org_mfa_status");
    expect(anonCall.error, "anon must be refused execute on org_mfa_status").not.toBeNull();

    // An admin gets one row per profile in their OWN org, and a boolean.
    // The suite's clients are untyped, so name the shape the RPC promises —
    // which also pins it: if 0028 ever returned more than this, it stops
    // compiling here rather than quietly widening what an admin can read.
    type MfaRow = { profile_id: string; has_verified_factor: boolean };
    const asAdmin = await adminA.client.rpc("org_mfa_status");
    expect(asAdmin.error).toBeNull();
    const rows = (asAdmin.data ?? []) as MfaRow[];
    expect(rows.length, "admin sees their org's profiles").toBeGreaterThan(0);
    for (const r of rows) {
      expect(typeof r.has_verified_factor).toBe("boolean");
    }

    // Org scoping: nothing from org B leaks in.
    const { data: orgBProfiles } = await svc
      .from("profiles")
      .select("id")
      .neq("org_id", ORG_A);
    const foreign = new Set((orgBProfiles ?? []).map((p) => p.id));
    expect(
      rows.filter((r) => foreign.has(r.profile_id)),
      "org_mfa_status must not cross the org boundary",
    ).toHaveLength(0);

    // A non-admin gets ZERO rows rather than an error — the gate is in the body,
    // so the check travels with the function instead of living in the caller.
    const asAgent = await agentA1.client.rpc("org_mfa_status");
    expect(asAgent.error, "an agent may call it").toBeNull();
    expect(asAgent.data ?? [], "an agent must learn nothing from it").toHaveLength(0);

    // It answers one BIT and never factor detail: no secrets, ids or names.
    const keys = new Set(Object.keys(rows[0] ?? {}));
    expect([...keys].sort()).toEqual(["has_verified_factor", "profile_id"]);
  });
});
