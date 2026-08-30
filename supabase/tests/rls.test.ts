/**
 * RLS test suite — the 12 mandatory tests from docs/04_RLS_POLICY_MATRIX.md.
 * Requires the local Supabase stack (`supabase start`). Run: npm run test:rls
 *
 * Fixtures use a per-run suffix so reruns never collide; `supabase db reset`
 * clears accumulated test data.
 */
import { createHash } from "node:crypto";
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

    // THE RESTORE IS IN `finally`, AND THAT IS LOAD-BEARING. Every other test
    // in this file that touches events asserts the chain verifies, so a failed
    // expectation between the tamper and the restore does not fail one test —
    // it leaves ORG_A's chain broken and cascades into twelve. Measured: adding
    // the 0060 assertion below without this block turned one real failure into
    // "12 failed", and the fixture stayed corrupt after the run.
    try {
      await svc.from("events").update({ event_type: "tampered" }).eq("id", victim!.id);

      const during = await svc.rpc("verify_events_chain", { p_org: ORG_A });
      expect(during.data, "chain must fail after tamper").toBe(false);

      // 0060: the diagnostic overload must name the row BY ID, inside the same
      // tamper window. A bare `false` is what turns a real incident into a
      // manual bisect; this assertion is the point of the migration.
      const detail = await svc.rpc("verify_events_chain", { p_org: ORG_A, p_from_id: null });
      expect(detail.error).toBeNull();
      expect(detail.data?.[0], "the detail form must name the tampered row").toMatchObject({
        ok: false,
        failed_id: victim!.id,
        reason: "hash_mismatch",
      });
    } finally {
      await svc.from("events").update({ event_type: original }).eq("id", victim!.id);
    }

    const after = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(after.data, "chain must verify after restore").toBe(true);

    // The two forms must agree once restored — the boolean is a projection of
    // the row, not a second implementation free to drift from it.
    const afterDetail = await svc.rpc("verify_events_chain", { p_org: ORG_A, p_from_id: null });
    expect(afterDetail.data?.[0], "a clean chain reports no failing row").toMatchObject({
      ok: true,
      failed_id: null,
      reason: null,
    });
  });

  it("12b. verify_events_chain: neither signature is reachable by anon or a signed-in agent", async () => {
    // GRANTS ARE PER SIGNATURE — an overload inherits nothing from the name it
    // shares, which is the trap that bit 0021 and 0044. 0019's reasoning
    // applies to the new one too: a full walk is O(all org events), so an
    // on-demand walk reachable from a browser session is a self-inflicted DoS.
    // /reports reads the cached chain_checks row instead.
    const anon = anonClient();

    const anonOneArg = await anon.rpc("verify_events_chain", { p_org: ORG_A });
    expect(anonOneArg.error, "anon must not execute the boolean form").not.toBeNull();
    const agentOneArg = await agentA1.client.rpc("verify_events_chain", { p_org: ORG_A });
    expect(agentOneArg.error, "a signed-in agent must not execute the boolean form").not.toBeNull();

    const anonTwoArg = await anon.rpc("verify_events_chain", { p_org: ORG_A, p_from_id: null });
    expect(anonTwoArg.error, "anon must not execute the diagnostic form").not.toBeNull();
    const agentTwoArg = await agentA1.client.rpc("verify_events_chain", {
      p_org: ORG_A,
      p_from_id: null,
    });
    expect(
      agentTwoArg.error,
      "a signed-in agent must not execute the diagnostic form",
    ).not.toBeNull();
  });

  it("12c. hash_version: new events are v2, and the v2 hash re-derives OUTSIDE Postgres", async () => {
    // 0061. THIS IS THE ASSERTION THAT EARNS THE ISO-8601 RENDERING ITS PLACE.
    // The hash is evidence, so a third party must be able to re-derive it in
    // another language, years later, from the row alone. If that is not true
    // then the choice over epoch microseconds bought nothing.
    const { data: w, error: writeErr } = await svc
      .from("events")
      .insert({
        org_id: ORG_A,
        actor_id: null,
        entity_type: "config",
        entity_id: null,
        event_type: `hash_version_check_${run}`,
        // Unicode, a null, a bool, nested and array values — and NO decimal.
        // A decimal is deliberately absent: `480000.00` survives in Postgres
        // but PostgREST hands JavaScript `480000`, so a decimal payload cannot
        // be re-derived from what this client can see. That defect is the whole
        // reason scripts/backup/export-events.sql exists (BACKUP_RESTORE §1),
        // and it limits this test rather than being tested by it.
        payload: { i: 42, n: null, zz: true, note: "Λεμεσός", nested: { k: "v" }, arr: [1, 2] },
      })
      .select(
        "id, org_id, occurred_at, actor_id, entity_type, entity_id, event_type, payload, prev_hash, hash, hash_version",
      )
      .single();
    if (writeErr) throw writeErr;

    expect(w.hash_version, "the trigger stamps v2 on every new row").toBe(2);
    expect(w.hash).toMatch(/^[0-9a-f]{64}$/);

    // jsonb's own text form: keys ordered by (length, then bytewise), `", "`
    // between pairs and `": "` after each key. Measured against Postgres.
    const jsonbText = (v: unknown): string => {
      if (v === null) return "null";
      if (Array.isArray(v)) return `[${v.map(jsonbText).join(", ")}]`;
      if (typeof v === "object") {
        const keys = Object.keys(v as object).sort(
          (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
        );
        return `{${keys
          .map((k) => `${JSON.stringify(k)}: ${jsonbText((v as Record<string, unknown>)[k])}`)
          .join(", ")}}`;
      }
      return JSON.stringify(v);
    };

    // to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    // PostgREST returns e.g. 2026-08-28T09:08:46.892006+00:00 — take the
    // microseconds verbatim rather than through Date, which truncates to ms.
    const m = w.occurred_at.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
    if (!m) throw new Error(`unparseable occurred_at: ${w.occurred_at}`);
    expect(w.occurred_at, "the row must come back in UTC for this to be a fair check").toMatch(
      /(\+00:00|\+00|Z)$/,
    );
    const canonical = `${m[1]}T${m[2]}.${(m[3] ?? "").padEnd(6, "0")}Z`;

    const material =
      "v2|" +
      (w.prev_hash ?? "") +
      w.org_id +
      (w.actor_id ?? "") +
      w.entity_type +
      (w.entity_id ?? "") +
      w.event_type +
      jsonbText(w.payload) +
      canonical;

    const rederived = createHash("sha256").update(material, "utf8").digest("hex");
    expect(rederived, "the v2 hash must re-derive in Node from the row alone").toBe(w.hash);

    const chain = await svc.rpc("verify_events_chain", { p_org: ORG_A, p_from_id: null });
    expect(chain.data?.[0]?.ok, "the mixed v1/v2 chain verifies end to end").toBe(true);
  });

  it("12d. hash_version: relabelling a row's version is caught, and an unknown version is refused", async () => {
    const { data: victim } = await svc
      .from("events")
      .select("id, hash_version")
      .eq("org_id", ORG_A)
      .order("id", { ascending: false })
      .limit(1)
      .single();
    expect(victim!.hash_version, "the newest row is v2").toBe(2);

    try {
      // Relabelling v2 -> v1 makes the verifier use the OLD formula on a row
      // hashed with the new one. It must not silently re-verify.
      await svc.from("events").update({ hash_version: 1 }).eq("id", victim!.id);
      const relabelled = await svc.rpc("verify_events_chain", { p_org: ORG_A, p_from_id: null });
      expect(relabelled.data?.[0], "a v2 row relabelled v1 must be caught").toMatchObject({
        ok: false,
        failed_id: victim!.id,
        reason: "hash_mismatch",
      });

      // A version the verifier does not know is refused by name rather than
      // guessed at — this is why there is no CHECK constraint (see 0061).
      await svc.from("events").update({ hash_version: 99 }).eq("id", victim!.id);
      const unknown = await svc.rpc("verify_events_chain", { p_org: ORG_A, p_from_id: null });
      expect(unknown.data?.[0], "an unrecognised version is named, not assumed").toMatchObject({
        ok: false,
        failed_id: victim!.id,
        reason: "unknown_hash_version",
      });
    } finally {
      await svc.from("events").update({ hash_version: 2 }).eq("id", victim!.id);
    }

    const restored = await svc.rpc("verify_events_chain", { p_org: ORG_A, p_from_id: null });
    expect(restored.data?.[0]?.ok, "chain verifies once the version is restored").toBe(true);
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

  it("21b. events_chain_checkpoint: org-scoped read, no app writes, RPCs service-only", async () => {
    // 0062. Same audience and lockdown as chain_checks (test 21) — a new table
    // inherits NONE of it, which is HANDOFF §4.1.
    await svc.rpc("run_chain_checks_full");

    for (const u of [adminA, agentA1, lmA]) {
      const { data, error } = await u.client
        .from("events_chain_checkpoint")
        .select("org_id, last_id, last_hash, verified_at, full_walk_at");
      expect(error).toBeNull();
      expect(data, "staff see exactly their own org's checkpoint").toHaveLength(1);
      expect(data![0].org_id).toBe(ORG_A);
      expect(data![0].full_walk_at, "the seeding pass was a full walk").not.toBeNull();
    }

    const { data: bRows } = await agentB.client.from("events_chain_checkpoint").select("org_id");
    expect((bRows ?? []).map((r) => r.org_id)).not.toContain(ORG_A);

    const anon = anonClient();
    const { data: anonRows } = await anon.from("events_chain_checkpoint").select("org_id");
    expect(anonRows ?? [], "anon must not read checkpoints").toHaveLength(0);

    // writes: no policies + revoked grants
    const ins = await adminA.client
      .from("events_chain_checkpoint")
      .insert({ org_id: ORG_A, last_id: 1, last_hash: "x", verified_at: new Date().toISOString() });
    expect(ins.error, "admin INSERT must fail").not.toBeNull();
    const upd = await adminA.client
      .from("events_chain_checkpoint")
      .update({ last_hash: "tampered" })
      .eq("org_id", ORG_A)
      .select("org_id");
    expect(upd.data ?? [], "admin UPDATE must move nothing").toHaveLength(0);
    const del = await adminA.client
      .from("events_chain_checkpoint")
      .delete({ count: "exact" })
      .eq("org_id", ORG_A);
    expect(del.count ?? 0, "admin DELETE must remove nothing").toBe(0);

    for (const client of [adminA.client, anon]) {
      const full = await client.rpc("run_chain_checks_full");
      expect(full.error, "run_chain_checks_full is service/cron only").not.toBeNull();
      const adv = await client.rpc("advance_chain_checkpoint", { p_org: ORG_A, p_full: false });
      expect(adv.error, "advance_chain_checkpoint is service/cron only").not.toBeNull();
    }
  });

  it("21c. incremental verification resumes, catches a tamper after the anchor, and refuses to advance past damage", async () => {
    // 0062. The point of the checkpoint, asserted rather than assumed.
    await svc.rpc("run_chain_checks_full");
    const { data: anchored } = await svc
      .from("events_chain_checkpoint")
      .select("last_id, last_hash, full_walk_at")
      .eq("org_id", ORG_A)
      .single();

    const { count: total } = await svc
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("org_id", ORG_A);

    const { data: resumed } = await svc.rpc("advance_chain_checkpoint", {
      p_org: ORG_A,
      p_full: false,
    });
    expect(resumed?.[0]?.ok).toBe(true);
    expect(resumed?.[0]?.from_id, "it resumed from the anchor, not from genesis").toBe(
      anchored!.last_id,
    );
    expect(
      resumed?.[0]?.walked,
      "an incremental pass must not re-walk the whole chain",
    ).toBeLessThan(total ?? Number.MAX_SAFE_INTEGER);

    const { data: victim } = await svc
      .from("events")
      .insert({
        org_id: ORG_A,
        entity_type: "config",
        event_type: `cp_tamper_${run}`,
        payload: {},
      })
      .select("id, event_type")
      .single();

    try {
      await svc.from("events").update({ event_type: "TAMPERED" }).eq("id", victim!.id);
      const caught = await svc.rpc("advance_chain_checkpoint", { p_org: ORG_A, p_full: false });
      expect(caught.data?.[0], "the incremental pass names the tampered row").toMatchObject({
        ok: false,
        failed_id: victim!.id,
        reason: "hash_mismatch",
      });

      const { data: after } = await svc
        .from("events_chain_checkpoint")
        .select("last_id")
        .eq("org_id", ORG_A)
        .single();
      expect(
        after!.last_id,
        "a failed walk leaves the anchor at the last KNOWN-GOOD position rather than stepping over the damage",
      ).toBe(anchored!.last_id);
    } finally {
      await svc.from("events").update({ event_type: victim!.event_type }).eq("id", victim!.id);
    }

    await svc.rpc("run_chain_checks_full");
    const { data: fresh } = await svc
      .from("events_chain_checkpoint")
      .select("last_id")
      .eq("org_id", ORG_A)
      .single();
    expect(fresh!.last_id, "a clean full walk re-anchors past the restored row").toBeGreaterThan(
      anchored!.last_id,
    );
  });

  it("21d. partitioned events: writes still route and verify, and partition health is clean", async () => {
    // 0063. `events` is now RANGE-partitioned monthly on occurred_at with
    // PK (id, occurred_at). Nothing above this line changed, which is the point
    // — but three things could break silently and none of them would show up as
    // an error, so they are asserted.

    // 1. an ordinary write still works through RLS, still gets hashed, and the
    //    chain still verifies. A partition routing failure would surface here.
    const { data: written, error: writeErr } = await agentA1.client
      .from("events")
      .insert({
        org_id: ORG_A,
        actor_id: agentA1.id,
        entity_type: "config",
        event_type: `partition_write_${run}`,
        payload: { note: "routed through the parent" },
      })
      .select("id, hash, hash_version, occurred_at")
      .single();
    expect(writeErr, "an agent must still be able to append an event").toBeNull();
    expect(written!.hash, "the trigger still fires on the partitioned table").toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(written!.hash_version).toBe(2);

    const chain = await svc.rpc("verify_events_chain", { p_org: ORG_A, p_from_id: null });
    expect(chain.data?.[0]?.ok, "the chain verifies across partitions").toBe(true);

    // 2. the invariants partitioning makes breakable — including any partition
    //    that has picked up a grant for anon or authenticated.
    //
    //    THIS IS DELIBERATELY NOT "try to GET a partition over the API". That
    //    assertion was written first and is VACUOUS: measured, PostgREST
    //    excludes partitions from its schema cache, so a partition moved into
    //    `public` and explicitly granted `select` to anon is STILL refused with
    //    PGRST205 after a full restart. It passes whether the partition is
    //    protected or wide open. The GRANT is the real exposure — pg_default_acl
    //    hands anon `Dxtm` on anything created in `public`, and `D` is TRUNCATE,
    //    which RLS does not gate — so the grant is what gets asserted.
    const anon = anonClient();
    const health = await svc.rpc("events_partition_health");
    expect(health.error).toBeNull();
    expect(
      health.data ?? [],
      "inversions, duplicate ids, rows stranded in DEFAULT, or a partition granted to an app role",
    ).toEqual([]);

    // and the health check is not something a browser session can run
    for (const client of [anon, adminA.client]) {
      const denied = await client.rpc("events_partition_health");
      expect(denied.error, "events_partition_health is service-only").not.toBeNull();
      const denied2 = await client.rpc("ensure_events_partitions", {});
      expect(denied2.error, "ensure_events_partitions is service-only").not.toBeNull();
    }
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
    ]) {
      expect(statsA, `missing ${key}`).toHaveProperty(key);
    }
    // 0057 REMOVED `top_actors30`. "Top agents by activity" was dropped by
    // operator decision on 2026-08-26 and nothing replaced it, so asserting the
    // key's ABSENCE is the point of this line: it is settled, not unbuilt, and
    // a decision with nothing checking it is the kind that gets quietly undone.
    // This used to assert the key was present and capped at 5.
    expect(
      statsA,
      "top_actors30 was removed by 0057 and must not come back",
    ).not.toHaveProperty("top_actors30");
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
  it("29. availability share links: status IS exposed, only for that kind, and a phased project's units are found", async () => {
    // The companion to test 25. 25 pins the PROPOSAL boundary; this pins the
    // AVAILABILITY one and — the point of having both — proves the widening is
    // scoped to the new kind rather than global, by resolving a proposal over
    // the very same project and finding `status` still absent from it.
    const anon = anonClient();
    const { createHash, randomBytes } = await import("node:crypto");
    const mint = () => randomBytes(32).toString("base64url");
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    const ref = (suffix: string) => `AVL-${run}-${suffix}`;

    // --- a PHASED project: units hang off the phase, not the project ---------
    const { data: project, error: projErr } = await svc
      .from("properties")
      .insert({
        org_id: ORG_A,
        reference: ref("PROJ"),
        kind: "project",
        property_type: "apartment",
        visibility: "private", // units are minted private on purpose (0035)
        title: { en: "Test development" },
        delivery_date: "2028-03-31",
        construction_status: "under construction",
        internal_notes: "NEVER-LEAK-PROJECT",
        owner_net_price: 111111,
        min_acceptable_price: 222222,
      })
      .select("id")
      .single();
    expect(projErr).toBeNull();

    const { data: phase, error: phaseErr } = await svc
      .from("properties")
      .insert({
        org_id: ORG_A,
        reference: ref("PROJ-P1"),
        kind: "phase",
        parent_id: project!.id,
        property_type: "apartment",
        title: { en: "Phase 1" },
        delivery_date: "2029-09-30", // a phase's OWN date, severed from the project
        status: "available",
      })
      .select("id")
      .single();
    expect(phaseErr).toBeNull();

    const mkUnit = async (
      suffix: string,
      parent: string,
      over: Record<string, unknown> = {},
    ) => {
      const { data, error } = await svc
        .from("properties")
        .insert({
          org_id: ORG_A,
          reference: ref(suffix),
          kind: "unit",
          parent_id: parent,
          property_type: "apartment",
          status: "available",
          unit_number: suffix.slice(-3),
          block: "A",
          bedrooms: 2,
          covered_area_sqm: 85,
          asking_price: 255000,
          ...over,
        })
        .select("id")
        .single();
      expect(error, `unit ${suffix}`).toBeNull();
      return data!.id;
    };

    const direct = await mkUnit("U001", project!.id, { asking_price: 300000 });
    await mkUnit("P1-U101", phase!.id, {
      internal_notes: "NEVER-LEAK-UNIT",
      owner_net_price: 333333,
      min_acceptable_price: 444333,
    });
    const soldInPhase = await mkUnit("P1-U102", phase!.id, { status: "sold" });
    await mkUnit("P1-U103", phase!.id, { visibility: "archived" });
    await mkUnit("P1-U104", phase!.id, { status: "draft" });
    // no asking price yet: "on application" in live mode, NOT a price-list
    // shortfall. The distinction is the whole meaning of `unpriced_count`.
    await mkUnit("P1-U105", phase!.id, { asking_price: null });

    const mkLink = async (extra: Record<string, unknown>, propertyId: string) => {
      const token = mint();
      const { data, error } = await svc
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
      expect(error).toBeNull();
      await svc
        .from("share_link_properties")
        .insert({ share_link_id: data!.id, property_id: propertyId, sort_order: 0 });
      return { token, id: data!.id };
    };

    // --- the project link: descendants, not children -------------------------
    const live = await mkLink({ kind: "availability" }, project!.id);
    const res = await anon.rpc("resolve_share_link", { p_token_sha256: sha(live.token) });
    expect(res.error).toBeNull();
    const payload = res.data as Record<string, unknown>;
    expect(payload, "a live availability token must resolve for anon").not.toBeNull();
    expect(payload.kind, "the availability payload carries the discriminator").toBe(
      "availability",
    );

    type PayloadUnit = Record<string, unknown> & { reference: string; status: string };
    const units = payload.units as PayloadUnit[];

    // THE TRAP: a naive `parent_id = project` query returns NOTHING here,
    // because every unit but one hangs off the phase.
    expect(
      units.map((u) => u.reference).sort(),
      "units under a PHASE must appear on a link naming the project",
    ).toEqual([ref("P1-U101"), ref("P1-U102"), ref("P1-U105"), ref("U001")].sort());
    expect(payload.unit_count).toBe(4);
    expect(payload.available_count, "sold is shown but is not available").toBe(3);

    // archived drops out one by one, exactly as a proposal's properties do;
    // draft is not inventory and never appears
    const shown = new Set(units.map((u) => u.reference));
    expect(shown.has(ref("P1-U103")), "an archived unit must drop out").toBe(false);
    expect(shown.has(ref("P1-U104")), "a draft unit is not inventory").toBe(false);

    // --- THE WIDENING: status is here, and it is real ------------------------
    expect(units.find((u) => u.reference === ref("P1-U102"))!.status).toBe("sold");
    expect(units.find((u) => u.reference === ref("U001"))!.status).toBe("available");

    // --- each unit is tagged with its phase, and the phase carries its OWN date
    expect(units.find((u) => u.reference === ref("U001"))!.phase_reference).toBeNull();
    expect(units.find((u) => u.reference === ref("P1-U101"))!.phase_reference).toBe(
      ref("PROJ-P1"),
    );
    const phases = payload.phases as { reference: string; delivery_date: string }[];
    expect(phases).toHaveLength(1);
    expect(phases[0].delivery_date, "the phase's date, not the project's").toBe("2029-09-30");
    expect((payload.project as { delivery_date: string }).delivery_date).toBe("2028-03-31");

    // --- and nothing forbidden came with it ----------------------------------
    const asText = JSON.stringify(payload);
    for (const secret of [
      "NEVER-LEAK-PROJECT",
      "NEVER-LEAK-UNIT",
      "111111",
      "222222",
      "333333",
      "444333",
    ]) {
      expect(asText, `${secret} must never reach a public payload`).not.toContain(secret);
    }
    // visibility does NOT move with status — it is the desk's channel strategy
    expect(Object.keys(payload)).not.toContain("visibility");
    for (const u of units) expect(Object.keys(u)).not.toContain("visibility");

    // --- THE SCOPING PROOF: same project, proposal kind, no status -----------
    const asProposal = await mkLink({}, project!.id); // kind defaults to 'proposal'
    const propRes = await anon.rpc("resolve_share_link", {
      p_token_sha256: sha(asProposal.token),
    });
    expect(propRes.error).toBeNull();
    const propPayload = propRes.data as Record<string, unknown>;
    expect(propPayload.kind, "a proposal payload carries no discriminator").toBeUndefined();
    const propProperties = propPayload.properties as Record<string, unknown>[];
    expect(propProperties).toHaveLength(1);
    expect(
      Object.keys(propProperties[0]),
      "the proposal allowlist must NOT have gained status when availability did",
    ).not.toContain("status");
    expect(JSON.stringify(propPayload)).not.toContain("NEVER-LEAK-PROJECT");

    // --- a link naming the PHASE shows only that phase's units ---------------
    const phaseLink = await mkLink({ kind: "availability" }, phase!.id);
    const phaseRes = await anon.rpc("resolve_share_link", {
      p_token_sha256: sha(phaseLink.token),
    });
    const phasePayload = phaseRes.data as Record<string, unknown>;
    expect(
      (phasePayload.units as PayloadUnit[]).map((u) => u.reference).sort(),
      "a phase link is the scoping control — it shows its own units and no others",
    ).toEqual([ref("P1-U101"), ref("P1-U102"), ref("P1-U105")].sort());
    expect((phasePayload.project as { kind: string }).kind).toBe("phase");

    // --- prices: live by default --------------------------------------------
    expect(payload.price_source).toBe("live");
    expect(payload.price_list).toBeNull();
    expect(units.find((u) => u.reference === ref("U001"))!.price).toBe(300000);
    // REGRESSION: this shipped as 1 and put "not in that price list" on a page
    // with no price list. A unit with no asking price is "on application", not
    // a shortfall — `unpriced_count` only ever answers for a PINNED version.
    expect(units.find((u) => u.reference === ref("P1-U105"))!.price).toBeNull();
    expect(payload.unpriced_count, "live mode has no shortfall to report").toBe(0);

    // --- prices: PINNED means pinned, with no fallback -----------------------
    const { data: priceList, error: plErr } = await svc
      .from("price_lists")
      .insert({
        org_id: ORG_A,
        project_id: project!.id,
        version: 1,
        effective_date: "2026-08-01",
      })
      .select("id")
      .single();
    expect(plErr).toBeNull();
    // `direct` and `soldInPhase` are quoted; P1-U101 is deliberately absent
    expect(
      (
        await svc.from("price_list_items").insert([
          { price_list_id: priceList!.id, unit_id: direct, list_price: 290000 },
          { price_list_id: priceList!.id, unit_id: soldInPhase, list_price: 240000 },
        ])
      ).error,
    ).toBeNull();

    // the desk repricing this morning must NOT change what was quoted
    expect(
      (await svc.from("properties").update({ asking_price: 999999 }).eq("id", direct)).error,
    ).toBeNull();

    const pinned = await mkLink(
      { kind: "availability", price_list_id: priceList!.id },
      project!.id,
    );
    const pinnedRes = await anon.rpc("resolve_share_link", {
      p_token_sha256: sha(pinned.token),
    });
    const pinnedPayload = pinnedRes.data as Record<string, unknown>;
    const pinnedUnits = pinnedPayload.units as PayloadUnit[];

    expect(pinnedPayload.price_source).toBe("price_list");
    expect((pinnedPayload.price_list as { version: number }).version).toBe(1);
    expect(
      pinnedUnits.find((u) => u.reference === ref("U001"))!.price,
      "the quoted number, not whatever the desk changed this morning",
    ).toBe(290000);
    expect(JSON.stringify(pinnedPayload), "the live price must not leak in").not.toContain(
      "999999",
    );
    expect(
      pinnedUnits.find((u) => u.reference === ref("P1-U101"))!.price,
      "a unit the version does not list shows NO price rather than a live one",
    ).toBeNull();
    expect(pinnedPayload.unpriced_count, "and the shortfall is stated").toBe(2);

    // --- the pinned version cannot be deleted out from under a live link ----
    const del = await svc.from("price_lists").delete().eq("id", priceList!.id);
    expect(del.error, "on delete restrict protects what was quoted").not.toBeNull();

    // --- dead availability tokens are as indistinguishable as dead proposals -
    const revoked = await mkLink(
      { kind: "availability", revoked_at: new Date().toISOString() },
      project!.id,
    );
    const expired = await mkLink(
      { kind: "availability", expires_at: new Date(Date.now() - 86_400_000).toISOString() },
      project!.id,
    );
    for (const [label, token] of [
      ["revoked", revoked.token],
      ["expired", expired.token],
      ["unknown", mint()],
    ] as const) {
      const dead = await anon.rpc("resolve_share_link", { p_token_sha256: sha(token) });
      expect(dead.error, `${label}: must not error`).toBeNull();
      expect(dead.data, `${label} availability token must resolve to null`).toBeNull();
    }

    // --- the throttle carries over unchanged: exact count, ONE event a day --
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

    // and that event records what they were shown, which is the evidence
    const { data: openEvent } = await svc
      .from("events")
      .select("payload")
      .eq("entity_id", live.id)
      .eq("event_type", "opened")
      .single();
    const openPayload = openEvent!.payload as {
      kind: string;
      unit_count: number;
      available_count: number;
    };
    expect(openPayload.kind).toBe("availability");
    expect(openPayload.unit_count).toBe(4);
    expect(openPayload.available_count).toBe(3);

    // --- anon still cannot reach the tables, only the RPC --------------------
    expect(
      (await anon.from("share_links").select("id").eq("id", live.id)).data ?? [],
      "anon must not read share_links",
    ).toHaveLength(0);

    const { data: chainOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(chainOk, "availability events keep the hash chain intact").toBe(true);
  });

  it("30. buyer_requirements: org-scoped, any agent may write, only admin/LM may delete", async () => {
    // 0043. Policies mirror `contacts` (0002) because a requirement is CRM
    // knowledge about a buyer — with ONE narrowing: DELETE is admin/listing
    // manager only, because `is_active = false` is the normal way to retire a
    // search and a hard delete destroys the record that a buyer ever wanted it.
    //
    // EVERY ASSERTION BELOW CHECKS THE RETURNED ERROR, not just the row count.
    // TEST-2 hid a permission regression for months by ignoring one: an action
    // that is denied and an action that matched zero rows look identical if you
    // only count rows.
    const label = (suffix: string) => `REQ-${run}-${suffix}`;

    // --- a requirement in org A, and one in org B for the isolation check ----
    const { data: reqA, error: reqAErr } = await agentA1.client
      .from("buyer_requirements")
      .insert({
        org_id: ORG_A,
        contact_id: contactA,
        label: label("A"),
        transaction_type: "sale",
        budget_min: 200000,
        budget_max: 300000,
        bedrooms_min: 2,
      })
      .select("id")
      .single();
    expect(reqAErr, "an agent may record a requirement in their own org").toBeNull();
    expect(reqA).not.toBeNull();

    // org B needs its own contact — contact_id has an FK and org B cannot see
    // contactA, so reusing it would fail on the FK rather than on RLS and the
    // test would pass for the wrong reason.
    const { data: contactB } = await svc
      .from("contacts")
      .insert({ org_id: ORG_B, first_name: "Cross", last_name: label("B") })
      .select("id")
      .single();
    const { data: reqB } = await svc
      .from("buyer_requirements")
      .insert({ org_id: ORG_B, contact_id: contactB!.id, label: label("B") })
      .select("id")
      .single();

    // --- cross-org isolation, both directions -------------------------------
    const { data: aSees } = await agentA1.client
      .from("buyer_requirements")
      .select("id, label");
    expect(
      (aSees ?? []).map((r) => r.id),
      "org A must not see org B's requirement",
    ).not.toContain(reqB!.id);
    expect((aSees ?? []).map((r) => r.id), "org A sees its own").toContain(reqA!.id);

    const { data: bSees } = await agentB.client
      .from("buyer_requirements")
      .select("id")
      .eq("id", reqA!.id);
    expect(bSees ?? [], "org B must not see org A's requirement").toHaveLength(0);

    // --- an agent cannot forge a row into another org -----------------------
    const { error: forgeErr } = await agentA1.client
      .from("buyer_requirements")
      .insert({ org_id: ORG_B, contact_id: contactB!.id, label: label("FORGE") });
    expect(forgeErr, "WITH CHECK must reject an insert aimed at another org").not.toBeNull();

    // --- a second agent in the same org may edit it -------------------------
    // Deliberately agentA2, not agentA1: `contacts` narrows UPDATE to the
    // assigned agent, and this table does NOT. If that ever changes, this
    // assertion is what says so.
    const { data: updated, error: updateErr } = await agentA2.client
      .from("buyer_requirements")
      .update({ budget_max: 350000 })
      .eq("id", reqA!.id)
      .select("id");
    expect(updateErr, "any agent in the org may edit a requirement").toBeNull();
    expect(updated ?? [], "the update reached a row").toHaveLength(1);

    // --- archiving is the normal retirement path, open to any agent ---------
    const { error: archiveErr } = await agentA2.client
      .from("buyer_requirements")
      .update({ is_active: false })
      .eq("id", reqA!.id);
    expect(archiveErr, "an agent may archive a requirement").toBeNull();

    // --- but DELETE is gated ------------------------------------------------
    const { error: agentDeleteErr, count: agentDeleted } = await agentA1.client
      .from("buyer_requirements")
      .delete({ count: "exact" })
      .eq("id", reqA!.id);
    // RLS filters a denied DELETE to zero rows rather than erroring, so the
    // COUNT is the assertion that bites here; the row must still be there.
    expect(agentDeleted ?? 0, "an agent must not delete a requirement").toBe(0);
    expect(agentDeleteErr).toBeNull();
    const { data: stillThere } = await svc
      .from("buyer_requirements")
      .select("id")
      .eq("id", reqA!.id);
    expect(stillThere ?? [], "the row survives an agent's delete attempt").toHaveLength(1);

    const { error: lmDeleteErr, count: lmDeleted } = await lmA.client
      .from("buyer_requirements")
      .delete({ count: "exact" })
      .eq("id", reqA!.id);
    expect(lmDeleteErr, "a listing manager may delete").toBeNull();
    expect(lmDeleted ?? 0, "the listing manager's delete reached the row").toBe(1);

    // --- anon reaches nothing ------------------------------------------------
    const anon = anonClient();
    const { data: anonSees } = await anon.from("buyer_requirements").select("id");
    expect(anonSees ?? [], "anon must not read buyer_requirements").toHaveLength(0);
    const { error: anonInsertErr } = await anon
      .from("buyer_requirements")
      .insert({ org_id: ORG_A, contact_id: contactA, label: label("ANON") });
    expect(anonInsertErr, "anon must not insert a requirement").not.toBeNull();

    // --- the CHECK constraints are a real backstop, not decoration ----------
    const { error: bandErr } = await agentA1.client.from("buyer_requirements").insert({
      org_id: ORG_A,
      contact_id: contactA,
      label: label("BAND"),
      budget_min: 400000,
      budget_max: 300000,
    });
    expect(bandErr, "a budget floor above its ceiling must be rejected").not.toBeNull();
    expect(bandErr!.message).toMatch(/budget_band_ordered/);
  });

  it("31. reservations: one live hold per property, org-scoped, and expiry is idempotent", async () => {
    // 0044. The partial unique index is the invariant this test exists for —
    // an action can be raced, an index cannot, so the index is what must be
    // proven rather than the action that respects it.
    const ref = (suffix: string) => `RES-${run}-${suffix}`;

    const { data: prop } = await svc
      .from("properties")
      .insert({
        org_id: ORG_A,
        reference: ref("PROP"),
        kind: "standalone",
        property_type: "apartment",
        status: "available",
        title: { en: "Reservation fixture" },
      })
      .select("id")
      .single();

    const inSevenDays = new Date(Date.now() + 7 * 864e5).toISOString();

    // --- an agent may take a hold in their own org --------------------------
    const { data: first, error: firstErr } = await agentA1.client
      .from("reservations")
      .insert({
        org_id: ORG_A,
        property_id: prop!.id,
        contact_id: contactA,
        status: "held",
        amount: 5000,
        expires_at: inSevenDays,
      })
      .select("id")
      .single();
    expect(firstErr, "an agent may take a hold").toBeNull();

    // --- THE INVARIANT: a second LIVE hold on the same property is refused ---
    const { error: secondErr } = await agentA2.client.from("reservations").insert({
      org_id: ORG_A,
      property_id: prop!.id,
      status: "held",
      expires_at: inSevenDays,
    });
    expect(secondErr, "a second live hold must be refused").not.toBeNull();
    expect(secondErr!.message).toMatch(/reservations_one_live_per_property/);

    // --- and it is PARTIAL: releasing the first frees the property ----------
    // A plain unique index would forbid a property from ever being reserved
    // twice in its life. That is not the rule, and this is what says so.
    await agentA1.client
      .from("reservations")
      .update({ status: "released", released_at: new Date().toISOString() })
      .eq("id", first!.id);

    const { data: second, error: reReserveErr } = await agentA1.client
      .from("reservations")
      .insert({
        org_id: ORG_A,
        property_id: prop!.id,
        status: "held",
        expires_at: new Date(Date.now() - 864e5).toISOString(), // already lapsed
        held_from: new Date(Date.now() - 9 * 864e5).toISOString(),
      })
      .select("id")
      .single();
    expect(reReserveErr, "a released hold frees the property for a new one").toBeNull();

    // --- the window constraint is a real backstop ---------------------------
    const { error: windowErr } = await agentA1.client.from("reservations").insert({
      org_id: ORG_B, // wrong org too, but the CHECK fires first
      property_id: prop!.id,
      status: "held",
      held_from: inSevenDays,
      expires_at: new Date(Date.now() - 864e5).toISOString(),
    });
    expect(windowErr, "a hold expiring before it starts must be refused").not.toBeNull();

    // --- cross-org isolation ------------------------------------------------
    const { data: bSees } = await agentB.client
      .from("reservations")
      .select("id")
      .eq("id", first!.id);
    expect(bSees ?? [], "org B must not see org A's reservation").toHaveLength(0);

    // --- DELETE is gated to admin / listing manager -------------------------
    const { count: agentDeleted } = await agentA1.client
      .from("reservations")
      .delete({ count: "exact" })
      .eq("id", first!.id);
    expect(agentDeleted ?? 0, "an agent must not delete a reservation").toBe(0);

    const { error: lmDeleteErr, count: lmDeleted } = await lmA.client
      .from("reservations")
      .delete({ count: "exact" })
      .eq("id", first!.id);
    expect(lmDeleteErr, "a listing manager may delete").toBeNull();
    expect(lmDeleted ?? 0).toBe(1);

    // --- the nightly sweep: expires the lapsed hold and writes its event ----
    const eventsBefore = await svc
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("entity_type", "property")
      .eq("entity_id", prop!.id)
      .eq("event_type", "reservation_expired");

    await svc.rpc("expire_reservations");

    const { data: afterFirst } = await svc
      .from("reservations")
      .select("status, released_at, release_reason")
      .eq("id", second!.id)
      .single();
    expect(afterFirst!.status, "a lapsed hold is expired by the sweep").toBe("expired");
    expect(afterFirst!.released_at, "and stamped").not.toBeNull();

    const eventsAfterFirst = await svc
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("entity_type", "property")
      .eq("entity_id", prop!.id)
      .eq("event_type", "reservation_expired");
    expect(
      (eventsAfterFirst.count ?? 0) - (eventsBefore.count ?? 0),
      "the sweep writes exactly one event per expired hold",
    ).toBe(1);

    // IDEMPOTENCE: the second run of a night must change nothing. 0006's bug
    // was a reminder that fired once forever; 0012 and 0020 fixed the shape.
    await svc.rpc("expire_reservations");
    const eventsAfterSecond = await svc
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("entity_type", "property")
      .eq("entity_id", prop!.id)
      .eq("event_type", "reservation_expired");
    expect(
      eventsAfterSecond.count ?? 0,
      "a second sweep in the same night is a no-op",
    ).toBe(eventsAfterFirst.count ?? 0);

    // --- anon reaches nothing ------------------------------------------------
    const anon = anonClient();
    const { data: anonSees } = await anon.from("reservations").select("id");
    expect(anonSees ?? [], "anon must not read reservations").toHaveLength(0);

    const { data: chainOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(chainOk, "reservation events keep the hash chain intact").toBe(true);
  });

  it("32. reservation expiry warning: minted once, self-heals, and anon cannot run it", async () => {
    // 0047. The sweep is the unit under test; the RLS half is that `anon` and
    // `authenticated` cannot call it over PostgREST — the hole T-C4 had to
    // close on expire_reservations, and which this migration was written not to
    // repeat.
    const { data: prop } = await svc
      .from("properties")
      .insert({
        org_id: ORG_A,
        reference: `WARN-${run}`,
        kind: "standalone",
        property_type: "apartment",
        status: "available",
        title: { en: "Expiry warning fixture" },
      })
      .select("id")
      .single();

    // a live hold lapsing inside the 2-day window
    const soon = new Date(Date.now() + 36 * 3600e3).toISOString();
    const { data: res } = await svc
      .from("reservations")
      .insert({
        org_id: ORG_A,
        property_id: prop!.id,
        contact_id: contactA,
        status: "held",
        expires_at: soon,
      })
      .select("id")
      .single();

    const openWarnings = async () => {
      const { count } = await svc
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("reservation_id", res!.id)
        .eq("kind", "reservation_expiring")
        .eq("is_done", false);
      return count ?? 0;
    };

    await svc.rpc("warn_expiring_reservations", { p_org: ORG_A });
    expect(await openWarnings(), "a hold lapsing inside the window is warned").toBe(1);

    // idempotent: a second run the same night adds nothing
    await svc.rpc("warn_expiring_reservations", { p_org: ORG_A });
    expect(await openWarnings(), "a second sweep is a no-op").toBe(1);

    // the warning names the reservation and is assigned — a null assignee is
    // invisible on every surface, which is what the three-arm fallback prevents
    const { data: task } = await svc
      .from("tasks")
      .select("assignee_id, property_id, due_at")
      .eq("reservation_id", res!.id)
      .eq("kind", "reservation_expiring")
      .single();
    expect(task!.assignee_id, "the warning must have an assignee").not.toBeNull();
    expect(task!.property_id).toBe(prop!.id);

    // self-heal: releasing the hold closes the warning rather than deleting it
    await svc
      .from("reservations")
      .update({ status: "released", released_at: new Date().toISOString() })
      .eq("id", res!.id);
    await svc.rpc("warn_expiring_reservations", { p_org: ORG_A });
    expect(await openWarnings(), "a released hold closes its warning").toBe(0);

    const { count: closed } = await svc
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("reservation_id", res!.id)
      .eq("is_done", true);
    expect(closed ?? 0, "closed, never deleted — history keeps its shape").toBe(1);

    // --- the T-C4 lesson, asserted rather than assumed -----------------------
    const anon = anonClient();
    const { error: anonErr } = await anon.rpc("warn_expiring_reservations", { p_org: ORG_A });
    expect(anonErr, "anon must not be able to run the sweep").not.toBeNull();

    const { error: agentErr } = await agentA1.client.rpc("warn_expiring_reservations", {
      p_org: ORG_A,
    });
    expect(agentErr, "a signed-in agent must not be able to run it either").not.toBeNull();

    const { data: chainStillOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(chainStillOk, "warning events keep the hash chain intact").toBe(true);
  });

  it("33. task_kinds: readable, not writable, and the FK still refuses an unknown kind", async () => {
    // 0049 replaced tasks_kind_chk with a lookup table + FK. The CHECK's value
    // was a LOUD refusal, so this pins that the replacement refuses too — from
    // the APP's side, over PostgREST as a real user, which the migration's own
    // assertion block cannot cover.
    const { data: kinds, error: readErr } = await agentA1.client
      .from("task_kinds")
      .select("kind");
    expect(readErr, "an agent may read the vocabulary").toBeNull();
    expect((kinds ?? []).length, "all eleven kinds are visible").toBe(11);

    // The vocabulary is the system's: adding a kind is a code change, so not
    // even an admin edits it from the app.
    const { error: agentWriteErr } = await agentA1.client
      .from("task_kinds")
      .insert({ kind: "agent_invented", description: "nope", added_in: "x" });
    expect(agentWriteErr, "an agent must not add a kind").not.toBeNull();

    const { error: adminWriteErr } = await adminA.client
      .from("task_kinds")
      .insert({ kind: "admin_invented", description: "nope", added_in: "x" });
    expect(adminWriteErr, "not even an admin adds a kind from the app").not.toBeNull();

    // THE PROTECTION THE CHECK USED TO GIVE. A task with a kind nobody sweeps
    // is an orphan; 0045 exists because the old CHECK refused one loudly.
    const { error: badKindErr } = await adminA.client.from("tasks").insert({
      org_id: ORG_A,
      title: `RLS33-${run} bogus kind`,
      kind: "not_a_real_kind",
    });
    expect(badKindErr, "an unknown kind must be refused").not.toBeNull();
    expect(badKindErr!.message).toMatch(/tasks_kind_fkey|foreign key/i);

    // ...and a NULL kind must still be accepted: it is how a human-made task is
    // told apart from a system one, read by the /tasks badge and the CSV export.
    const { data: humanTask, error: nullKindErr } = await adminA.client
      .from("tasks")
      .insert({ org_id: ORG_A, title: `RLS33-${run} human task`, kind: null })
      .select("id")
      .single();
    expect(nullKindErr, "a human-made task has no kind and must still insert").toBeNull();
    expect(humanTask).not.toBeNull();

    // every kind a shipped sweep or action writes must exist in the table
    const shipped = [
      "mandate_renewal",
      "deal_no_contact",
      "viewing_feedback",
      "price_drop_match",
      "new_listing_match",
      "reservation_expiring",
      "bulk_price_drop_match",
      "installment_due",
      "key_recall",
      "viewing_no_show",
      "listing_status_check",
    ];
    expect((kinds ?? []).map((k) => k.kind).sort()).toEqual([...shipped].sort());

    // anon reaches nothing
    const anon = anonClient();
    const { data: anonSees } = await anon.from("task_kinds").select("kind");
    expect(anonSees ?? [], "anon must not read task_kinds").toHaveLength(0);
  });

  it("34. reservation_installments: org-scoped, delete-gated, and paid lines must state an amount", async () => {
    // 0050. The migration's own paid-coherence probe is SKIPPED on a database
    // with no reservations — which is exactly what CI applies migrations to —
    // so this is where that constraint is covered unconditionally.
    const { data: prop } = await svc
      .from("properties")
      .insert({
        org_id: ORG_A,
        reference: `INST-${run}`,
        kind: "standalone",
        property_type: "apartment",
        status: "available",
        title: { en: "Installment fixture" },
      })
      .select("id")
      .single();

    const { data: res } = await svc
      .from("reservations")
      .insert({
        org_id: ORG_A,
        property_id: prop!.id,
        status: "held",
        expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      })
      .select("id")
      .single();

    // --- an agent may write a schedule line ---------------------------------
    const { data: line, error: insertErr } = await agentA1.client
      .from("reservation_installments")
      .insert({
        org_id: ORG_A,
        reservation_id: res!.id,
        sort_order: 0,
        label: "Reservation",
        pct: 10,
        amount: 25000,
        milestone: "On reservation",
      })
      .select("id")
      .single();
    expect(insertErr, "an agent may record a schedule").toBeNull();

    // --- THE COHERENCE CONSTRAINT, covered unconditionally ------------------
    // A line marked paid with no amount makes "what is outstanding?"
    // unanswerable, which is the whole reason the constraint exists.
    const { error: paidNoAmountErr } = await agentA1.client
      .from("reservation_installments")
      .update({ paid_at: new Date().toISOString() })
      .eq("id", line!.id);
    expect(paidNoAmountErr, "paid with no amount must be refused").not.toBeNull();
    expect(paidNoAmountErr!.message).toMatch(/installment_paid_coherent/);

    const { error: amountNoPaidErr } = await agentA1.client
      .from("reservation_installments")
      .update({ paid_amount: 25000 })
      .eq("id", line!.id);
    expect(amountNoPaidErr, "an amount with no paid_at must be refused too").not.toBeNull();

    // both together is the only accepted shape
    const { error: bothErr } = await agentA1.client
      .from("reservation_installments")
      .update({ paid_at: new Date().toISOString(), paid_amount: 25000 })
      .eq("id", line!.id);
    expect(bothErr, "paid_at and paid_amount together is accepted").toBeNull();

    // --- one line per position ----------------------------------------------
    const { error: dupErr } = await agentA1.client.from("reservation_installments").insert({
      org_id: ORG_A,
      reservation_id: res!.id,
      sort_order: 0,
      label: "Duplicate position",
      amount: 1,
    });
    expect(dupErr, "two lines cannot share a position").not.toBeNull();

    // --- cross-org isolation -------------------------------------------------
    const { data: bSees } = await agentB.client
      .from("reservation_installments")
      .select("id")
      .eq("id", line!.id);
    expect(bSees ?? [], "org B must not see org A's schedule").toHaveLength(0);

    // --- DELETE is gated to admin / listing manager -------------------------
    const { count: agentDeleted } = await agentA1.client
      .from("reservation_installments")
      .delete({ count: "exact" })
      .eq("id", line!.id);
    expect(agentDeleted ?? 0, "an agent must not delete a schedule line").toBe(0);

    const { error: lmDelErr, count: lmDeleted } = await lmA.client
      .from("reservation_installments")
      .delete({ count: "exact" })
      .eq("id", line!.id);
    expect(lmDelErr, "a listing manager may delete").toBeNull();
    expect(lmDeleted ?? 0).toBe(1);

    // --- the schedule dies with its reservation, never outlives it ----------
    const { data: survivor } = await svc
      .from("reservation_installments")
      .insert({
        org_id: ORG_A,
        reservation_id: res!.id,
        sort_order: 1,
        label: "Contract",
        amount: 75000,
      })
      .select("id")
      .single();
    await svc.from("reservations").delete().eq("id", res!.id);
    const { data: orphan } = await svc
      .from("reservation_installments")
      .select("id")
      .eq("id", survivor!.id);
    expect(orphan ?? [], "deleting a reservation cascades to its schedule").toHaveLength(0);

    // --- anon reaches nothing ------------------------------------------------
    const anonClient2 = anonClient();
    const { data: anonLines } = await anonClient2.from("reservation_installments").select("id");
    expect(anonLines ?? [], "anon must not read schedules").toHaveLength(0);
  });


  it("35. instalment reminders: chase converted sales and overdue lines, self-heal, and anon cannot run it", async () => {
    // 0051. The migration's own mint/idempotence probe is SKIPPED on a database
    // with no chaseable instalment — which is exactly what CI applies
    // migrations to — so this is where the sweep is covered unconditionally.
    //
    // THE ASSERTION THAT MATTERS MOST is the `converted` one. 0047 warns on
    // LIVE_RESERVATION_STATUSES (held + confirmed); reusing that definition here
    // would stop chasing money the moment a sale is signed, which is when a
    // Cyprus buyer spends almost the whole payment plan. If someone ever
    // "tidies" this sweep to match 0047, that expectation is what fails.
    const cyprusDay = (offset: number) =>
      new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

    const mkProperty = async (suffix: string) => {
      const { data } = await svc
        .from("properties")
        .insert({
          org_id: ORG_A,
          reference: `DUE-${run}-${suffix}`,
          kind: "standalone",
          property_type: "apartment",
          status: "available",
          title: { en: `Instalment reminder fixture ${suffix}` },
        })
        .select("id")
        .single();
      return data!.id as string;
    };

    const mkReservation = async (propertyId: string, status: string) => {
      const { data } = await svc
        .from("reservations")
        .insert({
          org_id: ORG_A,
          property_id: propertyId,
          contact_id: contactA,
          status,
          expires_at: new Date(Date.now() + 90 * 864e5).toISOString(),
        })
        .select("id")
        .single();
      return data!.id as string;
    };

    const mkLine = async (
      reservationId: string,
      sortOrder: number,
      label: string,
      dueDate: string | null,
    ) => {
      const { data, error } = await svc
        .from("reservation_installments")
        .insert({
          org_id: ORG_A,
          reservation_id: reservationId,
          sort_order: sortOrder,
          label,
          amount: 50000,
          due_date: dueDate,
        })
        .select("id")
        .single();
      expect(error, `line ${label} must insert`).toBeNull();
      return data!.id as string;
    };

    const countFor = async (installmentId: string, done: boolean) => {
      const { count } = await svc
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("installment_id", installmentId)
        .eq("kind", "installment_due")
        .eq("is_done", done);
      return count ?? 0;
    };
    const openFor = (id: string) => countFor(id, false);
    const closedFor = (id: string) => countFor(id, true);

    const heldProp = await mkProperty("held");
    const convProp = await mkProperty("conv");
    const goneProp = await mkProperty("gone");

    const heldRes = await mkReservation(heldProp, "held");
    // `converted` is TERMINAL and means the sale went ahead — the state a buyer
    // paying 10/30/60 across two years of construction sits in throughout.
    const convRes = await mkReservation(convProp, "converted");
    const goneRes = await mkReservation(goneProp, "released");

    const dueSoon = await mkLine(heldRes, 0, "Deposit", cyprusDay(3));
    const dueFar = await mkLine(heldRes, 1, "Contract", cyprusDay(30));
    const overdue = await mkLine(convRes, 0, "Stage 2", cyprusDay(-10));
    const onDeadHold = await mkLine(goneRes, 0, "Deposit", cyprusDay(3));
    const undated = await mkLine(heldRes, 2, "Handover", null);

    await svc.rpc("remind_due_installments", { p_org: ORG_A });

    expect(await openFor(dueSoon), "a line due inside the window is chased").toBe(1);
    expect(await openFor(dueFar), "a line 30 days out is not chased yet").toBe(0);
    expect(
      await openFor(overdue),
      "an OVERDUE line on a CONVERTED sale is chased — reusing LIVE_RESERVATION_STATUSES here would silently stop chasing signed sales",
    ).toBe(1);
    expect(await openFor(onDeadHold), "a released hold is not chased").toBe(0);
    expect(await openFor(undated), "a line with no agreed date cannot be chased").toBe(0);

    // idempotent: a second run the same night adds nothing
    await svc.rpc("remind_due_installments", { p_org: ORG_A });
    expect(await openFor(dueSoon), "a second sweep is a no-op").toBe(1);
    expect(await openFor(overdue), "a second sweep is a no-op for overdue too").toBe(1);

    // the reminder falls due exactly when the money does, and is assigned — a
    // null assignee is invisible on every surface, which the three-arm fallback
    // exists to prevent
    const { data: task } = await svc
      .from("tasks")
      .select("assignee_id, property_id, reservation_id, due_at, title")
      .eq("installment_id", dueSoon)
      .single();
    expect(task!.assignee_id, "the reminder must have an assignee").not.toBeNull();
    expect(task!.property_id).toBe(heldProp);
    expect(task!.reservation_id).toBe(heldRes);
    expect(task!.title).toContain("Deposit");

    // --- self-heal: paying closes the chase, never deletes it ---------------
    await svc
      .from("reservation_installments")
      .update({ paid_at: new Date().toISOString(), paid_amount: 50000 })
      .eq("id", dueSoon);
    await svc.rpc("remind_due_installments", { p_org: ORG_A });
    expect(await openFor(dueSoon), "a paid line stops being chased").toBe(0);
    expect(await closedFor(dueSoon), "closed, never deleted — history keeps its shape").toBe(1);

    // --- re-agreeing the date supersedes the old cycle and arms a new one ---
    await svc
      .from("reservation_installments")
      .update({ due_date: cyprusDay(5) })
      .eq("id", overdue);
    await svc.rpc("remind_due_installments", { p_org: ORG_A });
    expect(await closedFor(overdue), "the old cycle's reminder is closed").toBe(1);
    expect(await openFor(overdue), "the new date arms a fresh reminder").toBe(1);

    // --- the sale falls through: chasing must stop --------------------------
    await svc
      .from("reservations")
      .update({ status: "released", released_at: new Date().toISOString() })
      .eq("id", convRes);
    await svc.rpc("remind_due_installments", { p_org: ORG_A });
    expect(await openFor(overdue), "a released sale is no longer chased").toBe(0);

    // --- the T-C4 lesson, asserted rather than assumed -----------------------
    const anon = anonClient();
    const { error: anonErr } = await anon.rpc("remind_due_installments", { p_org: ORG_A });
    expect(anonErr, "anon must not be able to run the sweep").not.toBeNull();

    const { error: agentErr } = await agentA1.client.rpc("remind_due_installments", {
      p_org: ORG_A,
    });
    expect(agentErr, "a signed-in agent must not be able to run it either").not.toBeNull();

    const { data: chainOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(chainOk, "reminder events keep the hash chain intact").toBe(true);
  });


  it("36. nudge thresholds: the sweeps follow the setting, and a threshold change is not logged as contact", async () => {
    // 0052. Two things are under test and they are different in kind:
    //   * RLS — an agent may READ the thresholds (the Log contact dialog states
    //     the number) but must not WRITE them, and `nudge_threshold()` must not
    //     be reachable over PostgREST at all.
    //   * BEHAVIOUR — the sweeps must actually read the row rather than keeping
    //     their old constants, which a migration that only rewrites function
    //     bodies could very easily fail to achieve without anyone noticing.
    const { data: before } = await svc
      .from("cyprus_config")
      .select("value")
      .eq("key", "nudge_thresholds")
      .single();
    expect(before, "0052 must have seeded the row").not.toBeNull();

    const setThresholds = async (v: Record<string, number>) => {
      const { error } = await svc.from("cyprus_config").update({ value: v }).eq("key", "nudge_thresholds");
      expect(error).toBeNull();
    };

    try {
      // --- an agent may read, because the deal page states the number --------
      const { data: agentSees } = await agentA1.client
        .from("cyprus_config")
        .select("value")
        .eq("key", "nudge_thresholds")
        .maybeSingle();
      expect(agentSees, "an agent must be able to read the thresholds").not.toBeNull();

      // --- but only an admin may change them --------------------------------
      const { count: agentWrote } = await agentA1.client
        .from("cyprus_config")
        .update({ value: { deal_no_contact_days: 1 } }, { count: "exact" })
        .eq("key", "nudge_thresholds");
      expect(agentWrote ?? 0, "an agent must not change a threshold").toBe(0);

      // --- the reader is not an API ------------------------------------------
      const anon = anonClient();
      const { error: anonErr } = await anon.rpc("nudge_threshold", {
        p_key: "deal_no_contact_days",
        p_fallback: 14,
      });
      expect(anonErr, "anon must not run the reader").not.toBeNull();
      const { error: agentRpcErr } = await agentA1.client.rpc("nudge_threshold", {
        p_key: "deal_no_contact_days",
        p_fallback: 14,
      });
      expect(agentRpcErr, "a signed-in agent must not run it either").not.toBeNull();

      // --- fixture: one open deal, silent for five days ----------------------
      const { data: stage } = await svc
        .from("deal_stages")
        .select("id")
        .eq("org_id", ORG_A)
        .order("sort_order")
        .limit(1)
        .single();

      const { data: deal, error: dealErr } = await svc
        .from("deals")
        .insert({
          org_id: ORG_A,
          stage_id: stage!.id,
          title: `NUDGE-${run} threshold deal`,
          status: "open",
          last_contact_at: new Date(Date.now() - 5 * 864e5).toISOString(),
          created_at: new Date(Date.now() - 40 * 864e5).toISOString(),
        })
        .select("id")
        .single();
      expect(dealErr).toBeNull();

      const openNudges = async () => {
        const { count } = await svc
          .from("tasks")
          .select("id", { count: "exact", head: true })
          .eq("deal_id", deal!.id)
          .eq("kind", "deal_no_contact")
          .eq("is_done", false);
        return count ?? 0;
      };
      // Filter on the PAYLOAD, not on a time-ordered window. Many events share
      // a timestamp inside one sweep, so "order by occurred_at, take the top
      // few, then search" quietly misses the row it is looking for.
      const latestSupersedeReason = async () => {
        const { data } = await svc
          .from("events")
          .select("payload, occurred_at")
          .eq("event_type", "superseded")
          .eq("entity_type", "task")
          .filter("payload->>deal_id", "eq", deal!.id)
          .order("occurred_at", { ascending: false })
          .limit(1);
        return (data?.[0]?.payload as { reason?: string } | undefined)?.reason ?? null;
      };

      // five days of silence is inside the shipped 14, so nothing fires
      await setThresholds({
        deal_no_contact_days: 14,
        viewing_feedback_hours: 48,
        reservation_expiry_days: 2,
        installment_due_days: 7,
      });
      await svc.rpc("create_followup_nudges", { p_org: ORG_A });
      expect(await openNudges(), "at 14 days a five-day silence is not chased").toBe(0);

      // --- tune it down and the sweep follows --------------------------------
      await setThresholds({
        deal_no_contact_days: 3,
        viewing_feedback_hours: 48,
        reservation_expiry_days: 2,
        installment_due_days: 7,
      });
      await svc.rpc("create_followup_nudges", { p_org: ORG_A });
      expect(await openNudges(), "at 3 days the same deal IS chased").toBe(1);

      // the title states the CURRENT threshold, not a baked-in 14
      const { data: task } = await svc
        .from("tasks")
        .select("title")
        .eq("deal_id", deal!.id)
        .eq("kind", "deal_no_contact")
        .single();
      expect(task!.title).toContain("No contact in 3 days");

      // --- THE REASON. Widening the window moves the boundary, which trips the
      // self-heal. Before 0052 that could only mean contact was logged, so the
      // sweep asserted `deal_contacted`; asserting it now would write a false
      // statement into an append-only log that can never be corrected.
      await setThresholds({
        deal_no_contact_days: 30,
        viewing_feedback_hours: 48,
        reservation_expiry_days: 2,
        installment_due_days: 7,
      });
      await svc.rpc("create_followup_nudges", { p_org: ORG_A });
      expect(await openNudges(), "widening the window closes the open nudge").toBe(0);
      expect(
        await latestSupersedeReason(),
        "a threshold change must NOT be recorded as the deal having been contacted",
      ).toBe("threshold_changed");

      // --- a real contact still reads as a real contact ----------------------
      // a FRESH boundary: reusing one a task already carried would hit the
      // deliberate ignore-is_done guard (0006) and mint nothing to supersede
      await setThresholds({
        deal_no_contact_days: 3,
        viewing_feedback_hours: 48,
        reservation_expiry_days: 2,
        installment_due_days: 7,
      });
      await svc
        .from("deals")
        .update({ last_contact_at: new Date(Date.now() - 4 * 864e5).toISOString() })
        .eq("id", deal!.id);
      await svc.rpc("create_followup_nudges", { p_org: ORG_A });
      expect(await openNudges(), "a fresh boundary re-arms").toBe(1);

      await svc
        .from("deals")
        .update({ last_contact_at: new Date().toISOString() })
        .eq("id", deal!.id);
      await svc.rpc("create_followup_nudges", { p_org: ORG_A });
      expect(await openNudges(), "logging contact closes it").toBe(0);
      expect(await latestSupersedeReason(), "and that one IS a contact").toBe("deal_contacted");

      // --- corrupt config must not stop a sweep ------------------------------
      // reachable state: /settings/cyprus-config edits this row as raw JSON
      await svc
        .from("cyprus_config")
        .update({ value: { deal_no_contact_days: "garbage", viewing_feedback_hours: 0 } })
        .eq("key", "nudge_thresholds");
      const { error: sweepErr } = await svc.rpc("create_followup_nudges", { p_org: ORG_A });
      expect(sweepErr, "a corrupt threshold must not break the sweep").toBeNull();

      const { data: chainOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
      expect(chainOk, "threshold events keep the hash chain intact").toBe(true);
    } finally {
      // restore, even if an expectation above failed — this row is global and
      // the suite is sequential, so leaving it tuned would poison later runs
      await svc
        .from("cyprus_config")
        .update({ value: before!.value })
        .eq("key", "nudge_thresholds");
    }
  });


  it("37. key recall: raised when a mandate ends, survives expire_mandates(), and self-heals", async () => {
    // 0053. The assertion that earns its keep is the expire_mandates() one.
    // `tasks.mandate_id` carried exactly one kind until now, and BOTH supersede
    // paths matched on mandate_id alone — so a key_recall task, which by
    // definition hangs off a mandate that is no longer active, was completed on
    // the next sweep. The feature would have looked like it worked (task
    // appears, event written) while leaving nobody anything to do.
    const { data: prop } = await svc
      .from("properties")
      .insert({
        org_id: ORG_A,
        reference: `KEYS-${run}`,
        kind: "standalone",
        property_type: "apartment",
        status: "available",
        title: { en: "Key recall fixture" },
        // gives the three-arm assignee fallback its FIRST arm to land on, and
        // makes the task visible to that agent — tasks_select lets an agent see
        // only what they are assigned or created (admins see everything)
        assigned_agent_id: agentA1.id,
      })
      .select("id")
      .single();

    const { data: mandate, error: mandateErr } = await svc
      .from("mandates")
      .insert({
        org_id: ORG_A,
        property_id: prop!.id,
        status: "terminated",
        type: "open",
        start_date: new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10),
        expiry_date: new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10),
      })
      .select("id")
      .single();
    expect(mandateErr, "the fixture mandate must insert").toBeNull();

    const mkKey = async (code: string, status: string) => {
      const { data, error } = await svc
        .from("property_keys")
        .insert({ org_id: ORG_A, property_id: prop!.id, key_code: `${code}-${run}`, status })
        .select("id")
        .single();
      expect(error, `key ${code} must insert`).toBeNull();
      return data!.id as string;
    };

    const heldKey = await mkKey("K1", "checked_out");
    const officeKey = await mkKey("K2", "in_office");
    // neither of these is recallable: one is already where it belongs, the
    // other cannot be handed back at all
    await mkKey("K3", "with_owner");
    await mkKey("K4", "lost");

    const openRecalls = async () => {
      const { count } = await svc
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("mandate_id", mandate!.id)
        .eq("kind", "key_recall")
        .eq("is_done", false);
      return count ?? 0;
    };
    const closedRecalls = async () => {
      const { count } = await svc
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("mandate_id", mandate!.id)
        .eq("kind", "key_recall")
        .eq("is_done", true);
      return count ?? 0;
    };

    // --- the reader is not an API ------------------------------------------
    const anon = anonClient();
    const { error: anonErr } = await anon.rpc("raise_key_recall_tasks", {
      p_mandate: mandate!.id,
    });
    expect(anonErr, "anon must not raise recall tasks").not.toBeNull();
    const { error: agentRpcErr } = await agentA1.client.rpc("raise_key_recall_tasks", {
      p_mandate: mandate!.id,
    });
    expect(
      agentRpcErr,
      "a signed-in agent must not either — it is SECURITY DEFINER and takes any mandate id",
    ).not.toBeNull();

    // --- raised once --------------------------------------------------------
    const { data: raised } = await svc.rpc("raise_key_recall_tasks", { p_mandate: mandate!.id });
    expect(raised, "one task for one ended mandate").toBe(1);
    expect(await openRecalls()).toBe(1);

    // the title counts only what the agency actually holds
    const { data: task } = await svc
      .from("tasks")
      .select("title, assignee_id, property_id")
      .eq("mandate_id", mandate!.id)
      .eq("kind", "key_recall")
      .single();
    expect(task!.title, "with_owner and lost keys are not chased").toContain("2 keys still held");
    expect(
      task!.assignee_id,
      "the property's agent is the first arm of the fallback",
    ).toBe(agentA1.id);
    expect(task!.property_id).toBe(prop!.id);

    // --- idempotent ---------------------------------------------------------
    const { data: again } = await svc.rpc("raise_key_recall_tasks", { p_mandate: mandate!.id });
    expect(again, "a second call raises nothing").toBe(0);

    // --- THE REGRESSION PIN -------------------------------------------------
    // expire_mandates() takes no org argument, so this is a global sweep; the
    // assertion is deliberately scoped to this fixture's mandate.
    await svc.rpc("expire_mandates");
    expect(
      await openRecalls(),
      "expire_mandates() must NOT complete the recall task — without the kind filter it matched on mandate_id alone and closed it every night",
    ).toBe(1);

    // an agent can see it on their own task list
    const { data: agentSees } = await agentA1.client
      .from("tasks")
      .select("id")
      .eq("mandate_id", mandate!.id)
      .eq("kind", "key_recall");
    expect(
      (agentSees ?? []).length,
      "the assigned agent sees it on their own task list",
    ).toBe(1);

    // --- self-heal: the held keys go back ----------------------------------
    await svc.from("property_keys").update({ status: "with_owner" }).eq("id", heldKey);
    await svc.rpc("raise_key_recall_tasks", { p_mandate: mandate!.id });
    expect(await openRecalls(), "one key back is not all of them").toBe(1);

    await svc.from("property_keys").update({ status: "with_owner" }).eq("id", officeKey);
    await svc.rpc("raise_key_recall_tasks", { p_mandate: mandate!.id });
    expect(await openRecalls(), "nothing held any more — the chase stops").toBe(0);
    expect(await closedRecalls(), "closed, never deleted — history keeps its shape").toBe(1);

    // --- cross-org isolation -------------------------------------------------
    const { data: bSees } = await agentB.client
      .from("tasks")
      .select("id")
      .eq("mandate_id", mandate!.id);
    expect(bSees ?? [], "org B must not see org A's recall task").toHaveLength(0);

    const { data: chainOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(chainOk, "recall events keep the hash chain intact").toBe(true);
  });


  it("38. location_approx: cannot claim an approximate point without a point", async () => {
    // 0054. The migration proves the constraint as `postgres`; this proves it
    // from the APP's side, over PostgREST as a real user, which is the path a
    // bad payload would actually arrive on.
    const { data: prop, error: insErr } = await agentA1.client
      .from("properties")
      .insert({
        org_id: ORG_A,
        reference: `APPROX-${run}`,
        kind: "standalone",
        property_type: "apartment",
        status: "available",
        title: { en: "Approximate location fixture" },
        assigned_agent_id: agentA1.id,
      })
      .select("id, location_approx")
      .single();
    expect(insErr, "the fixture must insert").toBeNull();
    expect(prop!.location_approx, "every row starts exact — 0054 flags nothing").toBe(false);

    // --- a flag with no point is refused --------------------------------
    const { error: danglingErr } = await agentA1.client
      .from("properties")
      .update({ location_approx: true })
      .eq("id", prop!.id);
    expect(
      danglingErr,
      "a flag qualifying nothing would read as knowledge we do not have",
    ).not.toBeNull();
    expect(danglingErr!.message).toMatch(/location_approx_needs_point|violates check/i);

    // --- with a point, it is accepted -----------------------------------
    const { error: withPointErr } = await agentA1.client
      .from("properties")
      .update({
        location: "SRID=4326;POINT(32.4297 34.7720)",
        location_approx: true,
      })
      .eq("id", prop!.id);
    expect(withPointErr, "a centroid WITH a point is the whole feature").toBeNull();

    // --- clearing the point while still flagged is refused ---------------
    const { error: clearErr } = await agentA1.client
      .from("properties")
      .update({ location: null })
      .eq("id", prop!.id);
    expect(
      clearErr,
      "clearing the point must clear the flag too — the app does this, and the DB refuses the incoherent half",
    ).not.toBeNull();

    // --- clearing both together is fine ----------------------------------
    const { error: bothErr } = await agentA1.client
      .from("properties")
      .update({ location: null, location_approx: false })
      .eq("id", prop!.id);
    expect(bothErr, "clearing both together is coherent").toBeNull();

    const { data: chainOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(chainOk).toBe(true);
  });

  it("38. C4 reporting engine: exact figures over a synthetic fixture with known answers", async () => {
    /**
     * 0065. The brief is explicit that "a reporting engine tested only against
     * zeros is a reporting engine tested against nothing" — production holds 1
     * property and 1 deal. So this seeds a scenario whose answers are known by
     * construction and asserts them EXACTLY.
     *
     * THE WINDOW IS HISTORICAL (March 2024) ON PURPOSE. ORG_A already carries
     * whatever the rest of this suite created, and a "last 30 days" window
     * would mix it in and make exact assertions impossible. leads, deals,
     * viewings and price_history all accept an explicit timestamp, so the
     * fixture lives somewhere nothing else does.
     *
     * `events` deliberately is NOT back-dated: occurred_at is settable, but a
     * back-dated event creates the occurred_at/id inversion that
     * events_partition_health() reports and test 21d asserts is empty (0063).
     * Stage conversion therefore uses unique stage NAMES in the live window
     * instead — test 39.
     */
    const FROM = "2024-03-01T00:00:00.000Z";
    const TO = "2024-04-01T00:00:00.000Z";
    const win = { p_from: FROM, p_to: TO };

    // IDEMPOTENCE. CI builds a fresh database, but this suite is also run
    // repeatedly against a long-lived local stack, and a fixed window plus
    // absolute assertions is only correct if the window starts empty — a second
    // run otherwise reads 6 leads where it asserts 3. Clear the window first, in
    // FK order (leads reference deals via converted_deal_id). `events` is never
    // touched: it is append-only, and test 39 adds to the live window instead.
    await svc.from("leads").delete().eq("org_id", ORG_A).gte("received_at", FROM).lt("received_at", TO);
    await svc.from("viewings").delete().eq("org_id", ORG_A).gte("scheduled_at", FROM).lt("scheduled_at", TO);
    await svc.from("price_history").delete().eq("org_id", ORG_A).gte("changed_at", FROM).lt("changed_at", TO);
    await svc.from("deals").delete().eq("org_id", ORG_A).gte("created_at", FROM).lt("created_at", TO);

    // --- deals: two won (10 and 20 days), one lost (10 days) ----------------
    const mkDeal = async (
      agent: string,
      created: string,
      close: { won_at: string } | { lost_at: string },
      value: number,
      finalValue: number | null = null,
    ) => {
      const status = "won_at" in close ? ("won" as const) : ("lost" as const);
      const { data, error } = await svc
        .from("deals")
        .insert({
          org_id: ORG_A,
          deal_type: "sale",
          stage_id: stageSaleNew,
          title: `C4-${run}-${status}-${created}`,
          agent_id: agent,
          expected_value: value,
          final_value: finalValue,
          status,
          created_at: created,
          ...close,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    };

    const wonDeal1 = await mkDeal(
      agentA1.id,
      "2024-03-01T00:00:00Z",
      { won_at: "2024-03-11T00:00:00Z" },
      100000,
    );
    await mkDeal(agentA1.id, "2024-03-01T00:00:00Z", { won_at: "2024-03-21T00:00:00Z" }, 200000);
    // 0076: final_value ≠ expected_value — the sums must prefer the CONFIRMED
    // 250000 over the stale 999999 estimate, or the coalesce is unverified
    await mkDeal(
      agentA1.id,
      "2024-03-01T00:00:00Z",
      { won_at: "2024-03-25T00:00:00Z" },
      999999,
      250000,
    );
    await mkDeal(agentA2.id, "2024-03-05T00:00:00Z", { lost_at: "2024-03-15T00:00:00Z" }, 50000);

    // --- leads: 3 website (2 answered at 30 and 90 min), 1 referral --------
    const mkLead = async (
      source: "website" | "referral",
      agent: string,
      received: string,
      answered: string | null,
      dealId: string | null,
    ) => {
      const { error } = await svc.from("leads").insert({
        org_id: ORG_A,
        contact_id: contactA,
        source,
        channel: "email",
        status: dealId ? "converted" : "new",
        received_at: received,
        first_response_at: answered,
        assigned_agent_id: agent,
        converted_deal_id: dealId,
      });
      if (error) throw error;
    };
    await mkLead("website", agentA1.id, "2024-03-02T10:00:00Z", "2024-03-02T10:30:00Z", wonDeal1);
    await mkLead("website", agentA1.id, "2024-03-03T10:00:00Z", "2024-03-03T11:30:00Z", null);
    await mkLead("website", agentA1.id, "2024-03-04T10:00:00Z", null, null);
    // 0076 (RPT-1): answered BEFORE received — a backdated import's clock
    // anomaly. Counts as answered ("did the desk reply?" is unchanged) but
    // must be EXCLUDED from the average, or one bad row drags it negative.
    await mkLead("website", agentA1.id, "2024-03-05T10:00:00Z", "2024-03-05T08:00:00Z", null);
    await mkLead("referral", agentA2.id, "2024-03-05T10:00:00Z", null, null);

    // --- viewings: 2 completed for agentA1, 1 cancelled (must not count) ----
    for (const [when, status] of [
      ["2024-03-06T09:00:00Z", "completed"],
      ["2024-03-07T09:00:00Z", "completed"],
      ["2024-03-08T09:00:00Z", "cancelled"],
    ] as const) {
      const { error } = await svc.from("viewings").insert({
        org_id: ORG_A,
        property_id: propA1,
        contact_id: contactA,
        agent_id: agentA1.id,
        scheduled_at: when,
        status,
      });
      if (error) throw error;
    }

    // --- price history: two 10% cuts on one property, plus a RISE ----------
    for (const [at, oldP, newP] of [
      ["2024-03-02T12:00:00Z", 500000, 450000],
      ["2024-03-10T12:00:00Z", 450000, 405000],
      ["2024-03-20T12:00:00Z", 405000, 420000], // a rise — must be excluded
    ] as const) {
      const { error } = await svc.from("price_history").insert({
        org_id: ORG_A,
        property_id: propA1,
        old_price: oldP,
        new_price: newP,
        changed_at: at,
        changed_by: agentA1.id,
      });
      if (error) throw error;
    }

    // ======================= agent performance ============================
    const perf = await svc.rpc("report_agent_performance", win);
    expect(perf.error).toBeNull();
    const rows = perf.data as unknown as Array<Record<string, number | string | null>>;
    const a1 = rows.find((r) => r.agent_id === agentA1.id)!;
    const a2 = rows.find((r) => r.agent_id === agentA2.id)!;

    expect(a1.leads_assigned, "agentA1 got 4 leads in March 2024").toBe(4);
    expect(a1.leads_answered, "3 answered — the negative-interval row still counts here").toBe(3);
    expect(
      Number(a1.avg_first_response_min),
      "30 and 90 min average to 60 — the negative interval is EXCLUDED (0076/RPT-1)",
    ).toBeCloseTo(60, 6);
    expect(a1.viewings_completed, "the cancelled viewing must not count").toBe(2);
    expect(a1.deals_won).toBe(3);
    expect(
      Number(a1.won_value),
      "100000 + 200000 + coalesce(250000, 999999) — final_value wins (0076)",
    ).toBe(550000);
    expect(a1.deals_lost).toBe(0);

    expect(a2.leads_assigned).toBe(1);
    expect(a2.leads_answered, "the referral lead was never answered").toBe(0);
    expect(a2.avg_first_response_min, "no answered leads means no average, not zero").toBeNull();
    expect(a2.deals_won).toBe(0);
    expect(a2.deals_lost).toBe(1);

    // ============================ source ROI ==============================
    const roi = await svc.rpc("report_source_roi", win);
    const bySource = Object.fromEntries(
      (roi.data as unknown as Array<Record<string, number | string | null>>).map((r) => [
        r.source,
        r,
      ]),
    );
    expect(bySource.website.leads).toBe(4);
    expect(bySource.website.converted).toBe(1);
    expect(bySource.website.won).toBe(1);
    expect(Number(bySource.website.won_value)).toBe(100000);
    expect(Number(bySource.website.convert_rate)).toBeCloseTo(1 / 4, 10);
    expect(Number(bySource.website.win_rate)).toBe(1);

    expect(bySource.referral.leads, "a source that produced nothing is KEPT").toBe(1);
    expect(bySource.referral.converted).toBe(0);
    expect(bySource.referral.win_rate, "0 conversions means no win rate, not 0/0").toBeNull();

    // ========================== time to close =============================
    const ttc = (await svc.rpc("report_time_to_close", win)).data as unknown as {
      won: { count: number; avg_days: number; median_days: number; p90_days: number };
      lost: { count: number; avg_days: number };
    };
    expect(ttc.won.count).toBe(3);
    expect(Number(ttc.won.avg_days), "10, 20 and 24 days").toBeCloseTo(18, 6);
    expect(Number(ttc.won.median_days)).toBeCloseTo(20, 6);
    expect(ttc.lost.count).toBe(1);
    expect(Number(ttc.lost.avg_days)).toBeCloseTo(10, 6);

    // ========================= price reductions ===========================
    const pr = (await svc.rpc("report_price_reductions", win)).data as unknown as {
      reductions: number;
      properties_affected: number;
      avg_cut_fraction: number;
      total_cut_amount: number;
      repeat_cuts: Array<{ property_id: string; cuts: number; total_cut: number }>;
    };
    expect(pr.reductions, "two cuts; the price RISE must be excluded").toBe(2);
    expect(pr.properties_affected).toBe(1);
    expect(Number(pr.avg_cut_fraction), "both cuts were exactly 10%").toBeCloseTo(0.1, 10);
    expect(Number(pr.total_cut_amount)).toBe(95000);
    expect(pr.repeat_cuts).toHaveLength(1);
    expect(pr.repeat_cuts[0].property_id).toBe(propA1);
    expect(pr.repeat_cuts[0].cuts).toBe(2);

    // ===================== cross-org isolation ============================
    // The whole fixture is ORG_A's. Org B must see none of it — the assertion
    // the brief calls for, and the reason none of these is SECURITY DEFINER.
    const bPerf = (await agentB.client.rpc("report_agent_performance", win))
      .data as unknown as unknown[];
    expect(bPerf, "org B must not see org A's agents").toEqual([]);
    const bRoi = (await agentB.client.rpc("report_source_roi", win)).data as unknown as unknown[];
    expect(bRoi, "org B must not see org A's lead sources").toEqual([]);
    const bTtc = (await agentB.client.rpc("report_time_to_close", win)).data as unknown as {
      won: { count: number };
    };
    expect(bTtc.won.count, "org B must not see org A's closes").toBe(0);
    const bPr = (await agentB.client.rpc("report_price_reductions", win)).data as unknown as {
      reductions: number;
    };
    expect(bPr.reductions, "org B must not see org A's price history").toBe(0);

    // ===================== anon reaches nothing ===========================
    const anon = anonClient();
    for (const fn of [
      "report_agent_performance",
      "report_source_roi",
      "report_time_to_close",
      "report_stage_conversion",
      "report_price_reductions",
    ] as const) {
      const denied = await anon.rpc(fn, win);
      expect(denied.error, `anon must not execute ${fn}`).not.toBeNull();
    }
    expect(
      (await anon.rpc("report_citation")).error,
      "anon must not execute report_citation",
    ).not.toBeNull();
  });

  it("39. C4 stage conversion is derived from events, and declares which key it joins on", async () => {
    // 0065. Stage NAMES, not ids: move_deal_to_stage (0011) logs
    // {'from': <name>, 'to': <name>}. The first draft of this report read
    // payload->>'from_stage_id' and would have returned zeros forever, so this
    // asserts against the shape the WRITER actually produces.
    //
    // Unique names in the LIVE window, because back-dating an event would make
    // events_partition_health() report an inversion (test 21d).
    const S1 = `C4-${run}-Qualified`;
    const S2 = `C4-${run}-Offer`;
    const mkMove = async (entityId: string, from: string | null, to: string) => {
      const { error } = await svc.from("events").insert({
        org_id: ORG_A,
        actor_id: agentA1.id,
        entity_type: "deal",
        entity_id: entityId,
        event_type: "stage_changed",
        payload: from === null ? { to } : { from, to },
      });
      if (error) throw error;
    };

    // three distinct deals reach S1; two of them go on to S2
    await mkMove(dealA1, null, S1);
    await mkMove(dealA1, S1, S2);
    await mkMove(propA1, null, S1); // a second distinct entity id
    await mkMove(propA1, S1, S2);
    await mkMove(contactA, null, S1); // a third that stops at S1
    // 0076 (RPT-2): a PRE-WINDOW entrant departing in-window — its entry event
    // is outside this window, so it must NOT count as advanced. Before 0076 it
    // pushed S1 to 3/3; unguarded, one more such row pushed the rate past 100%.
    await mkMove(agentA1.id, S1, S2);

    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await svc.rpc("report_stage_conversion", { p_from: from, p_to: to });
    expect(res.error).toBeNull();
    const conv = res.data as unknown as {
      derived_from: string;
      stage_key: string;
      stages: Array<{ stage: string; entered: number; advanced: number; advance_rate: number }>;
      transitions: Array<{ from: string | null; to: string; deals: number }>;
      outcomes: { won: number; lost: number };
      note: string;
    };

    expect(conv.derived_from, "this is the one report re-derivable from the chain").toBe("events");
    expect(conv.stage_key, "it declares that it joins on a mutable name").toBe("name");

    const s1 = conv.stages.find((s) => s.stage === S1)!;
    const s2 = conv.stages.find((s) => s.stage === S2)!;
    expect(s1.entered, "three deals entered the first stage").toBe(3);
    expect(
      s1.advanced,
      "two moved on — the pre-window entrant's departure is EXCLUDED (0076)",
    ).toBe(2);
    expect(Number(s1.advance_rate)).toBeCloseTo(2 / 3, 10);
    expect(s2.entered, "the pre-window entrant still ENTERS the second stage").toBe(3);
    expect(s2.advanced, "nothing moved past the second stage").toBe(0);
    expect(Number(s2.advance_rate), "0 advanced out of 3 is a rate of 0, not null").toBe(0);
    for (const s of conv.stages) {
      const rate = s.advance_rate === null ? 0 : Number(s.advance_rate);
      expect(rate, "advance_rate is bounded at 1 by construction (0076)").toBeLessThanOrEqual(1);
    }

    const t = conv.transitions.find((x) => x.from === S1 && x.to === S2)!;
    expect(t.deals, "transitions count EVERY move, cohort or not").toBe(3);

    // the chain must survive events written by a test, as everywhere else
    const { data: chainOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(chainOk, "stage_changed fixtures keep the hash chain intact").toBe(true);
    const health = await svc.rpc("events_partition_health");
    expect(health.data ?? [], "and do not create an occurred_at inversion").toEqual([]);
  });

  it("40. C4 citation: org-scoped, honest about scope, and survives a service-role caller", async () => {
    // 0065. The citation anchors a report in the audit trail. Its subqueries are
    // org-scoped EXPLICITLY rather than left to RLS, because
    // events_chain_checkpoint holds one row PER ORG: relying on RLS made it
    // raise 21000 "more than one row returned by a subquery used as an
    // expression" for any caller that bypasses RLS. Caught by the migration's
    // own verification block, which runs as postgres.
    await svc.rpc("run_chain_checks_full");

    const asAdmin = (await adminA.client.rpc("report_citation")).data as unknown as Record<
      string,
      unknown
    >;
    expect(asAdmin.scope, "an admin sees the org").toBe("org");
    expect(asAdmin.chain_verified_through, "the checkpoint anchors the citation").not.toBeNull();
    expect(asAdmin.chain_verified_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(asAdmin.chain_full_walk_at, "a full walk stamped it").not.toBeNull();

    const asAgent = (await agentA1.client.rpc("report_citation")).data as unknown as Record<
      string,
      unknown
    >;
    expect(asAgent.scope, "an agent's figures are their own, and the citation says so").toBe("own");

    // org B's citation must anchor to org B's chain, never org A's
    const asB = (await agentB.client.rpc("report_citation")).data as unknown as Record<
      string,
      unknown
    >;
    expect(asB.chain_verified_hash, "org B must not be handed org A's anchor").not.toBe(
      asAdmin.chain_verified_hash,
    );

    // A SERVICE-ROLE CALLER CANNOT PRODUCE A CITATION, AND THAT IS CORRECT.
    // report_citation calls current_org_id() and current_role_gnk(), which 0007
    // granted to `authenticated` only — service_role has no org and no role, so
    // there is nothing for a citation to be scoped to. The failure is 42501 on
    // the helper, not a defect here. (The first version of this test asserted
    // no error and was simply wrong about what service_role can do.)
    //
    // The org-scoping fix this test exists for — subqueries returning MULTIPLE
    // rows for an RLS-bypassing caller, because events_chain_checkpoint holds
    // one row per org — is proven elsewhere and more strongly: 0065's own
    // verification block calls report_citation() as `postgres`, with several
    // orgs holding checkpoints, on every fresh database including CI's. Before
    // the fix that block raised SQLSTATE 21000 and the migration would not apply.
    const asService = await svc.rpc("report_citation");
    expect(
      asService.error?.code,
      "service_role has no org, so the citation refuses rather than inventing one",
    ).toBe("42501");
  });

  it("41. C3 public listings: anon sees only public+available, and only allowlisted columns", async () => {
    /**
     * 0066. The brief's acceptance criterion, and the reason this is the only
     * Phase C item that opens a new public surface.
     *
     * THE PREDICATE IS `visibility = 'public' AND status = 'available'`, NOT the
     * quality score. The brief asks for the score to be re-checked here on the
     * premise that "a listing below 70 cannot be made public internally". It
     * can: lib/actions/properties.ts lets an admin publish below the threshold
     * with an audited `publish_override` event, and no DB constraint ties
     * visibility to the score. Re-checking would silently undo that audited
     * decision. Operator decision 2026-08-29; published_below_threshold() keeps
     * the drift visible instead, and test 42 covers it.
     */
    const anon = anonClient();
    const mkProp = async (
      org: string,
      ref: string,
      visibility: string,
      status: string,
      extra: Record<string, unknown> = {},
    ) => {
      const { data, error } = await svc
        .from("properties")
        .insert({
          org_id: org,
          reference: ref,
          property_type: "apartment",
          visibility,
          status,
          asking_price: 250000,
          bedrooms: 2,
          ...extra,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    };

    const pub = `PUB-${run}`;
    const draft = `DRAFT-${run}`;
    const priv = `PRIV-${run}`;
    const arch = `ARCH-${run}`;
    const sold = `SOLD-${run}`;
    const otherOrg = `OTHERORG-${run}`;

    // A DISTRICT AND AREA ARE REQUIRED, not incidental: without them the feed
    // returns null for both and the jsonb-shape assertion below skips exactly
    // the two fields 0069 exists to protect. Test 41 originally had no district
    // and that is part of why the text/jsonb defect survived to production.
    const { data: district } = await svc
      .from("districts")
      .select("id")
      .eq("org_id", ORG_A)
      .limit(1)
      .maybeSingle();
    let areaId: string | null = null;
    if (district) {
      const { data: area } = await svc
        .from("areas")
        .select("id")
        .eq("org_id", ORG_A)
        .eq("district_id", district.id)
        .limit(1)
        .maybeSingle();
      areaId =
        area?.id ??
        (
          await svc
            .from("areas")
            .insert({
              org_id: ORG_A,
              district_id: district.id,
              name: { en: `Area ${run}`, el: `Περιοχή ${run}`, ru: `Район ${run}` },
            })
            .select("id")
            .single()
        ).data?.id ??
        null;
    }

    // the one that SHOULD appear, carrying values in withheld columns so a leak
    // would be detectable by value and not only by column name
    await mkProp(ORG_A, pub, "public", "available", {
      internal_notes: "SECRET-INTERNAL-NOTE",
      min_acceptable_price: 199000,
      owner_net_price: 180000,
      address: "12 Secret Street",
      postal_code: "8001",
      quality_score: 85,
      district_id: district?.id ?? null,
      area_id: areaId,
    });
    // and the ones that must NOT
    await mkProp(ORG_A, draft, "public", "draft");
    await mkProp(ORG_A, priv, "private", "available");
    await mkProp(ORG_A, arch, "archived", "available");
    await mkProp(ORG_A, sold, "public", "sold");
    await mkProp(ORG_B, otherOrg, "public", "available");

    const { data, error } = await anon.rpc("public_listings", { p_org_slug: "test-org-a" });
    expect(error, "anon must be able to read the public feed").toBeNull();
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    const refs = rows.map((r) => r.reference);

    expect(refs, "a public, available listing is in the feed").toContain(pub);
    expect(refs, "a DRAFT must not be published").not.toContain(draft);
    expect(refs, "a PRIVATE listing must not be published").not.toContain(priv);
    expect(refs, "an ARCHIVED listing must not be published").not.toContain(arch);
    expect(refs, "a SOLD listing must not be published").not.toContain(sold);
    expect(refs, "another org's listing must not appear in this org's feed").not.toContain(
      otherOrg,
    );

    // --- the withheld list, asserted BY NAME ------------------------------
    // The brief: "A test asserts the withheld column list by name, so adding a
    // column to `properties` cannot silently publish it." `properties` has 69
    // columns and the feed is an allowlist of 34, so this is the half that
    // catches a future mistake.
    const row = rows.find((r) => r.reference === pub)!;
    const WITHHELD = [
      "id",
      "org_id",
      "parent_id",
      "internal_notes",
      "address",
      "postal_code",
      "location",
      "location_approx",
      "min_acceptable_price",
      "owner_net_price",
      "owner_contact_id",
      "developer_contact_id",
      "assigned_agent_id",
      "created_by",
      "quality_score",
      "unit_number",
      "block",
      "sold_at",
      "share_of_land",
      "encumbrances_notes",
      "constraints_notes",
      "amenities_notes",
      "inherited_fields",
      "permit_status",
      "visibility",
      "status",
      "created_at",
    ] as const;
    for (const col of WITHHELD) {
      expect(Object.keys(row), `the public feed must never return ${col}`).not.toContain(col);
    }

    // and by VALUE, in case a column is ever aliased into the feed under a
    // different name
    const serialised = JSON.stringify(row);
    expect(serialised, "the internal note must not appear under any key").not.toContain(
      "SECRET-INTERNAL-NOTE",
    );
    expect(serialised, "the walk-away price must not appear under any key").not.toContain("199000");
    expect(serialised, "the owner net price must not appear under any key").not.toContain("180000");
    expect(serialised, "the street address must not appear under any key").not.toContain(
      "Secret Street",
    );

    // what it SHOULD carry, so the allowlist is not vacuously safe
    expect(row.reference).toBe(pub);
    expect(row.asking_price).not.toBeUndefined();
    expect(row.bedrooms).toBe(2);

    // --- SHAPE, not just presence (0069) ----------------------------------
    // Every test here asserted which KEYS come back and none asserted their
    // TYPE, so 0066 shipped `district` and `area` as text while their source
    // columns are jsonb: the API answered with a STRING CONTAINING ESCAPED
    // JSON while `title` beside it was an object. Nothing failed. It was found
    // by looking at the first real published listing.
    //
    // A consumer must not have to JSON.parse() some multilingual fields and
    // not others.
    for (const key of [
      "title",
      "short_description",
      "public_description",
      "district",
      "area",
    ] as const) {
      const v = (row as Record<string, unknown>)[key];
      expect(v, `${key} must be present for this assertion to mean anything`).not.toBeNull();
      expect(
        typeof v,
        `${key} must be a parsed object, not a JSON string — 0069`,
      ).toBe("object");
    }

    // --- anon cannot reach the underlying table at all --------------------
    const direct = await anon.from("properties").select("reference").eq("reference", pub);
    expect(direct.data ?? [], "anon must not read `properties` directly").toHaveLength(0);
    const mandates = await anon.from("mandates").select("id");
    expect(mandates.data ?? [], "anon must not read mandates").toHaveLength(0);
  });

  it("42. C3: the score is NOT the public predicate, and the drift is visible", async () => {
    // 0066 + operator decision. A listing published below PUBLISH_THRESHOLD by
    // an admin override stays in the feed, and published_below_threshold()
    // reports it so nobody has to discover it by accident.
    const anon = anonClient();
    const ref = `LOWSCORE-${run}`;
    const { error } = await svc.from("properties").insert({
      org_id: ORG_A,
      reference: ref,
      property_type: "apartment",
      visibility: "public",
      status: "available",
      quality_score: 12,
    });
    if (error) throw error;

    const { data } = await anon.rpc("public_listings", { p_org_slug: "test-org-a" });
    expect(
      ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => r.reference),
      "an audited admin override must not be silently undone by the API",
    ).toContain(ref);

    const flagged = await adminA.client.rpc("published_below_threshold");
    expect(flagged.error).toBeNull();
    const rows = (flagged.data ?? []) as unknown as Array<{ reference: string; quality_score: number }>;
    const mine = rows.find((r) => r.reference === ref);
    expect(mine, "the drift must be visible to staff, not silent").toBeTruthy();
    expect(mine!.quality_score).toBe(12);

    // it reports quality scores, which the public feed withholds — so anon
    // must not be able to run it
    expect(
      (await anon.rpc("published_below_threshold")).error,
      "published_below_threshold must not be public",
    ).not.toBeNull();
  });

  it("43. C3: the ETag changes when a listing LEAVES the feed, not only when one changes", async () => {
    // 0066. max(updated_at) alone is not enough: unpublishing lowers the row
    // count without moving the maximum, and a marketing site would keep serving
    // a listing that is no longer for sale. The validator hashes the count too.
    const anon = anonClient();
    const ref = `ETAG-${run}`;
    const { data: created, error } = await svc
      .from("properties")
      .insert({
        org_id: ORG_A,
        reference: ref,
        property_type: "apartment",
        visibility: "public",
        status: "available",
      })
      .select("id, updated_at")
      .single();
    if (error) throw error;

    const before = (await anon.rpc("public_listings_etag", { p_org_slug: "test-org-a" }))
      .data as unknown as string;
    expect(before, "the validator is an md5").toMatch(/^[0-9a-f]{32}$/);

    // unpublish WITHOUT touching updated_at, which is the case a max()-only
    // validator misses
    await svc
      .from("properties")
      .update({ visibility: "private", updated_at: created.updated_at })
      .eq("id", created.id);

    const after = (await anon.rpc("public_listings_etag", { p_org_slug: "test-org-a" }))
      .data as unknown as string;
    expect(after, "removing a listing must change the validator").not.toBe(before);

    const refs = (
      ((await anon.rpc("public_listings", { p_org_slug: "test-org-a" })).data ??
        []) as unknown as Array<Record<string, unknown>>
    ).map((r) => r.reference);
    expect(refs, "and the listing is gone from the feed").not.toContain(ref);
  });

  it("44. C3: the rate limiter counts per IP window and is its own budget", async () => {
    // 0066. The 0023 idiom with a SEPARATE table: sharing share_link_attempts
    // would let marketing-site polling exhaust a buyer's proposal-link budget.
    const anon = anonClient();
    const ip = `c3-${run}`;

    const first = await anon.rpc("note_public_listing_hit", { p_ip_hash: ip, p_limit: 3 });
    expect(first.error).toBeNull();
    expect(first.data, "the first hit is under the limit").toBe(false);
    await anon.rpc("note_public_listing_hit", { p_ip_hash: ip, p_limit: 3 });
    await anon.rpc("note_public_listing_hit", { p_ip_hash: ip, p_limit: 3 });
    const over = await anon.rpc("note_public_listing_hit", { p_ip_hash: ip, p_limit: 3 });
    expect(over.data, "the fourth hit is over a limit of 3").toBe(true);

    // a different IP has its own budget
    const other = await anon.rpc("note_public_listing_hit", {
      p_ip_hash: `${ip}-other`,
      p_limit: 3,
    });
    expect(other.data, "another caller is unaffected").toBe(false);

    // and the counter table itself is unreachable
    const direct = await anon.from("public_listing_attempts").select("ip_hash");
    expect(direct.data ?? [], "anon must not read the rate-limit counters").toHaveLength(0);
    const adminRead = await adminA.client.from("public_listing_attempts").select("ip_hash");
    expect(adminRead.data ?? [], "not even an admin reads them — no policy grants it").toHaveLength(
      0,
    );

    // exhausting the PUBLIC budget must not affect share links (separate table)
    const shareStill = await anon.rpc("note_share_link_miss", { p_ip_hash: ip, p_limit: 3 });
    expect(
      shareStill.data,
      "the share-link budget is independent of the public API's",
    ).toBe(false);
  });

  it("45. stage_changed carries ids, and renaming a stage no longer splits its history", async () => {
    /**
     * 0067. `move_deal_to_stage` (0011) recorded stage NAMES only, so
     * report_stage_conversion (0065) grouped its funnel on a mutable string:
     * renaming a stage split that stage's history in two at the rename,
     * silently. The payload now carries ids as well, and the report resolves
     * them to the CURRENT name.
     *
     * This test is the rename, because that is the only thing that proves it.
     */
    const nameA = `S1-${run}`;
    const nameB = `S2-${run}`;
    // sort_order is UNIQUE per (org, deal_type), so hardcoding it makes the
    // test pass once and then collide forever against a long-lived local stack.
    // Derive from whatever is already there.
    const { data: top } = await svc
      .from("deal_stages")
      .select("sort_order")
      .eq("org_id", ORG_A)
      .eq("deal_type", "sale")
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    const base = (top?.sort_order ?? 0) + 1;
    const mkStage = async (name: string, order: number) => {
      const { data, error } = await svc
        .from("deal_stages")
        .insert({ org_id: ORG_A, deal_type: "sale", name, sort_order: order })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    };
    const s1 = await mkStage(nameA, base);
    const s2 = await mkStage(nameB, base + 1);

    const { data: deal, error: dealErr } = await svc
      .from("deals")
      .insert({
        org_id: ORG_A,
        deal_type: "sale",
        stage_id: s1,
        title: `stage-ids-${run}`,
        agent_id: agentA1.id,
        status: "open",
      })
      .select("id")
      .single();
    if (dealErr) throw dealErr;

    // the REAL rpc, as the kanban calls it
    const moved = await agentA1.client.rpc("move_deal_to_stage", {
      p_deal_id: deal.id,
      p_stage_id: s2,
    });
    expect(moved.error, "the guarded move must still work").toBeNull();

    // --- the payload gained ids and KEPT names ---------------------------
    const { data: ev } = await svc
      .from("events")
      .select("payload")
      .eq("entity_type", "deal")
      .eq("entity_id", deal.id)
      .eq("event_type", "stage_changed")
      .order("id", { ascending: false })
      .limit(1)
      .single();
    const payload = ev!.payload as Record<string, string>;
    expect(payload.from, "names stay — the timeline renderer reads them").toBe(nameA);
    expect(payload.to).toBe(nameB);
    expect(payload.from_stage_id, "and ids are now recorded").toBe(s1);
    expect(payload.to_stage_id).toBe(s2);

    const win = {
      p_from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      p_to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    type Conv = {
      stages: Array<{ stage: string; entered: number; advanced: number }>;
      moves_total: number;
      moves_with_ids: number;
    };
    const before = (await svc.rpc("report_stage_conversion", win)).data as unknown as Conv;
    expect(
      before.stages.find((s) => s.stage === nameB)?.entered,
      "the move shows under the destination stage",
    ).toBe(1);
    expect(before.moves_with_ids, "and it is id-backed").toBeGreaterThan(0);

    // --- THE POINT: rename the stage --------------------------------------
    const renamed = `${nameB}-RENAMED`;
    await svc.from("deal_stages").update({ name: renamed }).eq("id", s2);

    const after = (await svc.rpc("report_stage_conversion", win)).data as unknown as Conv;
    expect(
      after.stages.find((s) => s.stage === renamed)?.entered,
      "history follows the rename instead of splitting",
    ).toBe(1);
    expect(
      after.stages.find((s) => s.stage === nameB),
      "and the old spelling is gone, not left holding half the traffic",
    ).toBeUndefined();
  });

  it("46. a pre-0067 stage_changed event still reports under its recorded name", async () => {
    // Backward compatibility, which is the other half of an additive change:
    // every event written before 0067 has names and no ids, and must behave
    // exactly as it did. A deleted stage falls back the same way — the recorded
    // name is then the only thing that describes it.
    const legacy = `LEGACY-${run}`;
    const { error } = await svc.from("events").insert({
      org_id: ORG_A,
      actor_id: agentA1.id,
      entity_type: "deal",
      entity_id: dealA1,
      event_type: "stage_changed",
      payload: { from: `${legacy}-A`, to: `${legacy}-B` }, // no ids, as before 0067
    });
    if (error) throw error;

    const win = {
      p_from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      p_to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
    const conv = (await svc.rpc("report_stage_conversion", win)).data as unknown as {
      stages: Array<{ stage: string; entered: number }>;
      moves_total: number;
      moves_with_ids: number;
    };
    expect(
      conv.stages.find((s) => s.stage === `${legacy}-B`)?.entered,
      "an id-less event still reports under the name it recorded",
    ).toBe(1);
    expect(
      conv.moves_total,
      "and the coverage counters make the mix visible rather than assumed",
    ).toBeGreaterThan(conv.moves_with_ids);

    const { data: chainOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(chainOk, "the new payload shape keeps the hash chain intact").toBe(true);
  });

  it("47. an event names its author: a staff session cannot forge actor_id (0071)", async () => {
    // The hash chain proves nothing was EDITED; this policy is what makes a
    // row's ATTRIBUTION trustworthy. Before 0071 any aal2 session could
    // append events naming another user — or null, which renders as "system"
    // — and the log's evidentiary weight is the product's stated USP.
    const base = {
      org_id: ORG_A,
      entity_type: "config",
      entity_id: null,
      event_type: `actor_check_${run}`,
      payload: { note: "test 47" },
    };

    const forged = await agentA1.client
      .from("events")
      .insert({ ...base, actor_id: adminA.id });
    expect(forged.error, "naming ANOTHER user must be refused").not.toBeNull();

    const asSystem = await agentA1.client
      .from("events")
      .insert({ ...base, actor_id: null });
    expect(asSystem.error, "a null 'system' actor must be refused for a staff session").not.toBeNull();

    const own = await agentA1.client
      .from("events")
      .insert({ ...base, actor_id: agentA1.id });
    expect(own.error, "the ordinary self-attributed write still works").toBeNull();

    // The system rows the sweeps write stay possible: crons and the merge run
    // as postgres/service_role, which bypass RLS — that is the design, not a
    // hole, because no authenticated session holds those credentials.
    const system = await svc.from("events").insert({ ...base, actor_id: null });
    expect(system.error, "service-role system events are unaffected").toBeNull();

    const { data: chainOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(chainOk, "the refused inserts wrote nothing and the chain holds").toBe(true);
  });

  it("48. KYC contact documents are admin-only, and 'internal' KYC is refused at the DB (0072)", async () => {
    // SEC-02: passport scans / source-of-funds are CDD records — need-to-know,
    // not org-wide. The app now uploads them as admin_only; this pins the two
    // halves the app cannot: the SELECT filtering, and the 0072 CHECK that
    // refuses an internal KYC row from ANY path, service_role included.
    const { data: doc, error } = await svc
      .from("documents")
      .insert({
        org_id: ORG_A,
        entity_type: "contact",
        entity_id: contactA,
        doc_type: "id_document",
        title: `kyc-${run}`,
        storage_path: `${ORG_A}/contacts/${contactA}/kyc-${run}.pdf`,
        uploaded_by: adminA.id,
        visibility: "admin_only",
      })
      .select("id")
      .single();
    if (error) throw error;

    const agentRead = await agentA1.client.from("documents").select("id").eq("id", doc.id);
    expect(agentRead.error).toBeNull();
    expect(agentRead.data ?? [], "an agent must read 0 rows for a KYC document").toHaveLength(0);

    const lmRead = await lmA.client.from("documents").select("id").eq("id", doc.id);
    expect(lmRead.data ?? [], "a listing manager must read 0 rows too").toHaveLength(0);

    const adminRead = await adminA.client.from("documents").select("id").eq("id", doc.id);
    expect(adminRead.data, "the admin still sees it and can mint the signed URL").toHaveLength(1);

    // and the constraint half: an 'internal' KYC contact doc is refused even
    // for service_role, which bypasses RLS but not a CHECK — the failure
    // direction for CDD records is a loud error, never silent over-exposure.
    const relaxed = await svc.from("documents").insert({
      org_id: ORG_A,
      entity_type: "contact",
      entity_id: contactA,
      doc_type: "source_of_funds",
      title: `kyc-internal-${run}`,
      storage_path: `${ORG_A}/contacts/${contactA}/kyc2-${run}.pdf`,
      uploaded_by: adminA.id,
      // visibility omitted → column default 'internal' → must hit the CHECK
    });
    expect(relaxed.error, "the 0072 CHECK refuses an internal KYC row outright").not.toBeNull();
  });

  it("49. the feed carries photo renditions, cover first — never the private original (0073)", async () => {
    // FEED-1 + DB-02. A real-estate feed without photos cannot power a
    // marketing site; the renditions were already public-bucket files and
    // nothing joined them in. And published_at ordered the feed while being
    // written by nothing. Both halves are pinned here.
    const anon = anonClient();
    const refNew = `MEDIA-NEW-${run}`;
    const refOld = `MEDIA-OLD-${run}`;

    const mk = async (ref: string, publishedAt: string) => {
      const { data, error } = await svc
        .from("properties")
        .insert({
          org_id: ORG_A,
          reference: ref,
          property_type: "apartment",
          visibility: "public",
          status: "available",
          asking_price: 100000,
          published_at: publishedAt,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    };
    const newId = await mk(refNew, new Date().toISOString());
    await mk(refOld, new Date(Date.now() - 86_400_000).toISOString());

    const addMedia = async (over: Record<string, unknown>) => {
      const { error } = await svc.from("property_media").insert({
        org_id: ORG_A,
        property_id: newId,
        kind: "photo",
        storage_path_original: `${ORG_A}/originals/secret-original-${run}.jpg`,
        ...over,
      });
      if (error) throw error;
    };
    // cover has the HIGHER sort_order on purpose: cover-first must win over sort
    await addMedia({
      sort_order: 2,
      is_cover: true,
      path_thumb: `properties/${newId}/cover_thumb.webp`,
      path_card: `properties/${newId}/cover_card.webp`,
      path_full: `properties/${newId}/cover_full.webp`,
    });
    await addMedia({
      sort_order: 1,
      path_thumb: `properties/${newId}/one_thumb.webp`,
      path_card: `properties/${newId}/one_card.webp`,
      path_full: `properties/${newId}/one_full.webp`,
    });
    // a floor plan must NOT appear until deliberately wired (audit MEDIA-K)
    await addMedia({
      sort_order: 0,
      kind: "floor_plan",
      path_thumb: `properties/${newId}/plan_thumb.webp`,
      path_card: `properties/${newId}/plan_card.webp`,
      path_full: `properties/${newId}/plan_full.webp`,
    });
    // a photo still mid-pipeline (no full rendition) is withheld, not half-shipped
    await addMedia({
      sort_order: 3,
      path_thumb: `properties/${newId}/half_thumb.webp`,
      path_card: null,
      path_full: null,
    });

    const { data, error } = await anon.rpc("public_listings", { p_org_slug: "test-org-a" });
    expect(error).toBeNull();
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    const iNew = rows.findIndex((r) => r.reference === refNew);
    const iOld = rows.findIndex((r) => r.reference === refOld);
    expect(iNew, "the fresh listing is in the feed").toBeGreaterThanOrEqual(0);
    expect(iOld, "the older listing is in the feed").toBeGreaterThanOrEqual(0);
    expect(iNew, "newest published first — the ordering DB-02 revived").toBeLessThan(iOld);

    const images = rows[iNew].images as Array<Record<string, unknown>>;
    expect(images, "photos only, finished renditions only").toHaveLength(2);
    expect(String(images[0].full), "the cover leads even with a later sort_order").toContain(
      "cover_full",
    );
    expect(String(images[1].full)).toContain("one_full");
    expect(Object.keys(images[0]).sort(), "exactly the five public keys").toEqual([
      "alt",
      "card",
      "full",
      "thumb",
      "watermarked",
    ]);

    // the EXIF-bearing original lives in the PRIVATE bucket and its path must
    // never leave, under any key
    expect(JSON.stringify(rows[iNew])).not.toContain(`secret-original-${run}`);

    expect(rows[iOld].images, "no photos means an empty array, not null").toEqual([]);
  });

  it("50. cron_health() is service_role-only and sees all eight jobs (0074)", async () => {
    // REL-03. The function reads cron.job_run_details as its definer; the
    // grant surface is the whole security story, so it is pinned per role —
    // the anon-default-EXECUTE hazard has shipped twice before.
    const anon = anonClient();
    const anonCall = await anon.rpc("cron_health");
    expect(anonCall.error, "anon must be refused").not.toBeNull();

    const authedCall = await agentA1.client.rpc("cron_health");
    expect(authedCall.error, "a logged-in agent must be refused too — dashboard-only via admin client").not.toBeNull();

    const svcCall = await svc.rpc("cron_health");
    expect(svcCall.error).toBeNull();
    const jobs = (svcCall.data ?? []) as Array<Record<string, unknown>>;
    expect(jobs, "all eight scheduled jobs are visible").toHaveLength(8);
    for (const job of jobs) {
      expect(job.jobname, "every row names its job").toBeTruthy();
      expect(job.schedule, "every row carries the cron expression the TS verdict needs").toBeTruthy();
      expect(job.active, "migration-built jobs are active").toBe(true);
    }
    const names = jobs.map((j) => String(j.jobname));
    expect(names, "the chain walkers are among them").toEqual(
      expect.arrayContaining(["verify-events-chain", "verify-events-chain-full", "ensure-events-partitions"]),
    );
  });

  it("51. no-show nudge (0075): mints once, never for a rebooked buyer, closes on rebooking", async () => {
    const iso = (ms: number) => new Date(Date.now() - ms).toISOString();

    // fresh property so the contact+property rebooking axis belongs to this
    // test alone — contactA has viewings on propA1 in other tests
    const { data: prop, error: propErr } = await svc
      .from("properties")
      .insert({
        org_id: ORG_A,
        reference: `NOSHOW-${run}`,
        property_type: "apartment",
        status: "available",
        asking_price: 150000,
      })
      .select("id")
      .single();
    expect(propErr).toBeNull();

    const { data: v1, error: v1Err } = await svc
      .from("viewings")
      .insert({
        org_id: ORG_A,
        property_id: prop!.id,
        contact_id: contactA,
        agent_id: agentA1.id,
        scheduled_at: iso(2 * 86_400_000),
        status: "no_show",
      })
      .select("id, scheduled_at")
      .single();
    expect(v1Err).toBeNull();

    const noShowTasks = async () => {
      const { data, error } = await svc
        .from("tasks")
        .select("id, due_at, assignee_id, is_done")
        .eq("viewing_id", v1!.id)
        .eq("kind", "viewing_no_show");
      expect(error).toBeNull();
      return data ?? [];
    };

    // --- run 1: exactly one task, assigned to the viewing's agent ------------
    expect((await svc.rpc("create_followup_nudges", { p_org: ORG_A })).error).toBeNull();
    let tasks = await noShowTasks();
    expect(tasks, "a no-show viewing is nudged exactly once").toHaveLength(1);
    expect(tasks[0].assignee_id).toBe(agentA1.id);
    expect(tasks[0].is_done).toBe(false);

    // due the Cyprus day AFTER the missed slot, at 23:59 — the EOD idiom
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
    const nextDay = new Date(new Date(v1!.scheduled_at).getTime() + 86_400_000);
    expect(cyprus(tasks[0].due_at!)).toBe(`${cyprus(nextDay.toISOString()).slice(0, 10)}, 23:59`);

    const { data: mintEvents } = await svc
      .from("events")
      .select("id, payload")
      .eq("entity_id", v1!.id)
      .eq("event_type", "followup_task_created");
    expect(
      (mintEvents ?? []).filter((e) => (e.payload as { kind?: string }).kind === "viewing_no_show"),
      "the mint is evented",
    ).toHaveLength(1);

    // --- run 2: idempotent — the one-shot (viewing_id, kind) key holds -------
    expect((await svc.rpc("create_followup_nudges", { p_org: ORG_A })).error).toBeNull();
    expect(await noShowTasks(), "a second run mints nothing new").toHaveLength(1);

    // --- a rebooking closes the nag ------------------------------------------
    const { error: v2Err } = await svc.from("viewings").insert({
      org_id: ORG_A,
      property_id: prop!.id,
      contact_id: contactA,
      agent_id: agentA1.id,
      scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
      status: "scheduled",
    });
    expect(v2Err).toBeNull();

    expect((await svc.rpc("create_followup_nudges", { p_org: ORG_A })).error).toBeNull();
    tasks = await noShowTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].is_done, "the rebooking supersedes the open nag").toBe(true);

    const { data: superEvents } = await svc
      .from("events")
      .select("id, payload")
      .eq("event_type", "superseded")
      .eq("entity_id", tasks[0].id);
    expect(
      (superEvents ?? []).filter(
        (e) => (e.payload as { reason?: string }).reason === "viewing_rebooked",
      ),
      "the close states only what the predicate proved: a rebooking exists",
    ).toHaveLength(1);

    // --- a no-show that ALREADY has a later rebooking never mints ------------
    const { data: v3, error: v3Err } = await svc
      .from("viewings")
      .insert({
        org_id: ORG_A,
        property_id: prop!.id,
        contact_id: contactA,
        agent_id: agentA1.id,
        scheduled_at: iso(1 * 86_400_000),
        status: "no_show",
      })
      .select("id")
      .single();
    expect(v3Err).toBeNull();

    expect((await svc.rpc("create_followup_nudges", { p_org: ORG_A })).error).toBeNull();
    const { data: v3Tasks } = await svc
      .from("tasks")
      .select("id")
      .eq("viewing_id", v3!.id)
      .eq("kind", "viewing_no_show");
    expect(v3Tasks ?? [], "the nag would open pre-closed — so it never opens").toHaveLength(0);

    // the sweep's inserts kept the chain intact
    const { data: chainOk } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(chainOk, "the new event types keep the hash chain intact").toBe(true);
  });

});
