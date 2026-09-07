/**
 * The sweep that expires a hold must also close the prompt about it (0090).
 *
 * `reservation_still_live` (0089) asks the desk to settle a hold still live on
 * a property whose deal was won. A person settling it goes through
 * `transitionReservation`, which calls `completeLiveHoldChecks`. The OTHER way
 * a hold leaves the live set is `expire_reservations()` at 03:45 — SQL, which
 * knew nothing about the prompt.
 *
 * Two consequences, and the second is why this needed a migration rather than a
 * note: the task sat open forever asking for an action an expired hold no longer
 * has; and `raiseLiveHoldCheck`'s duplicate guard refuses to raise while an open
 * prompt of that kind exists on the property, so one stale row permanently
 * suppressed every future live-hold prompt on that property.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ORG_A, ensureTestOrg, serviceClient } from "./helpers";

const svc = serviceClient();
const run = Date.now().toString(36);

let propertyId: string;
let lapsedId: string;
let liveId: string;
let promptOnLapsed: string;
let promptOnLive: string;

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");

  const { data: prop, error: pErr } = await svc
    .from("properties")
    .insert({
      org_id: ORG_A,
      reference: `ZZEXP${run}`.slice(0, 20),
      property_type: "apartment",
      status: "sold",
    })
    .select("id")
    .single();
  if (pErr) throw new Error(`seed property: ${pErr.message}`);
  propertyId = prop.id;

  // A hold whose date has passed — the sweep will expire it.
  const { data: lapsed, error: lErr } = await svc
    .from("reservations")
    .insert({
      org_id: ORG_A,
      property_id: propertyId,
      status: "held",
      // held_from must precede expires_at (reservation_window_ordered, 0044),
      // so a lapsed hold needs a start further back than its expiry
      held_from: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      expires_at: new Date(Date.now() - 86_400_000).toISOString(),
    })
    .select("id")
    .single();
  if (lErr) throw new Error(`seed lapsed hold: ${lErr.message}`);
  lapsedId = lapsed.id;

  // A hold that is still in date, on ANOTHER property, so the sweep must leave
  // its prompt alone — a supersede that closes too much is its own defect.
  const { data: other } = await svc
    .from("properties")
    .insert({
      org_id: ORG_A,
      reference: `ZZLIVE${run}`.slice(0, 20),
      property_type: "apartment",
      status: "sold",
    })
    .select("id")
    .single();
  const { data: live, error: lvErr } = await svc
    .from("reservations")
    .insert({
      org_id: ORG_A,
      property_id: other!.id,
      status: "held",
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    })
    .select("id")
    .single();
  if (lvErr) throw new Error(`seed live hold: ${lvErr.message}`);
  liveId = live.id;

  const { data: tasks, error: tErr } = await svc
    .from("tasks")
    .insert([
      {
        org_id: ORG_A,
        title: `ZZ settle the hold ${run}`,
        property_id: propertyId,
        reservation_id: lapsedId,
        kind: "reservation_still_live",
        is_done: false,
      },
      {
        org_id: ORG_A,
        title: `ZZ settle the live hold ${run}`,
        property_id: other!.id,
        reservation_id: liveId,
        kind: "reservation_still_live",
        is_done: false,
      },
    ])
    .select("id, reservation_id");
  if (tErr) throw new Error(`seed prompts: ${tErr.message}`);
  promptOnLapsed = tasks!.find((t) => t.reservation_id === lapsedId)!.id;
  promptOnLive = tasks!.find((t) => t.reservation_id === liveId)!.id;

  const { error: sweepErr } = await svc.rpc("expire_reservations");
  if (sweepErr) throw new Error(`sweep: ${sweepErr.message}`);
});

describe("expire_reservations closes the prompt about the hold it just expired", () => {
  it("still expires the hold, exactly as 0044 wrote it", async () => {
    const { data } = await svc
      .from("reservations")
      .select("status, release_reason, released_at")
      .eq("id", lapsedId)
      .single();
    expect(data!.status).toBe("expired");
    expect(data!.release_reason).toBe("expired automatically");
    expect(data!.released_at).not.toBeNull();
  });

  it("completes the prompt, so it cannot outlive its ask", async () => {
    const { data } = await svc
      .from("tasks")
      .select("is_done, done_at")
      .eq("id", promptOnLapsed)
      .single();
    expect(data!.is_done, "the hold settled itself; the ask is answered").toBe(true);
    expect(data!.done_at).not.toBeNull();
  });

  it("leaves a prompt about a hold that is STILL live alone", async () => {
    const { data } = await svc.from("tasks").select("is_done").eq("id", promptOnLive).single();
    expect(data!.is_done, "a supersede that closes too much is its own defect").toBe(false);
  });

  it("events the supersede, naming what actually happened", async () => {
    const { data } = await svc
      .from("events")
      .select("payload, actor_id")
      .eq("entity_type", "task")
      .eq("entity_id", promptOnLapsed)
      .eq("event_type", "superseded");
    expect(data, "closing it is a state change, so it owes an event").toHaveLength(1);
    const payload = data![0].payload as { reason?: string; kind?: string };
    expect(payload.kind).toBe("reservation_still_live");
    expect(
      payload.reason,
      "the ignored case must stay distinguishable from the answered one",
    ).toMatch(/lapsed before anyone settled it/i);
    expect(data![0].actor_id, "a sweep has no actor").toBeNull();
  });

  it("is idempotent — a second run the same night changes nothing", async () => {
    const { data: before } = await svc
      .from("events")
      .select("id")
      .eq("entity_type", "task")
      .eq("entity_id", promptOnLapsed)
      .eq("event_type", "superseded");
    await svc.rpc("expire_reservations");
    const { data: after } = await svc
      .from("events")
      .select("id")
      .eq("entity_type", "task")
      .eq("entity_id", promptOnLapsed)
      .eq("event_type", "superseded");
    expect(after!.length, "no second supersede event").toBe(before!.length);
  });

  it("the hash chain still verifies after the sweep wrote to it", async () => {
    const { data } = await svc.rpc("verify_events_chain", { p_org: ORG_A });
    expect(data).toBe(true);
  });
});
