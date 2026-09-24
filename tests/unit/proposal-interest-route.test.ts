import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashIp } from "@/lib/services/ip-hash";
import { RATE_LIMIT } from "@/lib/services/enquiry-budget";
import { runEnquiryAlertWorker } from "@/lib/services/enquiry-alert-worker";
import { sendEnquiryAck } from "@/lib/services/enquiry-ack";
import { POST } from "@/app/api/public/proposals/interest/route";

/**
 * The "I'm interested" door on a shared proposal (0106). Same construction
 * as the website enquiry route: the database function is the boundary and
 * decides everything about the link, the property and the org; this file
 * pins what the ROUTE adds — the 400s, the rate meter, the honeypot, that
 * the token reaches the database only as its digest, that the accelerator
 * and the acknowledgement run for a fresh lead and for nothing else, and
 * that a refused link answers one neutral 404.
 *
 * Faked: the admin client (records the meter and the function call), the
 * request-scoped IP hash, the worker, the acknowledgement, and `after()`
 * (run inline, awaited before the response is judged).
 */
const state = vi.hoisted(() => ({
  hits: [] as Array<{ hash: string; limit: number }>,
  refuseAt: -1,
  submits: [] as Array<Record<string, unknown>>,
  /** what the function answers: rows (a lead), no rows (refused), or an error */
  answer: "lead" as "lead" | "replay" | "refused" | "error",
  afters: [] as Promise<unknown>[],
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "note_public_enquiry_hit") {
        state.hits.push({ hash: String(args.p_ip_hash), limit: Number(args.p_limit) });
        return { data: state.hits.length - 1 === state.refuseAt, error: null };
      }
      if (name === "submit_proposal_interest") {
        state.submits.push(args);
        if (state.answer === "error") return { data: null, error: { message: "relation leads does not exist", code: "42P01" } };
        if (state.answer === "refused") return { data: [], error: null };
        return { data: [{ lead_id: "lead-9", lead_org_id: "org-1", replayed: state.answer === "replay" }], error: null };
      }
      throw new Error("unexpected rpc " + name);
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => (table === "organizations" ? { data: { name: "GN Kalaitsidis Capital" }, error: null } : { data: null, error: null }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/services/enquiry-ack", () => ({ sendEnquiryAck: vi.fn(async () => "skipped") }));
vi.mock("@/lib/services/caller-ip", async () => {
  const { hashIp } = await import("@/lib/services/ip-hash");
  return { callerIpHash: async () => hashIp("203.0.113.7") };
});
vi.mock("@/lib/services/enquiry-alert-worker", () => ({
  runEnquiryAlertWorker: vi.fn(async () => ({ claimed: 1, accepted: 1, retried: 0, failed: 0, cancelled: 0, released: 0, lost: 0, skipped: null, error: null })),
}));
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return {
    ...original,
    after: (fn: () => unknown) => {
      state.afters.push(Promise.resolve().then(fn));
    },
  };
});

const TOKEN = randomBytes(32).toString("base64url");
const DIGEST = createHash("sha256").update(TOKEN).digest("hex");
const TRANSPORT = hashIp("203.0.113.7");

const post = async (body: Record<string, unknown> = {}, headers: Record<string, string> = { "content-type": "application/json" }, raw?: string) => {
  const res = await POST(
    new NextRequest("https://crm.example/api/public/proposals/interest", {
      method: "POST",
      headers,
      body:
        raw ??
        JSON.stringify({
          token: TOKEN,
          property_reference: "PAF0007",
          name: "  A Buyer ",
          email: "buyer@example.invalid",
          idempotency_key: "form-1234-abcd",
          ...body,
        }),
    }),
  );
  await Promise.all(state.afters.splice(0));
  return res;
};

beforeEach(() => {
  state.hits = [];
  state.refuseAt = -1;
  state.submits = [];
  state.answer = "lead";
  state.afters = [];
  vi.mocked(runEnquiryAlertWorker).mockClear();
  vi.mocked(sendEnquiryAck).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("shape: a useful 400 before anything touches the database", () => {
  it("wants JSON", async () => {
    expect((await post({}, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post({}, { "content-type": "application/json" }, "{not json")).status).toBe(400);
    expect(state.hits, "no meter round trip for junk").toHaveLength(0);
  });

  it("refuses a malformed token, a missing reference, a missing name, no way to reply and a bad key — without calling the function", async () => {
    expect((await post({ token: "../../etc" })).status).toBe(400);
    expect((await post({ property_reference: "" })).status).toBe(400);
    expect((await post({ name: "   " })).status).toBe(400);
    expect((await post({ email: "", phone: "" })).status).toBe(400);
    expect((await post({ email: "not-an-email" })).status).toBe(400);
    expect((await post({ idempotency_key: "bad key!" })).status).toBe(400);
    expect(state.submits).toHaveLength(0);
  });

  it("a 400 carries a stable code and the field it concerns, so the page can speak the visitor's language (audit 2026-09-22)", async () => {
    const body = async (over: Record<string, unknown>) => (await post(over)).json();
    expect(await body({ name: "   " })).toMatchObject({ code: "name_required", field: "name" });
    expect(await body({ name: "x".repeat(201) })).toMatchObject({ code: "name_too_long", field: "name" });
    expect(await body({ email: "not-an-email" })).toMatchObject({ code: "email_invalid", field: "email" });
    expect(await body({ email: "", phone: "" })).toMatchObject({ code: "contact_required", field: "contact" });
    expect(await body({ phone: "9".repeat(41) })).toMatchObject({ code: "phone_too_long", field: "phone" });
    expect(await body({ message: "m".repeat(5001) })).toMatchObject({ code: "message_too_long", field: "message" });
    // what only the page can get wrong has no visitor field
    expect(await body({ token: "../../etc" })).toMatchObject({ code: "invalid_token", field: null });
    expect(await body({ idempotency_key: "bad key!" })).toMatchObject({ code: "idempotency_key_invalid", field: null });
    // and every one still carries an English sentence for a caller that is not the page
    const b = (await body({ name: "" })) as { error?: string };
    expect(typeof b.error).toBe("string");
    expect(b.error).not.toMatch(/too_small|invalid_type|expected/i);
    expect(state.submits).toHaveLength(0);
  });

  it("a line break in the name or the phone is its own code on its own field — never 'name required' (T-enquiry-identity-single-line)", async () => {
    const body = async (over: Record<string, unknown>) => (await post(over)).json();
    expect(await body({ name: "Example\nextra\nextra\nextra\nextra" })).toMatchObject({ code: "name_line_break", field: "name" });
    expect(await body({ name: "Example\r\nEmail: other@x.invalid" })).toMatchObject({ code: "name_line_break", field: "name" });
    expect(await body({ phone: "+35799123456\nEmail: other@x.invalid" })).toMatchObject({ code: "phone_line_break", field: "phone" });
    expect(await body({ property_reference: "PAF0007\nEmail: other@x.invalid" })).toMatchObject({
      code: "property_reference_invalid",
      field: null,
    });
    const b = (await body({ name: "A\nB" })) as { error?: string };
    expect(b.error).toMatch(/name must be on one line/i);
    expect(state.hits, "the meter is not spent").toHaveLength(0);
    expect(state.submits, "the function is never called").toHaveLength(0);
  });

  it("transport refusals carry a code too: 415 and unparseable JSON", async () => {
    const unsupported = await post({}, { "content-type": "text/plain" });
    expect(await unsupported.json()).toMatchObject({ code: "unsupported_media_type", field: null });
    const notJson = await post({}, { "content-type": "application/json" }, "{not json");
    expect(await notJson.json()).toMatchObject({ code: "invalid_json", field: null });
  });
});

describe("the meter and the honeypot", () => {
  it("meters the caller with the enquiry door's own counter and limit, before the function", async () => {
    const res = await post();
    expect(res.status).toBe(202);
    expect(state.hits).toEqual([{ hash: TRANSPORT, limit: RATE_LIMIT }]);
  });

  it("answers 429 with Retry-After when over budget, and writes nothing", async () => {
    state.refuseAt = 0;
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
    expect(await res.json()).toMatchObject({ code: "rate_limited", field: null });
    expect(state.submits).toHaveLength(0);
    expect(runEnquiryAlertWorker).not.toHaveBeenCalled();
  });

  it("a filled honeypot is accepted as far as the caller can tell, and dropped", async () => {
    const res = await post({ website: "http://spam.example" });
    expect(res.status).toBe(202);
    expect(state.submits).toHaveLength(0);
    expect(runEnquiryAlertWorker).not.toHaveBeenCalled();
    expect(sendEnquiryAck).not.toHaveBeenCalled();
  });
});

describe("a fresh interest", () => {
  it("reaches the function as a digest — the raw token never leaves the request — with the fields trimmed", async () => {
    const res = await post({ phone: " +357 99 000000 ", message: "  Is it still available? " });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin"), "same-origin only: the page lives here").toBeNull();
    expect(state.submits).toHaveLength(1);
    expect(state.submits[0]).toEqual({
      p_token_sha256: DIGEST,
      p_property_ref: "PAF0007",
      p_name: "A Buyer",
      p_email: "buyer@example.invalid",
      p_phone: "+357 99 000000",
      p_message: "Is it still available?",
      p_idempotency_key: "form-1234-abcd",
    });
    expect(JSON.stringify(state.submits), "the raw token is not an argument").not.toContain(TOKEN);
  });

  it("runs the accelerator for that lead and acknowledges the enquirer about that property", async () => {
    await post();
    expect(runEnquiryAlertWorker).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runEnquiryAlertWorker).mock.calls[0]![1]).toMatchObject({ leadId: "lead-9", limit: 1 });
    expect(sendEnquiryAck).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEnquiryAck).mock.calls[0]![0]).toMatchObject({
      name: "A Buyer",
      email: "buyer@example.invalid",
      propertyReference: "PAF0007",
      orgName: "GN Kalaitsidis Capital",
    });
  });

  it("with a phone only there is nothing to acknowledge by e-mail, but the desk is still told", async () => {
    await post({ email: "", phone: "+357 99 000000" });
    expect(runEnquiryAlertWorker).toHaveBeenCalledTimes(1);
    expect(sendEnquiryAck).not.toHaveBeenCalled();
  });
});

describe("what the function refuses or replays", () => {
  it("a replay is accepted again and nothing else happens — no second alert, no second acknowledgement", async () => {
    state.answer = "replay";
    const res = await post();
    expect(res.status).toBe(202);
    expect(runEnquiryAlertWorker).not.toHaveBeenCalled();
    expect(sendEnquiryAck).not.toHaveBeenCalled();
  });

  it("no rows — an expired, revoked or unknown link, or a reference outside it — is one neutral 404", async () => {
    state.answer = "refused";
    const res = await post();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "This link is no longer available.", code: "link_unavailable", field: null });
    expect(runEnquiryAlertWorker).not.toHaveBeenCalled();
    expect(sendEnquiryAck).not.toHaveBeenCalled();
  });

  it("a database error is 503 in our words, never the database's", async () => {
    state.answer = "error";
    const res = await post();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).not.toContain("relation");
    expect(body).toMatchObject({ code: "unavailable", field: null });
    expect(runEnquiryAlertWorker).not.toHaveBeenCalled();
  });
});
