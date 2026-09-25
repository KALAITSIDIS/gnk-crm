/**
 * A key's movement event names the movement, never the holder
 * (T-key-holder-shape). Requires the local Supabase stack.
 *
 * `record_key_movement` (0013) logged every movement with
 * `{ key_code, holder }` — the TYPED name of an external holder on a checkout,
 * of the property's OWNER on a transfer, copied again from the holder cache on
 * a return or a loss, and a staff member's full name by value. The hash chain
 * is beyond erasure and correction (SEC-03, the T-merged-event-ids-only rule).
 * The holder has a home that can be corrected: `key_movements`, one row per
 * movement, written in the same transaction; the History dialog and the /keys
 * movements list read it, and `property_keys.current_holder_*` caches who has
 * the key now. Since 0116 the event is `{ key_code, movement_id }`.
 *
 * Driven through the real RPC on real sessions, one test per action, with the
 * rows as positive controls: the name must reach the movement row and the
 * cache, and nowhere in the chain.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG_A, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

const svc = serviceClient();
const run = Date.now().toString(36);

let admin: TestUser;
let agent: TestUser;
let propertyId = "";
const EXTERNAL = `Zenobia Keyholder-${run}`; // a lawyer, a cleaner — someone with no profile
const OWNER = `Andreas Ownerkey-${run}`; // the property's owner, typed on a transfer
const WORDS = ["Zenobia", "Keyholder", "Andreas", "Ownerkey"];

async function newKey(label: string): Promise<{ id: string; code: string }> {
  const code = `ZZK-${label}-${run}`.slice(0, 50);
  const { data, error } = await svc
    .from("property_keys")
    .insert({ org_id: ORG_A, property_id: propertyId, key_code: code })
    .select("id")
    .single();
  if (error) throw new Error(`seed key: ${error.message}`);
  return { id: data.id as string, code };
}

async function move(
  who: TestUser,
  keyId: string,
  action: string,
  holder: { name?: string; profileId?: string } = {},
) {
  const { error } = await who.client.rpc("record_key_movement", {
    p_key_id: keyId,
    p_action: action,
    ...(holder.profileId ? { p_holder_profile_id: holder.profileId } : {}),
    ...(holder.name ? { p_holder_name: holder.name } : {}),
  } as never);
  return error;
}

async function eventsOf(keyId: string) {
  const { data, error } = await svc
    .from("events")
    .select("event_type, actor_id, payload")
    .eq("entity_type", "key")
    .eq("entity_id", keyId)
    .order("id");
  if (error) throw new Error(`events: ${error.message}`);
  return (data ?? []) as { event_type: string; actor_id: string | null; payload: Record<string, unknown> }[];
}

async function movementsOf(keyId: string) {
  const { data, error } = await svc
    .from("key_movements")
    .select("id, action, holder_profile_id, holder_name")
    .eq("key_id", keyId)
    .order("occurred_at");
  if (error) throw new Error(`movements: ${error.message}`);
  return (data ?? []) as { id: string; action: string; holder_profile_id: string | null; holder_name: string | null }[];
}

const cache = async (keyId: string) =>
  (await svc.from("property_keys").select("status, current_holder_name, current_holder_profile_id").eq("id", keyId).single())
    .data as { status: string; current_holder_name: string | null; current_holder_profile_id: string | null };

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  admin = await createTestUser(svc, `kh-admin-${run}@test.local`, "admin", ORG_A);
  agent = await createTestUser(svc, `kh-agent-${run}@test.local`, "agent", ORG_A);
  const { data, error } = await svc
    .from("properties")
    .insert({ org_id: ORG_A, reference: `ZZKH${run}`.slice(0, 20), property_type: "apartment", status: "available" })
    .select("id")
    .single();
  if (error) throw new Error(`seed property: ${error.message}`);
  propertyId = data.id as string;
});

afterAll(async () => {
  // key_movements and property_keys cascade with the property; events stay (append-only)
  if (propertyId) await svc.from("properties").delete().eq("id", propertyId);
});

describe("a key's movement event names the movement, never the holder (T-key-holder-shape)", () => {
  it("checkout to an external holder: the row and the cache carry the name; the event is { key_code, movement_id }", async () => {
    const key = await newKey("co");
    expect(await move(agent, key.id, "checkout", { name: EXTERNAL })).toBeNull();

    const [mv] = await movementsOf(key.id);
    expect(mv).toMatchObject({ action: "checkout", holder_name: EXTERNAL, holder_profile_id: null });
    expect(await cache(key.id)).toMatchObject({ status: "checked_out", current_holder_name: EXTERNAL });

    const [ev] = await eventsOf(key.id);
    expect(ev).toMatchObject({ event_type: "key_checkout", actor_id: agent.id });
    expect(ev.payload).toEqual({ key_code: key.code, movement_id: mv.id });
  });

  it("return: the holder comes back from the cache onto the row — not into the event", async () => {
    const key = await newKey("ret");
    await move(agent, key.id, "checkout", { name: EXTERNAL });
    expect(await move(agent, key.id, "return")).toBeNull();

    const mvs = await movementsOf(key.id);
    expect(mvs.map((m) => [m.action, m.holder_name])).toEqual([
      ["checkout", EXTERNAL],
      ["return", EXTERNAL],
    ]);
    expect(await cache(key.id)).toMatchObject({ status: "in_office", current_holder_name: null });
    const evs = await eventsOf(key.id);
    expect(evs.map((e) => e.event_type)).toEqual(["key_checkout", "key_return"]);
    expect(evs[1].payload).toEqual({ key_code: key.code, movement_id: mvs[1].id });
  });

  it("transfer to the owner, then lost: the owner's typed name is on the rows, and in no event", async () => {
    const key = await newKey("tr");
    expect(await move(admin, key.id, "transfer", { name: OWNER })).toBeNull();
    expect(await move(admin, key.id, "mark_lost")).toBeNull();

    const mvs = await movementsOf(key.id);
    expect(mvs.map((m) => [m.action, m.holder_name])).toEqual([
      ["transfer", OWNER],
      ["mark_lost", OWNER], // "keep the last holder on the row for accountability"
    ]);
    expect(await cache(key.id)).toMatchObject({ status: "lost", current_holder_name: OWNER });
    const evs = await eventsOf(key.id);
    expect(evs.map((e) => [e.event_type, e.payload])).toEqual([
      ["key_transfer", { key_code: key.code, movement_id: mvs[0].id }],
      ["key_lost", { key_code: key.code, movement_id: mvs[1].id }],
    ]);
  });

  it("checkout to a staff member: the profile is on the row; the event carries no name of theirs either", async () => {
    const key = await newKey("staff");
    expect(await move(admin, key.id, "checkout", { profileId: agent.id })).toBeNull();
    const [mv] = await movementsOf(key.id);
    expect(mv).toMatchObject({ holder_profile_id: agent.id });
    expect(mv.holder_name, "the row keeps the staff name, as it always did").toBeTruthy();
    const [ev] = await eventsOf(key.id);
    expect(ev.payload).toEqual({ key_code: key.code, movement_id: mv.id });
    expect(JSON.stringify(ev.payload)).not.toContain(mv.holder_name!);
  });

  it("a refused movement writes no row and no event", async () => {
    const key = await newKey("ref");
    await move(agent, key.id, "checkout", { name: EXTERNAL });
    const before = [(await movementsOf(key.id)).length, (await eventsOf(key.id)).length];
    const err = await move(agent, key.id, "checkout", { name: OWNER });
    expect(err?.message).toMatch(/return it first/);
    expect([(await movementsOf(key.id)).length, (await eventsOf(key.id)).length]).toEqual(before);
  });

  it("none of the typed names is anywhere in this run's key events", async () => {
    const { data: keys } = await svc.from("property_keys").select("id").eq("property_id", propertyId);
    const ids = (keys ?? []).map((k) => k.id as string);
    const { data: evs } = await svc.from("events").select("payload").eq("entity_type", "key").in("entity_id", ids);
    expect((evs ?? []).length).toBeGreaterThanOrEqual(7);
    const text = JSON.stringify(evs);
    for (const w of WORDS) expect(text, `"${w}" reached the chain`).not.toContain(w);
  });
});
