import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { documentEventWritten, EventWriteError, logEvent, logEvents, type LogEventParams } from "./events";

/**
 * T-log-event-hollow, through the REAL client: supabase-js / postgrest-js as
 * the app builds them, with only `fetch` replaced. Every answer below reached
 * logEvent's old `if (error)` as `error: null` (or a falsy error) and was taken
 * for a written event (measured on postgrest-js 2.110.2) — 116 call sites
 * across 32 files then carried on as if the timeline had its line.
 *
 * PostgREST answers a committed insert with 201 Created, an empty body and
 * `Content-Range: *\/*` (measured on the local stack, PostgREST v14.5, for one
 * row and for many) — the first case here is that answer, byte for byte.
 */

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

type Seen = { method: string; url: URL; body: unknown };

/** A client whose every request is answered by `answer()`, and recorded. */
function clientAnswering(answer: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const supabase = createClient<Database>("http://stub.invalid", "anon-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        seen.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return answer();
      },
    },
  });
  return { supabase, seen };
}

const CREATED = () => new Response(null, { status: 201, statusText: "Created", headers: { "content-range": "*/*" } });

const EVENT: LogEventParams = {
  orgId: "org-1",
  actorId: "user-1",
  entityType: "contact",
  entityId: "contact-1",
  eventType: "updated",
  payload: { sections: ["identity"] },
};

describe("a confirmed write resolves, and is the request it claims to be", () => {
  it("logEvent: one row, POSTed to events, answered 201", async () => {
    const { supabase, seen } = clientAnswering(CREATED);
    await expect(logEvent(supabase, EVENT)).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url.pathname).toBe("/rest/v1/events");
    expect(seen[0].body).toEqual({
      org_id: "org-1",
      actor_id: "user-1",
      entity_type: "contact",
      entity_id: "contact-1",
      event_type: "updated",
      payload: { sections: ["identity"] },
    });
  });

  it("logEvents: many rows in ONE request, answered 201", async () => {
    const { supabase, seen } = clientAnswering(CREATED);
    await expect(logEvents(supabase, [EVENT, { ...EVENT, entityId: "contact-2" }])).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect((seen[0].body as unknown[]).length).toBe(2);
  });

  it("logEvents: nothing to write sends nothing", async () => {
    const { supabase, seen } = clientAnswering(CREATED);
    await expect(logEvents(supabase, [])).resolves.toBeUndefined();
    expect(seen).toHaveLength(0);
  });
});

/** [what arrived, the answer, what the refusal must say] */
const HOLLOW: [string, () => Response, string][] = [
  ["an OK answer with an empty body", () => new Response("", { status: 200, headers: JSON_HEADERS }), "the write was not confirmed (HTTP 200)"],
  ["a 204 with no body", () => new Response(null, { status: 204 }), "the write was not confirmed (HTTP 204)"],
  ["a 404 with an empty body (postgrest-js reports 204)", () => new Response(null, { status: 404 }), "the write was not confirmed (HTTP 204)"],
  ["an OK answer whose body is an empty list", () => new Response("[]", { status: 200, headers: JSON_HEADERS }), "the write was not confirmed (HTTP 200)"],
  ["a 500 whose body is null (postgrest-js reports no error)", () => new Response("null", { status: 500, headers: JSON_HEADERS }), "the write was not confirmed (HTTP 500)"],
  ["a 502 whose body is 0 (a falsy error)", () => new Response("0", { status: 502, headers: JSON_HEADERS }), "the write was not confirmed (HTTP 502)"],
  ["a 500 whose body is false (a falsy error)", () => new Response("false", { status: 500, headers: JSON_HEADERS }), "the write was not confirmed (HTTP 500)"],
  ['a 503 whose body is "" (a falsy error)', () => new Response('""', { status: 503, headers: JSON_HEADERS }), "the write was not confirmed (HTTP 503)"],
  // a truthy error that carries no words is named by its status, not "undefined"
  ["a 500 whose error has no message", () => new Response('{"code":"XX000"}', { status: 500, headers: JSON_HEADERS }), "HTTP 500"],
  ["a 500 whose error message is empty", () => new Response('{"message":""}', { status: 500, headers: JSON_HEADERS }), "HTTP 500"],
  // …and one whose "message" is not text is not printed as "[object Object]"
  ["a 500 whose error message is not text", () => new Response('{"message":{"detail":"x"}}', { status: 500, headers: JSON_HEADERS }), "HTTP 500"],
];

describe("an answer that does not confirm the write is refused, by name", () => {
  it.each(HOLLOW)("logEvent: %s", async (_, answer, says) => {
    const { supabase } = clientAnswering(answer);
    await expect(logEvent(supabase, EVENT)).rejects.toThrow(`logEvent failed (contact.updated): ${says}`);
  });

  it.each(HOLLOW)("logEvents: %s", async (_, answer, says) => {
    const { supabase } = clientAnswering(answer);
    await expect(logEvents(supabase, [EVENT, EVENT])).rejects.toThrow(`logEvents failed (2 rows): ${says}`);
  });
});

describe("a refusal with words keeps its words", () => {
  it("an RLS refusal (403, 42501) reads as it always did", async () => {
    const { supabase } = clientAnswering(
      () =>
        new Response(
          JSON.stringify({ code: "42501", message: 'new row violates row-level security policy for table "events"' }),
          { status: 403, headers: JSON_HEADERS },
        ),
    );
    await expect(logEvent(supabase, EVENT)).rejects.toThrow(
      'logEvent failed (contact.updated): new row violates row-level security policy for table "events"',
    );
  });

  it("a request that never got an answer (the fetch itself failed) names the failure", async () => {
    const { supabase } = clientAnswering(() => Promise.reject(new TypeError("fetch failed")));
    await expect(logEvent(supabase, EVENT)).rejects.toThrow(/^logEvent failed \(contact\.updated\): TypeError: fetch failed/);
  });
});

/**
 * Whether the database REFUSED the line — and so did not write it — is what
 * decides if an action may undo its own write (the evidence report, the
 * viewing confirmation). Only a code `certainlyRolledBack` understands says so
 * (DECISIONS T-media-insert-outcome); everything else may have written the
 * line — a CODE included: 57014 / 53 / 58 / XX can be reported for a COMMIT
 * that went through, class 08 comes from in front of Postgres, PGRST111 / 112
 * are built after the commit (T-refusal-allowlist).
 */
const refusalOf = async (answer: () => Response | Promise<Response>) => {
  const { supabase } = clientAnswering(answer);
  const e = await logEvent(supabase, EVENT).then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(EventWriteError);
  return (e as EventWriteError).refused;
};
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

describe("EventWriteError says whether the database refused the line", () => {
  it.each([
    ["an RLS refusal (403, 42501)", json(403, { code: "42501", message: "new row violates row-level security policy" })],
    ["a foreign-key refusal (409, 23503)", json(409, { code: "23503", message: "violates foreign key constraint" })],
    ["a PostgREST refusal (400, PGRST204)", json(400, { code: "PGRST204", message: "Could not find the column" })],
    ["an expired session (401, PGRST301)", json(401, { code: "PGRST301", message: "JWT expired" })],
    ["a serialization failure (40001)", json(500, { code: "40001", message: "could not serialize access" })],
    // its words are missing, its code is not
    ["a refusal with no message (403, 42501)", json(403, { code: "42501" })],
  ])("refused: %s", async (_, answer) => {
    expect(await refusalOf(answer)).toBe(true);
  });

  it.each([
    // every answer above that carries no code (the one that does is a refusal, above)
    ...HOLLOW.filter(([what]) => what !== "a 500 whose error has no message").map(
      ([what, answer]) => [what, answer] as [string, () => Response],
    ),
    ["a gateway's words with no code (502)", json(502, { message: "An invalid response was received from the upstream server" })],
    ["a code that is not text (502)", json(502, { code: 502, message: "Bad gateway" })],
    // a refusal's code as a NUMBER is a gateway's body, not PostgreSQL's — never coerced
    ["an allowlisted SQLSTATE as a number (403, 42501)", json(403, { code: 42501, message: "denied" })],
    ["an empty code (500)", json(500, { code: "", message: "x" })],
    // a CODE that can follow a commit is not a refusal (T-refusal-allowlist)
    ["an internal error (500, XX000)", json(500, { code: "XX000", message: "internal error" })],
    ["an internal error with no message (500, XX000)", json(500, { code: "XX000" })],
    ["a statement timeout (500, 57014)", json(500, { code: "57014", message: "canceling statement due to statement timeout" })],
    ["out of memory (500, 53200)", json(500, { code: "53200", message: "out of memory" })],
    ["a connection exception (503, 08006)", json(503, { code: "08006", message: "connection failure" })],
    ["statement completion unknown (40003)", json(500, { code: "40003", message: "statement completion unknown" })],
    ["no pool connection answered (503, PGRST001)", json(503, { code: "PGRST001", message: "Database client error" })],
    ["a response built after the commit (500, PGRST111)", json(500, { code: "PGRST111", message: "Invalid response.headers" })],
    ["a code nobody has classified (500, PGRST999)", json(500, { code: "PGRST999", message: "new" })],
  ])("not refused — the line may be written: %s", async (_, answer) => {
    expect(await refusalOf(answer)).toBe(false);
  });

  it("not refused — the line may be written: the fetch itself failed", async () => {
    expect(await refusalOf(() => Promise.reject(new TypeError("fetch failed")))).toBe(false);
  });

  it("logEvents carries the same verdict", async () => {
    const { supabase } = clientAnswering(json(403, { code: "42501", message: "denied" }));
    const e = await logEvents(supabase, [EVENT]).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(EventWriteError);
    expect((e as EventWriteError).refused).toBe(true);
  });
});

describe("documentEventWritten reads the one line back, or says it could not", () => {
  const Q = {
    orgId: "org-1",
    entityType: "viewing" as const,
    entityId: "viewing-1",
    eventType: "viewing_confirmation_generated",
    documentId: "doc-1",
  };

  it("asks for that line exactly: org, entity, type and the document it names", async () => {
    const { supabase, seen } = clientAnswering(json(200, []));
    await documentEventWritten(supabase, Q);
    expect(seen).toHaveLength(1);
    const p = seen[0].url.searchParams;
    expect(seen[0].url.pathname).toBe("/rest/v1/events");
    expect([p.get("org_id"), p.get("entity_type"), p.get("entity_id"), p.get("event_type"), p.get("payload->>document_id"), p.get("limit")]).toEqual([
      "eq.org-1",
      "eq.viewing",
      "eq.viewing-1",
      "eq.viewing_confirmation_generated",
      "eq.doc-1",
      "1",
    ]);
  });

  it.each([
    ["the line is there", json(200, [{ id: 7 }]), true],
    ["no such line", json(200, []), false],
    ["the read failed", json(500, { code: "XX000", message: "x" }), null],
    ["the read came back hollow", () => new Response("", { status: 200, headers: JSON_HEADERS }), null],
    ["the read came back null under a 500", json(500, null), null],
  ] as [string, () => Response, boolean | null][])("%s → %s", async (_, answer, want) => {
    const { supabase } = clientAnswering(answer);
    expect(await documentEventWritten(supabase, Q)).toBe(want);
  });
});
