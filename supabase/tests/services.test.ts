/**
 * Core service integration tests (T0.7) — logEvent() and generateReference()
 * against the local stack. Requires `supabase start`. Run: npm run test:rls
 */
import { beforeAll, describe, expect, it } from "vitest";
import { logEvent } from "../../lib/services/events";
import { generateReference } from "../../lib/services/reference";
import { ORG_A, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

const run = `svc-${Date.now().toString(36)}`;
const svc = serviceClient();
let agent: TestUser;

beforeAll(async () => {
  // TEST-1: suite-owned fixture org, not the seeded org the dev app uses.
  // generateReference() needs the PAF district ensureTestOrg creates.
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  agent = await createTestUser(svc, `agent-${run}@test.local`, "agent", ORG_A);
}, 60_000);

describe("logEvent (T0.7)", () => {
  it("inserts an event row visible in the DB with hash chain fields", async () => {
    await logEvent(agent.client, {
      orgId: ORG_A,
      actorId: agent.id,
      entityType: "contact",
      eventType: "created",
      payload: { run },
    });

    const { data, error } = await svc
      .from("events")
      .select("entity_type, event_type, actor_id, payload, hash")
      .eq("org_id", ORG_A)
      .eq("event_type", "created")
      .eq("entity_type", "contact")
      .contains("payload", { run })
      .single();
    expect(error).toBeNull();
    expect(data?.actor_id).toBe(agent.id);
    expect(data?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws instead of silently losing an event (cross-org insert denied)", async () => {
    await expect(
      logEvent(agent.client, {
        orgId: "bbbbbbbb-0000-0000-0000-000000000001",
        entityType: "contact",
        eventType: "created",
      }),
    ).rejects.toThrow(/logEvent failed/);
  });
});

describe("generateReference (T0.7)", () => {
  it("returns sequential GNK-<district>-#### references", async () => {
    const first = await generateReference(agent.client, ORG_A, "PAF");
    const second = await generateReference(agent.client, ORG_A, "PAF");

    expect(first).toMatch(/^GNK-PAF-\d{4}$/);
    expect(second).toMatch(/^GNK-PAF-\d{4}$/);
    const n1 = parseInt(first.slice(-4), 10);
    const n2 = parseInt(second.slice(-4), 10);
    expect(n2).toBe(n1 + 1);
  });

  it("keeps independent sequences per district", async () => {
    const paf = await generateReference(agent.client, ORG_A, "PAF");
    const lim = await generateReference(agent.client, ORG_A, "LIM");
    expect(paf.startsWith("GNK-PAF-")).toBe(true);
    expect(lim.startsWith("GNK-LIM-")).toBe(true);
  });
});
