import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashIp } from "@/lib/services/ip-hash";
import { ORIGIN_RATE_LIMIT, RATE_LIMIT } from "@/lib/services/enquiry-budget";
import { sendEnquiryAlert } from "@/lib/services/enquiry-alert";
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
  /** 0096: the door answers with the lead; `replayed` says the key was seen before */
  replay: false,
  /** every row the route wrote through the admin client, by table */
  writes: [] as Array<{ table: string; row: Record<string, unknown> }>,
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
        return {
          data: [{ lead_id: "lead-1", lead_org_id: "org-1", replayed: state.replay }],
          error: null,
        };
      }
      throw new Error("unexpected rpc " + name);
    },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        state.writes.push({ table, row });
        return { error: null };
      },
    }),
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

const post = (headers: Record<string, string> = {}, body: Record<string, unknown> = {}) =>
  POST(
    new NextRequest("https://crm.example/api/public/enquiries", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        org: "gnk",
        name: "A Buyer",
        email: "buyer@example.invalid",
        message: "Is PAF0001 still available?",
        ...body,
      }),
    }),
  );

beforeEach(() => {
  state.hits = [];
  state.refuseAt = -1;
  state.submits = [];
  state.replay = false;
  state.writes = [];
  vi.mocked(sendEnquiryAlert).mockClear();
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
        p_idempotency_key: "",
        p_meta: null,
      },
    ]);
  });
});

/**
 * 0098 (audit LR-01/02): the site's structured brief and provenance travel
 * as `meta`. The route cleans them against the allowlist (a useful 400-side
 * copy of the function's own rule), forwards them as p_meta, and hands them
 * to the alert so the desk's e-mail can say where the lead came from.
 */
describe("the brief travels as data", () => {
  it("forwards the allowlisted meta to the function, cleaned, and nothing else", async () => {
    const res = await post(
      { "x-gnk-forward-key": KEY },
      { meta: { budget: "over_1m", email: "x@y.invalid", utm_source: " instagram " } },
    );
    expect(res.status).toBe(202);
    expect(state.submits[0]!.p_meta).toEqual({ budget: "over_1m", utm_source: "instagram" });
    expect(sendEnquiryAlert).toHaveBeenCalledWith(
      expect.objectContaining({ meta: { budget: "over_1m", utm_source: "instagram" } }),
    );
  });

  it("sends null meta when the caller sent none", async () => {
    await post({ "x-gnk-forward-key": KEY });
    expect(state.submits[0]!.p_meta).toBeNull();
    expect(sendEnquiryAlert).toHaveBeenCalledWith(expect.objectContaining({ meta: null }));
  });
});

/**
 * 0096 (integrations audit 2026-09-15, INT-02 and INT-01): the key the site
 * mints per form goes through to the function, a replay alerts nobody twice,
 * and the alert's outcome lands on the lead's timeline after the answer.
 */
describe("the door is idempotent by key, and records what it told the desk", () => {
  it("forwards the caller's idempotency key to the function", async () => {
    const res = await post({ "x-gnk-forward-key": KEY }, { idempotency_key: "3f2a9c1e-0b7d-4c6e-8a9f-0b1c2d3e4f50" });
    expect(res.status).toBe(202);
    expect(state.submits[0]!.p_idempotency_key).toBe("3f2a9c1e-0b7d-4c6e-8a9f-0b1c2d3e4f50");
  });

  it("a replay is accepted, alerts nobody a second time, and writes nothing", async () => {
    state.replay = true;
    const res = await post({ "x-gnk-forward-key": KEY }, { idempotency_key: "3f2a9c1e-0b7d-4c6e-8a9f-0b1c2d3e4f50" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(sendEnquiryAlert).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  it("records the alert's outcome on the lead after answering — outcome only, no address", async () => {
    const res = await post({ "x-gnk-forward-key": KEY });
    expect(res.status).toBe(202);
    expect(sendEnquiryAlert).toHaveBeenCalledTimes(1);
    expect(state.writes).toEqual([
      {
        table: "events",
        row: {
          org_id: "org-1",
          actor_id: null,
          entity_type: "lead",
          entity_id: "lead-1",
          event_type: "enquiry_alert",
          payload: { outcome: "skipped", provider: "resend" },
        },
      },
    ]);
    expect(JSON.stringify(state.writes)).not.toContain("buyer@example.invalid");
  });

  it("a function that answers no row is still 'unknown org', and alerts nobody", async () => {
    // The refusal shape changed from `false` to zero rows (0096); the route's
    // reading of it must not.
    const admin = await import("@/lib/supabase/admin");
    const spy = vi.spyOn(admin, "createAdminClient").mockReturnValue({
      rpc: async (name: string) =>
        name === "submit_public_enquiry" ? { data: [], error: null } : { data: false, error: null },
      from: () => ({ insert: async () => ({ error: null }) }),
    } as never);
    try {
      const res = await post({ "x-gnk-forward-key": KEY });
      expect(res.status).toBe(400);
      expect(sendEnquiryAlert).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
