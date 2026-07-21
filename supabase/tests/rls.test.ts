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
    // the 0016 seed call (and nightly cron) guarantees a row per org
    await svc.rpc("run_chain_checks");

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

    // the RPC itself is service/cron-only
    const rpc = await adminA.client.rpc("run_chain_checks");
    expect(rpc.error, "run_chain_checks must be revoked from authenticated").not.toBeNull();
  });
});
