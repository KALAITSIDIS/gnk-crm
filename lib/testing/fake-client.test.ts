import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { logEvent } from "@/lib/services/events";
import { fakeClient } from "./fake-client";

/**
 * The fake answers an insert as PostgREST does (201 Created, no rows unless
 * selected — measured on the local stack), and only an insert: logEvent
 * refuses an insert answer that is not a 201 (T-log-event-hollow), so a fake
 * that drifted from the real answer would either fail every event write in
 * ~50 test files or hide the refusal a test means to script.
 */
type Chain = { from: (t: string) => Record<string, (...a: unknown[]) => unknown> };
const as = (c: unknown) => c as Chain;

describe("fakeClient answers an insert as PostgREST does", () => {
  it("an unscripted insert: 201 Created, no rows", async () => {
    const fake = fakeClient({});
    expect(await as(fake.client).from("events").insert({ a: 1 })).toEqual({
      data: null,
      error: null,
      status: 201,
      statusText: "Created",
    });
  });

  it("an unscripted insert that selects: 201 Created, an empty list", async () => {
    const fake = fakeClient({});
    const chain = as(fake.client).from("tasks").insert({ a: 1 }) as { select: (c: string) => unknown };
    expect(await chain.select("id")).toEqual({ data: [], error: null, status: 201, statusText: "Created" });
  });

  it("a scripted insert page keeps its own fields, a status included — a hollow answer can be scripted", async () => {
    const fake = fakeClient({ events: [{ data: null, error: null, status: 204, statusText: "No Content" }] });
    await expect(
      logEvent(fake.client as unknown as SupabaseClient<Database>, {
        orgId: "o",
        entityType: "contact",
        eventType: "updated",
      }),
    ).rejects.toThrow("logEvent failed (contact.updated): the write was not confirmed (HTTP 204)");
  });

  it("a failed insert page is left as scripted", async () => {
    const failed = { data: null, error: { message: "denied", code: "42501" } };
    const fake = fakeClient({ events: [failed] });
    expect(await as(fake.client).from("events").insert({ a: 1 })).toEqual(failed);
  });

  it("a read is untouched: no status, the default page", async () => {
    const fake = fakeClient({});
    const chain = as(fake.client).from("contacts").select("id") as { eq: (c: string, v: string) => unknown };
    expect(await chain.eq("id", "x")).toEqual({ data: [], error: null });
  });

  it("an upsert is not an insert: its status is the test's to name", async () => {
    const fake = fakeClient({});
    expect(await as(fake.client).from("portal_connections").upsert({ a: 1 })).toEqual({ data: [], error: null });
  });
});
