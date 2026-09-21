import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG_A, anonClient, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * 0105: the sweep's HTTP outcomes become a durable, readable record.
 *
 * pg_cron records the `enquiry-alerts` run `succeeded` the moment
 * `net.http_post` queues a request (measured on hosted: 0.03 s, whatever the
 * route later answers). The answer lands in `net._http_response`, which
 * nothing read and pg_net purges after six hours. So:
 *
 *   - `enquiry_alerts_sweep()` records every request it queues
 *     (`enquiry_alert_sweep_runs`, outcome `queued`);
 *   - `reconcile_enquiry_alert_sweeps()` joins those rows with pg_net's
 *     responses and classifies them — `ok` (the worker completed, an empty
 *     queue included), `unconfigured` (200 but the provider is not armed:
 *     NOT proof alerts can be sent), `worker_failed` (503/500, `ok:false`),
 *     `unauthorized` (401/403), `timeout`, `connect_error`, `malformed` (a
 *     200 that is not the worker's body), `no_response` (nothing after the
 *     missing-after interval) — keeping the counts and the error code, never
 *     a header or a bearer;
 *   - `enquiry_alert_sweep_health()` summarises for the dashboard.
 *
 * The classifier is pure and pinned per case; the reconciler is exercised on
 * the real path once (a request the local stack cannot deliver resolves to
 * `connect_error`) and on the missing-response path; the health read is
 * pinned against rows this file writes.
 */
const svc = serviceClient();
const run = Date.now().toString(36);
const madeLeads: string[] = [];
const madeRuns: number[] = [];
let agentA: TestUser;

const MIN = 60_000;
const minutesAgo = (n: number) => new Date(Date.now() - n * MIN).toISOString();
const fakeRequestId = () => -Math.floor(Math.random() * 1_000_000_000) - 1; // negative: never a pg_net id

async function classify(status: number | null, content: string | null, error: string | null, timedOut = false) {
  const { data, error: err } = await svc.rpc("classify_enquiry_alert_sweep_response", {
    p_status: status,
    p_content: content,
    p_error: error,
    p_timed_out: timedOut,
  });
  if (err) throw new Error(`classify: ${err.message}`);
  return (data as Array<Record<string, unknown>>)[0]!;
}

async function insertRun(row: Record<string, unknown>) {
  const request_id = fakeRequestId();
  const { error } = await svc.from("enquiry_alert_sweep_runs").insert({ request_id, ...row });
  if (error) throw new Error(`insertRun: ${error.message}`);
  madeRuns.push(request_id);
  return request_id;
}

async function runRow(requestId: number) {
  const { data, error } = await svc.from("enquiry_alert_sweep_runs").select("*").eq("request_id", requestId).maybeSingle();
  if (error) throw new Error(`runRow: ${error.message}`);
  return data as Record<string, unknown> | null;
}

async function reconcile(nowIso?: string) {
  const { data, error } = await svc.rpc("reconcile_enquiry_alert_sweeps", nowIso ? { p_now: nowIso } : {});
  if (error) throw new Error(`reconcile: ${error.message}`);
  return data as number;
}

async function health() {
  const { data, error } = await svc.rpc("enquiry_alert_sweep_health");
  if (error) throw new Error(`health: ${error.message}`);
  return (data as Array<Record<string, unknown>>)[0]!;
}

const okBody = (claimed = 0) =>
  JSON.stringify({ ok: true, claimed, accepted: claimed, retried: 0, failed: 0, cancelled: 0, released: 0, lost: 0, skipped: null, error: null });

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  agentA = await createTestUser(svc, `sweep-agent-a-${run}@test.local`, "agent", ORG_A);
});

afterAll(async () => {
  if (madeRuns.length) await svc.from("enquiry_alert_sweep_runs").delete().in("request_id", madeRuns);
  if (madeLeads.length) {
    await svc.from("tasks").delete().in("lead_id", madeLeads);
    await svc.from("leads").delete().in("id", madeLeads);
  }
});

describe("grants: the record and its functions are the dashboard's, through service_role only", () => {
  it("anon and a signed-in agent are refused everywhere", async () => {
    const anon = anonClient();
    for (const fn of ["reconcile_enquiry_alert_sweeps", "enquiry_alert_sweep_health", "classify_enquiry_alert_sweep_response"]) {
      const args = fn === "classify_enquiry_alert_sweep_response" ? { p_status: 200, p_content: "", p_error: null, p_timed_out: false } : {};
      const a = await anon.rpc(fn, args);
      expect(a.error?.code, `${fn}: anon is refused by the grant, not by absence`).toBe("42501");
      const b = await agentA.client.rpc(fn, args);
      expect(b.error?.code, `${fn}: authenticated`).toBe("42501");
    }
    const rows = await agentA.client.from("enquiry_alert_sweep_runs").select("id");
    expect(rows.data ?? [], "the table is not readable by a signed-in user").toHaveLength(0);
    const anonRows = await anon.from("enquiry_alert_sweep_runs").select("id");
    expect(anonRows.data ?? []).toHaveLength(0);
  });
});

describe("the classifier: every shape the sweep route can answer with", () => {
  it("a completed run with an empty queue is `ok` — the counts are kept", async () => {
    const c = await classify(200, okBody(0), null);
    expect(c.outcome).toBe("ok");
    expect(c.claimed).toBe(0);
  });

  it("a completed run that sent is `ok` with its counts", async () => {
    const c = await classify(200, okBody(2), null);
    expect(c).toMatchObject({ outcome: "ok", claimed: 2, accepted: 2 });
  });

  it("200 with `skipped: unconfigured` is its own outcome — not a success for 'can alerts be sent'", async () => {
    const c = await classify(200, JSON.stringify({ ...JSON.parse(okBody(0)), skipped: "unconfigured" }), null);
    expect(c.outcome).toBe("unconfigured");
  });

  it("503 `ok:false` is `worker_failed`, and the error's stage and code are kept (never its words)", async () => {
    const body = JSON.stringify({ ok: false, claimed: 0, accepted: 0, retried: 0, failed: 0, cancelled: 0, released: 0, lost: 0, skipped: null, error: { stage: "claim", code: "PGRST301" } });
    const c = await classify(503, body, null);
    expect(c).toMatchObject({ outcome: "worker_failed", error_stage: "claim", error_code: "PGRST301" });
  });

  it("503 without a body (the sweep is not armed) and 500 (the worker threw) are `worker_failed` too", async () => {
    expect((await classify(503, JSON.stringify({ error: "The sweep is not armed on this deployment." }), null)).outcome).toBe("worker_failed");
    expect((await classify(500, JSON.stringify({ error: "The sweep failed." }), null)).outcome).toBe("worker_failed");
  });

  it("401 and 403 are `unauthorized` — the bearer in Vault no longer matches Vercel's", async () => {
    expect((await classify(401, JSON.stringify({ error: "Unauthorized." }), null)).outcome).toBe("unauthorized");
    expect((await classify(403, "", null)).outcome).toBe("unauthorized");
  });

  it("a timed-out request is `timeout`, whatever else the row says", async () => {
    expect((await classify(null, null, "Timeout was reached", true)).outcome).toBe("timeout");
  });

  it("no status and an error message is `connect_error`", async () => {
    expect((await classify(null, null, "Couldn't connect to server", false)).outcome).toBe("connect_error");
  });

  it("a 200 that is not the worker's body is `malformed`: HTML, an empty body, or JSON without the counts", async () => {
    expect((await classify(200, "<html>Sign in</html>", null)).outcome).toBe("malformed");
    expect((await classify(200, "", null)).outcome).toBe("malformed");
    expect((await classify(200, JSON.stringify({ ok: true }), null)).outcome).toBe("malformed");
    expect((await classify(200, JSON.stringify({ ok: "yes", claimed: 0 }), null)).outcome).toBe("malformed");
  });

  it("any other status is `http_error` with the status kept", async () => {
    expect((await classify(404, "", null)).outcome).toBe("http_error");
    expect((await classify(502, "", null)).outcome).toBe("http_error");
  });
});

describe("the reconciler", () => {
  it("the sweep records the request it queues, and a request the stack cannot deliver resolves to connect_error", async () => {
    const { data, error } = await svc.rpc("enquiry_alerts_sweep");
    expect(error).toBeNull();
    const requestId = Number(data);
    expect(requestId).toBeGreaterThan(0);
    madeRuns.push(requestId);
    let row = await runRow(requestId);
    expect(row, "queued the moment the request was").not.toBeNull();
    expect(row!.outcome).toBe("queued");

    // pg_net answers asynchronously; the local origin (supabase/seed.sql's
    // placeholder) has nothing listening, so the answer is a transport error.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await reconcile(new Date(Date.now() + 2 * MIN).toISOString()); // past the grace, before "missing"
      row = await runRow(requestId);
      if (row!.outcome !== "queued") break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(row!.outcome, "resolved from net._http_response").toBe("connect_error");
    expect(row!.resolved_at).not.toBeNull();
    expect(row!.http_status).toBeNull();
  });

  it("a queued request with no response is left alone inside the grace and marked no_response after the missing-after interval", async () => {
    const recent = await insertRun({ queued_at: minutesAgo(2) });
    const old = await insertRun({ queued_at: minutesAgo(11) });
    await reconcile();
    expect((await runRow(recent))!.outcome, "two minutes without an answer is pg_net being slow").toBe("queued");
    expect((await runRow(old))!.outcome, "eleven minutes is a lost request").toBe("no_response");
  });

  it("a stranger cannot write outcomes: a signed-in agent's update is refused silently by RLS", async () => {
    const id = await insertRun({ queued_at: minutesAgo(1) });
    await agentA.client.from("enquiry_alert_sweep_runs").update({ outcome: "ok" }).eq("request_id", id);
    expect((await runRow(id))!.outcome).toBe("queued");
  });

  it("resolved rows older than the retention are pruned by the reconciler", async () => {
    const ancient = await insertRun({ queued_at: minutesAgo(31 * 24 * 60), resolved_at: minutesAgo(31 * 24 * 60), outcome: "ok", http_status: 200 });
    await reconcile();
    expect(await runRow(ancient), "thirty-one days old: gone").toBeNull();
  });
});

describe("the health read", () => {
  // The live local cron queues a run every two minutes, and this file's own
  // reconcile loop above may have resolved one of its rows moments ago. The
  // rows written here are anchored AFTER the newest resolved row on the
  // table (a few seconds into the future at most), so what "newest" means
  // is decided by this test and not by when the cron happened to fire.
  let base = 0;
  const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();

  it("a failure streak is counted over resolved runs, newest first, until the last completed run", async () => {
    const { data: newest } = await svc
      .from("enquiry_alert_sweep_runs")
      .select("queued_at")
      .neq("outcome", "queued")
      .order("queued_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    base = Math.max(Date.now(), newest ? new Date(String(newest.queued_at)).getTime() + 1000 : 0);

    await insertRun({ queued_at: at(1), resolved_at: at(1), outcome: "ok", http_status: 200 });
    await insertRun({ queued_at: at(2), resolved_at: at(2), outcome: "unauthorized", http_status: 401 });
    await insertRun({ queued_at: at(3), resolved_at: at(3), outcome: "unauthorized", http_status: 401 });
    await insertRun({ queued_at: at(4), resolved_at: at(4), outcome: "unauthorized", http_status: 401 });
    const h = await health();
    expect(h.last_outcome).toBe("unauthorized");
    expect(Number(h.consecutive_failures)).toBe(3);
    expect(new Date(String(h.last_ok_at)).getTime()).toBe(new Date(at(1)).getTime());

    await insertRun({ queued_at: at(5), resolved_at: at(5), outcome: "ok", http_status: 200 });
    const after = await health();
    expect(after.last_outcome).toBe("ok");
    expect(Number(after.consecutive_failures)).toBe(0);
    expect(new Date(String(after.last_ok_at)).getTime()).toBe(new Date(at(5)).getTime());
  });

  it("`unconfigured` does not count as a completed run", async () => {
    await insertRun({ queued_at: at(6), resolved_at: at(6), outcome: "unconfigured", http_status: 200 });
    const h = await health();
    expect(h.last_outcome).toBe("unconfigured");
    expect(new Date(String(h.last_ok_at)).getTime(), "last_ok_at is the earlier ok row, not this one").toBe(new Date(at(5)).getTime());
    expect(Number(h.consecutive_failures), "and it counts against the streak").toBe(1);
  });

  it("overdue desk alerts are counted with the age of the oldest", async () => {
    const { data, error } = await svc.rpc("submit_public_enquiry", {
      p_org_slug: "test-org-a",
      p_name: `Sweep ${run}`,
      p_email: `sweep-${run}@example.invalid`,
      p_phone: "",
      p_message: `overdue probe ${run}`,
      p_property_ref: "",
      p_idempotency_key: `sweep-${run}`,
    });
    if (error) throw new Error(error.message);
    const leadId = data![0]!.lead_id as string;
    madeLeads.push(leadId);
    await svc.from("notification_jobs").update({ next_attempt_at: minutesAgo(25) }).eq("lead_id", leadId);
    const h = await health();
    expect(Number(h.overdue_jobs)).toBeGreaterThanOrEqual(1);
    expect(Number(h.oldest_overdue_minutes)).toBeGreaterThanOrEqual(25);
    expect(Number(h.pending_jobs)).toBeGreaterThanOrEqual(1);
  });
});
