import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { rowsOf } from "./rows";

/**
 * `rowsOf` — `[]` is the only "none" (T-erasure-null-answers). The second half
 * runs the REAL client (supabase-js / postgrest-js, only `fetch` replaced): the
 * answers below reached the erasure as `data: null` with no error, or a falsy
 * one, and each read as "no rows".
 */
describe("rowsOf", () => {
  it("returns the rows, a genuine empty answer included", () => {
    expect(rowsOf({ data: [{ id: 1 }], error: null, status: 200 }, "deals")).toEqual([{ id: 1 }]);
    expect(rowsOf({ data: [], error: null, status: 200 }, "deals")).toEqual([]);
  });

  it("throws on an error, labelled — and names the status when the message is empty", () => {
    expect(() => rowsOf({ data: null, error: { message: "permission denied" }, status: 403 }, "deals")).toThrow(
      "deals: permission denied",
    );
    expect(() => rowsOf({ data: null, error: { message: "" }, status: 504 }, "deals")).toThrow("deals: HTTP 504");
    expect(() => rowsOf({ data: null, error: { message: "" } }, "deals")).toThrow("deals: HTTP error");
  });

  it("throws on an answer with no rows array — null, an object, a string — naming the status", () => {
    expect(() => rowsOf({ data: null, error: null, status: 204 }, "deals")).toThrow(
      "deals: the answer held no rows (HTTP 204)",
    );
    expect(() => rowsOf({ data: null, error: null }, "deals")).toThrow("deals: the answer held no rows (HTTP ?)");
    expect(() => rowsOf({ data: { id: 1 } as never, error: null, status: 200 }, "deals")).toThrow(
      "deals: the answer held no rows (HTTP 200)",
    );
    expect(() => rowsOf({ data: "" as never, error: null, status: 200 }, "deals")).toThrow(
      "deals: the answer held no rows (HTTP 200)",
    );
  });

  it("a falsy error (a 500 whose body is 0) is refused by the rows check", () => {
    expect(() => rowsOf({ data: null, error: 0, status: 500 }, "deals")).toThrow(
      "deals: the answer held no rows (HTTP 500)",
    );
  });
});

describe("rowsOf through the real client", () => {
  const JSONH = { "content-type": "application/json; charset=utf-8" };
  const answering = (answer: () => Response) =>
    createClient("http://stub.invalid", "anon-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async () => answer() },
    });

  it.each([
    ["an OK answer with an empty body", () => new Response("", { status: 200, headers: JSONH }), "HTTP 200"],
    ["a 404 with an empty body (postgrest-js reports 204)", () => new Response(null, { status: 404 }), "HTTP 204"],
    ["an OK answer whose body is null", () => new Response("null", { status: 200, headers: JSONH }), "HTTP 200"],
    ["a 500 whose body is null", () => new Response("null", { status: 500, headers: JSONH }), "HTTP 500"],
    ["a 500 whose body is 0", () => new Response("0", { status: 500, headers: JSONH }), "HTTP 500"],
  ] as const)("a list read: %s", async (_, answer, status) => {
    const res = await answering(answer).from("deals").select("id").eq("buyer_contact_id", "c1");
    expect(() => rowsOf(res, "deals")).toThrow(`deals: the answer held no rows (${status})`);
  });

  it("a write's returned rows: an OK answer with an empty body", async () => {
    const res = await answering(() => new Response("", { status: 200, headers: JSONH }))
      .from("leads")
      .update({ message: "x" })
      .eq("contact_id", "c1")
      .select("id");
    expect(() => rowsOf(res, "lead messages")).toThrow("lead messages: the answer held no rows (HTTP 200)");
  });

  it("the control: a genuine empty answer is []", async () => {
    const res = await answering(() => new Response("[]", { status: 200, headers: JSONH })).from("deals").select("id");
    expect(rowsOf(res, "deals")).toEqual([]);
  });
});
