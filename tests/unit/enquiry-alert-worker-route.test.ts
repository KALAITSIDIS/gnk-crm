import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEnquiryAlertWorker } from "@/lib/services/enquiry-alert-worker";
import { GET, POST } from "@/app/api/internal/enquiry-alerts/route";

/**
 * The sweep endpoint (0101): what makes a desk alert RECOVERABLE when the
 * enquiry route's after() never ran, or ran and the provider said no.
 *
 * It is reached by a scheduler with no session — pg_net from the database,
 * or a Vercel cron — so its gate is a bearer secret (`CRON_SECRET`, the name
 * Vercel's cron sends on its own), compared in constant time. This file pins
 * the gate and what the endpoint hands the worker; the worker itself is
 * pinned in lib/services/enquiry-alert-worker.test.ts.
 */
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ marker: "admin" }) }));
vi.mock("@/lib/services/enquiry-alert-worker", () => ({
  DEFAULT_LIMIT: 5,
  DEFAULT_LEASE_SECONDS: 90,
  runEnquiryAlertWorker: vi.fn(async () => ({
    claimed: 2,
    accepted: 1,
    retried: 1,
    failed: 0,
    cancelled: 0,
    lost: 0,
    skipped: null,
  })),
}));

const SECRET = "c3c0f5b9e6a14f0e8b1d2a3c4d5e6f70";

const call = (
  method: "GET" | "POST",
  headers: Record<string, string> = {},
  query = "",
) => {
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

describe("a run", () => {
  it("hands the worker the admin client, a sweep id and the default limit, and answers the counts", async () => {
    const res = await call("GET", { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      claimed: 2,
      accepted: 1,
      retried: 1,
      failed: 0,
      cancelled: 0,
      lost: 0,
      skipped: null,
    });
    expect(runEnquiryAlertWorker).toHaveBeenCalledTimes(1);
    const [client, opts] = vi.mocked(runEnquiryAlertWorker).mock.calls[0]!;
    expect(client).toEqual({ marker: "admin" });
    expect(opts.workerId).toMatch(/^sweep:/);
    expect(opts.limit).toBe(5);
    expect(opts.leadId).toBeUndefined();
  });

  it("accepts POST as well as GET — pg_net posts, Vercel cron gets", async () => {
    const res = await call("POST", { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(runEnquiryAlertWorker).toHaveBeenCalledTimes(1);
  });

  it("takes a limit from the query, clamped to what one invocation can finish", async () => {
    await call("GET", { authorization: `Bearer ${SECRET}` }, "?limit=3");
    expect(vi.mocked(runEnquiryAlertWorker).mock.calls[0]![1].limit).toBe(3);
    await call("GET", { authorization: `Bearer ${SECRET}` }, "?limit=500");
    expect(vi.mocked(runEnquiryAlertWorker).mock.calls[1]![1].limit).toBe(20);
    await call("GET", { authorization: `Bearer ${SECRET}` }, "?limit=nope");
    expect(vi.mocked(runEnquiryAlertWorker).mock.calls[2]![1].limit).toBe(5);
  });

  it("a worker that throws is a 500 with no words from inside", async () => {
    vi.mocked(runEnquiryAlertWorker).mockRejectedValueOnce(new Error("secret-bearing detail"));
    const res = await call("GET", { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret-bearing");
  });
});
