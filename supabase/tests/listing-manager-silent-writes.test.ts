/**
 * What a listing manager's forbidden writes ACTUALLY do. Requires the local
 * Supabase stack.
 *
 * A 2026-09-07 review reported a cluster of P1s of one shape: the UI offers a
 * listing manager an action, the row policy does not admit them, and the
 * UPDATE is filtered to zero rows WITHOUT an error — so the action reports
 * success and, in two cases, writes an event saying the thing happened.
 *
 * The premise underneath every one of those findings is this file's subject:
 * that a policy-filtered UPDATE returns `error: null` and touches nothing.
 * That premise is worth measuring rather than believing — on the same day, a
 * different P1 from the same review rested on a premise about PostgREST that
 * turned out to be false, and three agents confirmed it from the code alone.
 *
 * So this test asserts the mechanism directly: the write is refused, silently,
 * and the row is unchanged afterwards. If that ever stops being true — a
 * policy is widened, or Postgres starts erroring — the actions built on top of
 * it need rereading, and this fails first.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ORG_A, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

const svc = serviceClient();
const run = Date.now().toString(36);

let lm: TestUser;
let agent: TestUser;
let leadId: string;
let viewingId: string;
let propertyId: string;
let contactId: string;

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  lm = await createTestUser(svc, `lm-silent-${run}@test.local`, "listing_manager", ORG_A);
  agent = await createTestUser(svc, `ag-silent-${run}@test.local`, "agent", ORG_A);

  const { data: lead, error: leadErr } = await svc
    .from("leads")
    .insert({ org_id: ORG_A, message: `ZZTEST lead ${run}`, status: "new" })
    .select("id")
    .single();
  if (leadErr) throw new Error(`seed lead: ${leadErr.message}`);
  leadId = lead.id;

  const { data: prop, error: propErr } = await svc
    .from("properties")
    .insert({
      org_id: ORG_A,
      reference: `ZZTESTLM${run}`.slice(0, 20),
      property_type: "apartment",
      status: "available",
    })
    .select("id")
    .single();
  if (propErr) throw new Error(`seed property: ${propErr.message}`);
  propertyId = prop.id;

  const { data: contact, error: contactErr } = await svc
    .from("contacts")
    .insert({ org_id: ORG_A, first_name: `ZZTESTLM${run}` })
    .select("id")
    .single();
  if (contactErr) throw new Error(`seed contact: ${contactErr.message}`);
  contactId = contact.id;

  // owned by the AGENT, so the listing manager is not its owner either way
  const { data: viewing, error: viewingErr } = await svc
    .from("viewings")
    .insert({
      org_id: ORG_A,
      property_id: propertyId,
      contact_id: contactId,
      agent_id: agent.id,
      scheduled_at: new Date(Date.UTC(2027, 0, 6, 10, 0)).toISOString(),
      status: "scheduled",
    })
    .select("id")
    .single();
  if (viewingErr) throw new Error(`seed viewing: ${viewingErr.message}`);
  viewingId = viewing.id;
});

describe("a listing manager's forbidden UPDATE is refused without saying so", () => {
  it("leads: the update touches nothing, reports no error, and leaves the row alone", async () => {
    const { data, error } = await lm.client
      .from("leads")
      .update({ status: "contacted", first_response_at: new Date().toISOString() })
      .eq("id", leadId)
      .select("id");

    expect(error, "THE WHOLE PROBLEM: a policy-filtered UPDATE is not an error").toBeNull();
    expect(data, "and it changed nothing").toEqual([]);

    const { data: after } = await svc
      .from("leads")
      .select("status, first_response_at")
      .eq("id", leadId)
      .single();
    expect(after!.first_response_at, "the stamp was never written").toBeNull();
    expect(after!.status).not.toBe("contacted");
  });

  it("viewings: same shape — no error, no rows, status unchanged", async () => {
    const { data, error } = await lm.client
      .from("viewings")
      .update({ status: "completed" })
      .eq("id", viewingId)
      .select("id");

    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: after } = await svc
      .from("viewings")
      .select("status")
      .eq("id", viewingId)
      .single();
    expect(after!.status, "the viewing is still scheduled").toBe("scheduled");
  });

  it("the listing manager CAN read both — which is why the UI offers the buttons", async () => {
    // Not incidental: the actions are reachable precisely because the row is
    // visible. A test that only proved the write fails would leave open the
    // reading that the page 404s instead.
    const { data: lead } = await lm.client.from("leads").select("id").eq("id", leadId).maybeSingle();
    const { data: viewing } = await lm.client
      .from("viewings")
      .select("id")
      .eq("id", viewingId)
      .maybeSingle();
    expect(lead?.id, "the lead is visible to them").toBe(leadId);
    expect(viewing?.id, "so is the viewing").toBe(viewingId);
  });

  it("an INSERT they may not make ERRORS — which is why it needs a different fix", async () => {
    /*
     * The asymmetry that decides the remedy.
     *
     * A forbidden UPDATE is filtered to zero rows and says nothing, so the fix
     * is server-side: prove the write before logging an event. A forbidden
     * INSERT violates the WITH CHECK and RAISES — code 42501, straight through
     * to the user as a raw Postgres message. No amount of checking the result
     * helps, because the result is an exception; the fix is not to offer the
     * button (mayCreateViewing).
     */
    const { error } = await lm.client.from("viewings").insert({
      org_id: ORG_A,
      property_id: propertyId,
      contact_id: contactId,
      agent_id: lm.id,
      scheduled_at: new Date(Date.UTC(2027, 0, 7, 10, 0)).toISOString(),
      status: "scheduled",
    });
    expect(error, "an INSERT they may not make is an ERROR, not a silent no-op").not.toBeNull();
    expect(error!.code, "row-level security violation").toBe("42501");
  });

  it("an agent CAN work an unassigned lead — so the refusal above is about the role", async () => {
    // The control. Without it, the two tests above are also satisfied by a
    // lead that simply cannot be updated by anyone.
    const { data, error } = await agent.client
      .from("leads")
      .update({ status: "contacted" })
      .eq("id", leadId)
      .select("id");
    expect(error).toBeNull();
    expect(data, "the agent's identical write DOES land").toHaveLength(1);

    // put it back for anyone reading the fixture afterwards
    await svc.from("leads").update({ status: "new", first_response_at: null }).eq("id", leadId);
  });
});
