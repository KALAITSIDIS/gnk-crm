import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

/**
 * T-null-answer-guard, through the REAL client: supabase-js / postgrest-js as
 * the app builds them, with only `fetch` replaced, answering the way a gateway,
 * a proxy or a misrouted URL can. Each of these reached `fetchAll` and
 * `unwrapRows` as `data: null, error: null` (measured on postgrest-js 2.110.2)
 * and was read as "no rows" — an empty list, or, on a later page, the pages
 * before it as everything.
 */
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

const { fetchAll, fetchUpTo } = await import("./fetch-all");
const { unwrapRows } = await import("./unwrap");

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** A client whose every request is answered by `answer(offset)`. */
function clientAnswering(answer: (offset: number) => Response) {
  return createClient("http://stub.invalid", "anon-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return answer(Number(url.searchParams.get("offset") ?? 0));
      },
    },
  });
}

const HOLLOW: [string, () => Response, string][] = [
  ["an OK answer with an empty body", () => new Response("", { status: 200, headers: JSON_HEADERS }), "HTTP 200"],
  ["a 404 with an empty body (postgrest-js reports 204)", () => new Response(null, { status: 404 }), "HTTP 204"],
  ["an OK answer whose body is null", () => new Response("null", { status: 200, headers: JSON_HEADERS }), "HTTP 200"],
  ["a 500 whose body is null (postgrest-js reports no error)", () => new Response("null", { status: 500, headers: JSON_HEADERS }), "HTTP 500"],
  ["a 500 whose body is 0 (a falsy error)", () => new Response("0", { status: 500, headers: JSON_HEADERS }), "HTTP 500"],
  ["an OK answer that is an object, not a list", () => new Response('{"id":"a"}', { status: 200, headers: JSON_HEADERS }), "HTTP 200"],
  // a string is not a list either — `""` has a length of 0 and read as "no rows"
  ["an OK answer that is a string, not a list", () => new Response('""', { status: 200, headers: JSON_HEADERS }), "HTTP 200"],
];

describe("a list read whose answer holds no rows array fails, by name", () => {
  it.each(HOLLOW)("unwrapRows: %s", async (_, answer, status) => {
    const supabase = clientAnswering(answer);
    const res = await supabase.from("property_keys").select("id").eq("property_id", "p1");
    expect(() => unwrapRows(res, "property keys")).toThrow(
      `Query failed (property keys): the answer held no rows (${status})`,
    );
  });

  it.each(HOLLOW)("fetchAll: %s", async (_, answer, status) => {
    const supabase = clientAnswering(answer);
    await expect(
      fetchAll((from, to) => supabase.from("properties").select("id").order("id").range(from, to), "units"),
    ).rejects.toThrow(`Query failed (units): the answer held no rows (${status})`);
  });

  it("fetchAll: a full first page, then an empty-bodied OK answer — the first 1,000 are not the answer", async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: String(i).padStart(4, "0") }));
    const supabase = clientAnswering((offset) =>
      offset === 0
        ? new Response(JSON.stringify(page), { status: 200, headers: JSON_HEADERS })
        : new Response("", { status: 200, headers: JSON_HEADERS }),
    );
    await expect(
      fetchAll((from, to) => supabase.from("properties").select("id").order("id").range(from, to), "units"),
    ).rejects.toThrow("Query failed (units): the answer held no rows (HTTP 200)");
  });

  it("fetchUpTo (the list exports): a 404 with an empty body — the status postgrest-js reports is named", async () => {
    const supabase = clientAnswering(() => new Response(null, { status: 404 }));
    await expect(
      fetchUpTo((from, to) => supabase.from("leads").select("id").order("id").range(from, to), "leads export", 10_000),
    ).rejects.toThrow("Query failed (leads export): the answer held no rows (HTTP 204)");
  });

  it("a genuine empty answer is still [] — the control", async () => {
    const supabase = clientAnswering(() => new Response("[]", { status: 200, headers: JSON_HEADERS }));
    expect(unwrapRows(await supabase.from("property_keys").select("id"), "property keys")).toEqual([]);
    expect(
      await fetchAll((from, to) => supabase.from("properties").select("id").order("id").range(from, to), "units"),
    ).toEqual([]);
  });

  it("a bodiless failure is named by its status, not an empty message", async () => {
    const supabase = clientAnswering(() => new Response("", { status: 504 }));
    const res = await supabase.from("property_keys").select("id");
    expect(() => unwrapRows(res, "property keys")).toThrow("Query failed (property keys): HTTP 504");
    await expect(
      fetchAll((from, to) => supabase.from("properties").select("id").order("id").range(from, to), "units"),
    ).rejects.toThrow("Query failed (units): HTTP 504");
  });
});
