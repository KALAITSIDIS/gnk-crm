import { beforeAll, describe, expect, it } from "vitest";
import { ORG_A, anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * 0103: the two-minute desk-alert sweep, from the database.
 *
 * `enquiry_alerts_sweep()` is the body of the `enquiry-alerts` cron job: it
 * reads the CRM origin and the bearer from Vault and POSTs the sweep route
 * through pg_net. Three things about it deserve a test on the real stack:
 *
 *  - WHO may run it. pg_cron runs it as postgres; service_role may rehearse
 *    it; anon and authenticated must be refused outright. A SECURITY INVOKER
 *    body could not read Vault as them anyway, but the grant surface is the
 *    story that has shipped wrong twice before (RLS test 50's comment), so it
 *    is pinned per role here and in the restore pack.
 *
 *  - A MISSING SECRET IS LOUD. The first cut of 0103 refused to APPLY without
 *    the Vault secrets, and CI's fresh stack — which has no hook before
 *    migrations — died at `supabase start`. Now the apply needs nothing and
 *    the RUN raises, naming the secret, so pg_cron records the run `failed`
 *    and the cron-health card shows the job amber within the hour. The names
 *    are parameters so this test can prove the refusal without touching the
 *    real rows. The explicit checks matter: measured, a NULL url fails
 *    pg_net's not-null constraint on its own, but a NULL bearer builds
 *    `{"Authorization": null}` and would have posted, got 401, and been
 *    recorded `succeeded` — silently, every two minutes.
 *
 *  - THE REAL NAMES QUEUE A REQUEST. On any stack that has the two rows
 *    (hosted by hand; local and CI from supabase/seed.sql) the call returns a
 *    pg_net request id. The request itself goes to the seed's placeholder
 *    origin and is refused or answered 401 — asynchronously, harmlessly. What
 *    this proves is that the production execution path (Vault → header →
 *    queue) RUNS, not merely that a schema says it would.
 */
const svc = serviceClient();
const run = Date.now().toString(36);
let agentA: TestUser;

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  agentA = await createTestUser(svc, `cron-agent-a-${run}@test.local`, "agent", ORG_A);
});

describe("enquiry_alerts_sweep() — the body of the enquiry-alerts cron job (0103)", () => {
  it("is refused to anon and to a signed-in agent: postgres (pg_cron) and service_role only", async () => {
    const anon = await anonClient().rpc("enquiry_alerts_sweep");
    expect(anon.error, "anon must be refused").not.toBeNull();
    expect(anon.error!.code, "refused by the grant, not by a failure inside").toBe("42501");

    const authed = await agentA.client.rpc("enquiry_alerts_sweep");
    expect(authed.error, "a signed-in agent must be refused too").not.toBeNull();
    expect(authed.error!.code).toBe("42501");
  });

  it("raises, naming the secret, when a Vault row is missing — the run fails loudly instead of posting an empty bearer", async () => {
    const noUrl = await svc.rpc("enquiry_alerts_sweep", {
      p_url_secret: `no-such-url-${run}`,
      p_bearer_secret: "cron_secret",
    });
    expect(noUrl.error, "a missing origin must not reach pg_net").not.toBeNull();
    expect(noUrl.error!.code).toBe("P0001");
    expect(noUrl.error!.message, "the message names the secret to create").toContain(`no-such-url-${run}`);

    const noBearer = await svc.rpc("enquiry_alerts_sweep", {
      p_url_secret: "crm_url",
      p_bearer_secret: `no-such-secret-${run}`,
    });
    expect(noBearer.error, "a missing bearer must not post `Authorization: null`").not.toBeNull();
    expect(noBearer.error!.code).toBe("P0001");
    expect(noBearer.error!.message).toContain(`no-such-secret-${run}`);
  });

  it("with the real names it queues a pg_net request and returns its id — the production path runs", async () => {
    const { data, error } = await svc.rpc("enquiry_alerts_sweep");
    expect(error, "both Vault rows must exist on this stack (supabase/seed.sql plants local placeholders)").toBeNull();
    expect(Number(data), "pg_net's request id").toBeGreaterThan(0);
  });

  it("is scheduled every two minutes and cron_health() sees it", async () => {
    const { data, error } = await svc.rpc("cron_health");
    expect(error).toBeNull();
    const job = ((data ?? []) as Array<Record<string, unknown>>).find((j) => j.jobname === "enquiry-alerts");
    expect(job, "the eleventh job").toBeDefined();
    expect(job!.schedule).toBe("*/2 * * * *");
    expect(job!.active).toBe(true);
  });
});
