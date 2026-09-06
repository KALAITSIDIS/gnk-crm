import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashIp } from "@/lib/services/ip-hash";
import { ORIGIN_RATE_LIMIT, RATE_LIMIT } from "@/lib/services/enquiry-budget";
import { POST } from "@/app/api/public/enquiries/route";

/**
 * The enquiry door meters a forwarded visitor only when the forwarder has
 * proved it is our site (the audit's A02). `budgetsFor` pins the table as a
 * pure function; this file pins the one thing it cannot see — that the route
 * reads `x-gnk-forward-key`, compares it with the configured secret, and hands
 * the verdict in. A route that forgot the header, or trusted everyone, would
 * pass every unit test in lib/ and still hand out a fresh budget per forged
 * header.
 *
 * Faked: the admin client (records every counter call), the request-scoped IP
 * hash, the desk alert, and `after()` (run inline). Everything else is real.
 */
const state = vi.hoisted(() => ({
  hits: [] as Array<{ hash: string; limit: number }>,
  refuseAt: -1,
  submits: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "note_public_enquiry_hit") {
        state.hits.push({ hash: String(args.p_ip_hash), limit: Number(args.p_limit) });
        return { data: state.hits.length - 1 === state.refuseAt, error: null };
      }
      if (name === "submit_public_enquiry") {
        state.submits.push(args);
        return { data: true, error: null };
      }
      throw new Error("unexpected rpc " + name);
    },
  }),
}));
vi.mock("@/lib/services/caller-ip", async () => {
  const { hashIp } = await import("@/lib/services/ip-hash");
  return { callerIpHash: async () => hashIp("203.0.113.7") };
});
vi.mock("@/lib/services/enquiry-alert", () => ({ sendEnquiryAlert: vi.fn(async () => "skipped") }));
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return { ...original, after: (fn: () => unknown) => void fn() };
});

const KEY = "0b7d4c6e8a9f0b1c2d3e4f505f1c9e2a";
const TRANSPORT = hashIp("203.0.113.7");
const VISITOR = "198.51.100.22";

const post = (headers: Record<string, string> = {}) =>
  POST(
    new NextRequest("https://crm.example/api/public/enquiries", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        org: "gnk",
        name: "A Buyer",
        email: "buyer@example.invalid",
        message: "Is PAF0001 still available?",
      }),
    }),
  );

beforeEach(() => {
  state.hits = [];
  state.refuseAt = -1;
  state.submits = [];
  process.env.ENQUIRY_FORWARD_KEY = KEY;
});
afterEach(() => {
  delete process.env.ENQUIRY_FORWARD_KEY;
});

describe("the door believes the visitor header only from our own site", () => {
  it("unsigned: a visitor header with no key spends the caller's own budget, tightly", async () => {
    const res = await post({ "x-gnk-visitor-ip": VISITOR });
    expect(res.status).toBe(202);
    expect(state.hits).toEqual([{ hash: TRANSPORT, limit: RATE_LIMIT }]);
  });

  it("forged: a wrong key is the same as no key", async () => {
    const res = await post({ "x-gnk-visitor-ip": VISITOR, "x-gnk-forward-key": KEY + "0" });
    expect(res.status).toBe(202);
    expect(state.hits).toEqual([{ hash: TRANSPORT, limit: RATE_LIMIT }]);
  });

  it("signed: our site's visitor is metered first, then the site's ceiling", async () => {
    const res = await post({ "x-gnk-visitor-ip": VISITOR, "x-gnk-forward-key": KEY });
    expect(res.status).toBe(202);
    expect(state.hits).toEqual([
      { hash: hashIp(VISITOR), limit: RATE_LIMIT },
      { hash: TRANSPORT, limit: ORIGIN_RATE_LIMIT },
    ]);
  });

  it("signed without a visitor header: one budget, the caller's", async () => {
    await post({ "x-gnk-forward-key": KEY });
    expect(state.hits).toEqual([{ hash: TRANSPORT, limit: RATE_LIMIT }]);
  });

  it("no key configured on this side: nothing is trusted, so the header is ignored", async () => {
    delete process.env.ENQUIRY_FORWARD_KEY;
    await post({ "x-gnk-visitor-ip": VISITOR, "x-gnk-forward-key": KEY });
    expect(state.hits).toEqual([{ hash: TRANSPORT, limit: RATE_LIMIT }]);
  });

  it("refuses on the visitor's budget before spending the site's, and writes nothing", async () => {
    state.refuseAt = 0;
    const res = await post({ "x-gnk-visitor-ip": VISITOR, "x-gnk-forward-key": KEY });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
    expect(state.hits).toHaveLength(1);
    expect(state.submits).toEqual([]);
  });

  it("an accepted enquiry reaches the function with what was sent, and only that", async () => {
    const res = await post({ "x-gnk-visitor-ip": VISITOR, "x-gnk-forward-key": KEY });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(state.submits).toEqual([
      {
        p_org_slug: "gnk",
        p_name: "A Buyer",
        p_email: "buyer@example.invalid",
        p_phone: "",
        p_message: "Is PAF0001 still available?",
        p_property_ref: "",
      },
    ]);
  });
});
