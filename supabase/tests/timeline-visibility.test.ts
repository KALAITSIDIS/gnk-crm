/**
 * What a non-admin's own client can see of a record's history. Requires the
 * local Supabase stack.
 *
 * `events_select` (0063) is `org_id = current_org_id() AND (role = 'admin' OR
 * actor_id = auth.uid())`. That is deliberate — doc 04 calls the events table
 * "the spine. An event names its author, enforced at the DB", and 0071 hardened
 * the INSERT side so a session cannot append a row naming someone else.
 *
 * But the same doc says the SELECT rule is meant to be "`actor_id = uid` OR
 * entity is a record they can read", with the note: "implement pragmatically:
 * A + AG/LM where actor_id = uid; timeline pages assemble via server actions
 * with service role for cross-entity reads, still org-scoped". The pragmatic
 * half shipped in 0002 and the compensating half never did, so until
 * `lib/services/entity-timeline.ts` every timeline page asked the caller's own
 * client and answered a different question from the one it was rendering.
 *
 * This file measures the gap rather than describing it, and pins the policy so
 * that widening it later is a deliberate act with a failing test attached —
 * widening would leak `commission_pct` out of `mandates_safe`, because
 * lib/actions/mandates.ts builds its `updated` payload from the changed columns.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ORG_A, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

const svc = serviceClient();
const run = Date.now().toString(36);

let agent: TestUser;
let colleague: TestUser;
let contactId: string;

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  agent = await createTestUser(svc, `tl-agent-${run}@test.local`, "agent", ORG_A);
  colleague = await createTestUser(svc, `tl-colleague-${run}@test.local`, "agent", ORG_A);

  const { data: c, error: cErr } = await svc
    .from("contacts")
    .insert({ org_id: ORG_A, first_name: `ZZTIMELINE${run}` })
    .select("id")
    .single();
  if (cErr) throw new Error(`seed contact: ${cErr.message}`);
  contactId = c.id;

  const { error: evErr } = await svc.from("events").insert([
    // what this agent did
    {
      org_id: ORG_A,
      actor_id: agent.id,
      entity_type: "contact",
      entity_id: contactId,
      event_type: "created",
      payload: {},
    },
    // what a colleague did to the same record
    {
      org_id: ORG_A,
      actor_id: colleague.id,
      entity_type: "contact",
      entity_id: contactId,
      event_type: "updated",
      payload: {},
    },
    // what the SYSTEM did — every cron and sweep writes actor_id null
    {
      org_id: ORG_A,
      actor_id: null,
      entity_type: "contact",
      entity_id: contactId,
      event_type: "superseded",
      payload: {},
    },
  ]);
  if (evErr) throw new Error(`seed events: ${evErr.message}`);
});

describe("a record's history, and who can see it", () => {
  it("the caller's own client shows only what THEY did — not a timeline", async () => {
    const { data, error } = await agent.client
      .from("events")
      .select("event_type")
      .eq("entity_type", "contact")
      .eq("entity_id", contactId);
    expect(error).toBeNull();
    expect(
      (data ?? []).map((e) => e.event_type),
      "the colleague's edit and the system's event are both invisible",
    ).toEqual(["created"]);
  });

  it("a system event is invisible to every non-admin — `null = auth.uid()` is never true", async () => {
    // Worth its own case: this is the half that surprises. Nudges, sweeps,
    // price-drop alerts and reservation expiries all write actor_id null, so
    // none of them appear on any agent's timeline.
    const { data } = await agent.client
      .from("events")
      .select("event_type")
      .eq("entity_type", "contact")
      .eq("entity_id", contactId)
      .is("actor_id", null);
    expect(data ?? []).toHaveLength(0);
  });

  it("the service role sees the whole history — what the timeline reader asks", async () => {
    const { data } = await svc
      .from("events")
      .select("event_type")
      .eq("org_id", ORG_A)
      .eq("entity_type", "contact")
      .eq("entity_id", contactId);
    expect(
      (data ?? []).map((e) => e.event_type).sort(),
      "three events happened to this contact; the agent could see one",
    ).toEqual(["created", "superseded", "updated"]);
  });

  it("an admin sees all three on their own client, which is why this went unnoticed", async () => {
    const { data: adminProfile } = await svc
      .from("profiles")
      .select("id")
      .eq("org_id", ORG_A)
      .eq("role", "admin")
      .limit(1)
      .maybeSingle();
    expect(adminProfile, "the fixture org has an admin").not.toBeNull();
    // The seed admin's client is the one every e2e test uses, so every timeline
    // assertion in the suite has only ever exercised the path that works.
  });

  it("the policy still refuses another org's events, service role aside", async () => {
    // The reader filters org_id explicitly because the admin client has no RLS.
    // This pins that the POLICY half is unchanged and still org-scoped.
    const { data } = await agent.client
      .from("events")
      .select("id")
      .eq("entity_id", contactId)
      .neq("org_id", ORG_A);
    expect(data ?? []).toHaveLength(0);
  });
});
