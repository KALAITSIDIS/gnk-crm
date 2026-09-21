import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEnquiryAlertWorker } from "@/lib/services/enquiry-alert-worker";
import { GET, POST, ROUTE_BUDGET_MS, ROUTE_MAX_LIMIT, maxDuration } from "@/app/api/internal/enquiry-alerts/route";

/**
 * The sweep endpoint (0101, reviewed 0102): what makes a desk alert
 * RECOVERABLE when the enquiry route's after() never ran, or ran and the
 * provider said no.
 *
 * It is reached by a scheduler with no session — pg_net from the database,
 * or a Vercel cron — so its gate is a bearer secret (`CRON_SECRET`, the name
 * Vercel's cron sends on its own), compared in constant time. This file pins
 * the gate, the budget it hands the worker, and — review C — that a run
 * which could not reach the queue is NOT a 200 "ok". The worker itself is
 * pinned in lib/services/enquiry-alert-worker.test.ts.
 */
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ marker: "admin" }) }));
vi.mock("@/lib/services/enquiry-alert-worker", () => ({
  DEFAULT_LEASE_SECONDS: 90,
  runEnquiryAlertWorker: vi.fn(async () => ({
    claimed: 2,
    accepted: 1,
    retried: 1,
    failed: 0,
    cancelled: 0,
    released: 0,
    lost: 0,
    skipped: null,
    error: null,
  })),
}));

const SECRET = "c3c0f5b9e6a14f0e8b1d2a3c4d5e6f70";

const call = (method: "GET" | "POST", headers: Record<string, string> = {}, query = "") => {
  const req = new NextRequest(`https://crm.example/api/internal/enquiry-alerts${query}`, { method, headers });
  return method === "GET" ? GET(req) : POST(req);
};

beforeEach(() => {
  vi.mocked(runEnquiryAlertWorker).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.CRON_SECRET = SECRET;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CRON_SECRET;
});

describe("the gate", () => {
  it("fails CLOSED when no secret is configured: 503, and nothing runs", async () => {
    delete process.env.CRON_SECRET;
    const res = await call("GET", { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(503);
    expect(runEnquiryAlertWorker).not.toHaveBeenCalled();
  });

  it("refuses a missing or wrong bearer with 401, and nothing runs", async () => {
    expect((await call("GET")).status).toBe(401);
    expect((await call("GET", { authorization: `Bearer ${SECRET}0` })).status).toBe(401);
    expect((await call("GET", { authorization: SECRET })).status).toBe(401);
    expect(runEnquiryAlertWorker).not.toHaveBeenCalled();
  });

  it("never caches its answer", async () => {
    const res = await call("GET", { authorization: `Bearer ${SECRET}` });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the budget (review B)", () => {
  it("the route's budget leaves headroom inside maxDuration, and the ceiling is what that budget fits", () => {
    expect(ROUTE_BUDGET_MS).toBeLessThan(maxDuration * 1000);
    expect(maxDuration * 1000 - ROUTE_BUDGET_MS, "at least ten seconds for cold start and the answer").toBeGreaterThanOrEqual(
      10_000,
    );
    expect(ROUTE_MAX_LIMIT, "four sends of 8 s + 2 s fit 45 s; ten never did").toBe(4);
  });

  it("hands the worker the admin client, a sweep id, the budget and the ceiling, and answers the counts", async () => {
    const res = await call("GET", { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      claimed: 2,
      accepted: 1,
      retried: 1,
      failed: 0,
      cancelled: 0,
      released: 0,
      lost: 0,
      skipped: null,
      error: null,
    });
    expect(runEnquiryAlertWorker).toHaveBeenCalledTimes(1);
    const [client, opts] = vi.mocked(runEnquiryAlertWorker).mock.calls[0]!;
    expect(client).toEqual({ marker: "admin" });
    expect(opts.workerId).toMatch(/^sweep:/);
    expect(opts.limit).toBe(ROUTE_MAX_LIMIT);
    expect(opts.budgetMs).toBe(ROUTE_BUDGET_MS);
    expect(opts.leadId).toBeUndefined();
  });

  it("accepts POST as well as GET — pg_net posts, Vercel cron gets", async () => {
    const res = await call("POST", { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(runEnquiryAlertWorker).toHaveBeenCalledTimes(1);
  });

  it("takes a smaller limit from the query, never a larger one than the budget fits", async () => {
    await call("GET", { authorization: `Bearer ${SECRET}` }, "?limit=3");
    expect(vi.mocked(runEnquiryAlertWorker).mock.calls[0]![1].limit).toBe(3);
    await call("GET", { authorization: `Bearer ${SECRET}` }, "?limit=500");
    expect(vi.mocked(runEnquiryAlertWorker).mock.calls[1]![1].limit).toBe(ROUTE_MAX_LIMIT);
    await call("GET", { authorization: `Bearer ${SECRET}` }, "?limit=nope");
    expect(vi.mocked(runEnquiryAlertWorker).mock.calls[2]![1].limit).toBe(ROUTE_MAX_LIMIT);
  });
});

describe("when the queue cannot be reached (review C)", () => {
  it("a claim failure is 503 with ok:false and the stage and code — never a 200 that looks like an empty queue", async () => {
    vi.mocked(runEnquiryAlertWorker).mockResolvedValueOnce({
      claimed: 0,
      accepted: 0,
      retried: 0,
      failed: 0,
      cancelled: 0,
      released: 0,
      lost: 0,
      skipped: null,
      error: { stage: "claim", code: "PGRST301" },
    });
    const res = await call("GET", { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toEqual({ stage: "claim", code: "PGRST301" });
    expect(body.claimed).toBe(0);
  });

  it("an empty queue is still 200 ok", async () => {
    vi.mocked(runEnquiryAlertWorker).mockResolvedValueOnce({
      claimed: 0,
      accepted: 0,
      retried: 0,
      failed: 0,
      cancelled: 0,
      released: 0,
      lost: 0,
      skipped: null,
      error: null,
    });
    const res = await call("GET", { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("an unconfigured provider is 200 with skipped named — the queue was reachable, nothing was tried", async () => {
    vi.mocked(runEnquiryAlertWorker).mockResolvedValueOnce({
      claimed: 0,
      accepted: 0,
      retried: 0,
      failed: 0,
      cancelled: 0,
      released: 0,
      lost: 0,
      skipped: "unconfigured",
      error: null,
    });
    const res = await call("GET", { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe("unconfigured");
  });

  it("a worker that throws is a 500 with no words from inside", async () => {
    vi.mocked(runEnquiryAlertWorker).mockRejectedValueOnce(new Error("secret-bearing detail"));
    const res = await call("GET", { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret-bearing");
  });
});
