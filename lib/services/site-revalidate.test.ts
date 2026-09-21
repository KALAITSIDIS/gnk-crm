import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import {
  notifySite,
  notifySiteAfter,
  notifySiteIfPublic,
  resetSiteRevalidateLatch,
} from "./site-revalidate";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));

/**
 * Telling the marketing site that a listing changed.
 *
 * The site rebuilds a page when it is next asked for, and until 2026-09-13
 * "next asked for" was governed by time alone: on a quiet day it served a
 * render measured five days old. It now has a revalidate door, and this is
 * the hand that knocks. Rules, in order of importance: a failed knock must
 * never fail the write that caused it; an unconfigured knock skips loudly
 * rather than silently; the key never appears in a log line.
 */
const OLD = { ...process.env };
const URL_ = "https://site.example/api/revalidate";

beforeEach(() => {
  resetSiteRevalidateLatch();
  vi.restoreAllMocks();
  vi.mocked(Sentry.captureMessage).mockReset();
});
afterEach(() => {
  process.env = { ...OLD };
});

describe("notifySite", () => {
  it("SKIPS without configuration, warns once per instance, never touches the network", async () => {
    delete process.env.SITE_REVALIDATE_URL;
    delete process.env.SITE_REVALIDATE_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await notifySite("PAF0001")).toBe("skipped");
    expect(await notifySite("PAF0002")).toBe("skipped");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("SITE_REVALIDATE")).length).toBe(1);
  });

  it("posts the reference with the key in a header, and a timeout", async () => {
    process.env.SITE_REVALIDATE_URL = URL_;
    process.env.SITE_REVALIDATE_KEY = "k-secret";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await notifySite("PAF0001")).toBe("sent");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(URL_);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-gnk-revalidate-key"]).toBe("k-secret");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ reference: "PAF0001" });
    expect(init.signal, "a knock that hangs must not hold the request").toBeInstanceOf(AbortSignal);
  });

  it("sends no reference key when there is none — the site rebuilds the home and the list", async () => {
    process.env.SITE_REVALIDATE_URL = URL_;
    process.env.SITE_REVALIDATE_KEY = "k-secret";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await notifySite(null)).toBe("sent");
    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body))).toEqual({});
  });

  it("reports a refusal as failed, logs the status and never the key, and does not throw", async () => {
    process.env.SITE_REVALIDATE_URL = URL_;
    process.env.SITE_REVALIDATE_KEY = "k-secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await notifySite("PAF0001")).toBe("failed");
    expect(error).toHaveBeenCalledTimes(1);
    const line = error.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toContain("401");
    expect(line).not.toContain("k-secret");
  });

  it("reports a thrown fetch as failed and does not throw", async () => {
    process.env.SITE_REVALIDATE_URL = URL_;
    process.env.SITE_REVALIDATE_KEY = "k-secret";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notifySite("PAF0001")).resolves.toBe("failed");
  });
});

describe("notifySiteAfter", () => {
  it("still knocks when there is no request scope for after() — a unit test, a script", async () => {
    process.env.SITE_REVALIDATE_URL = URL_;
    process.env.SITE_REVALIDATE_KEY = "k-secret";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    // Outside a request, Next's after() throws; the helper must not let that
    // reach the action, and must still send the knock.
    expect(() => notifySiteAfter("PAF0001")).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * The media actions hold only a property id, so the helper reads the listing
 * first. Every "no knock" case below is ARMED — url and key set, the door
 * answering — so that a knock the helper wrongly sends is seen, not skipped.
 */
describe("notifySiteIfPublic", () => {
  const arm = () => {
    process.env.SITE_REVALIDATE_URL = URL_;
    process.env.SITE_REVALIDATE_KEY = "k-secret";
    return vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  };
  /** One scripted answer to the listing lookup. */
  const lookup = (page: FakePage) =>
    fakeClient({ properties: [page] }).client as unknown as SupabaseClient<Database>;
  /** The knock is fire-and-forget; give it a tick to land. */
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const DB_ERROR = { code: "XX000", message: "Fixture database error" };

  it("a public listing: one knock, carrying its reference", async () => {
    const fetchSpy = arm();
    await notifySiteIfPublic(
      lookup({ data: { reference: "PAF0001", visibility: "public" }, error: null }),
      "prop-1",
    );
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body))).toEqual({
      reference: "PAF0001",
    });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("a private listing: no knock", async () => {
    const fetchSpy = arm();
    await notifySiteIfPublic(
      lookup({ data: { reference: "PAF0002", visibility: "private" }, error: null }),
      "prop-2",
    );
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("no row — gone, or not the caller's to read: no knock, and NOT a database failure", async () => {
    const fetchSpy = arm();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await notifySiteIfPublic(lookup({ data: null, error: null }), "prop-3");
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("a RETURNED database error is reported by code, never by message, and does not knock", async () => {
    // supabase-js RESOLVES a database error as { data: null, error } — it does
    // not throw it — so a catch block alone never sees this one. Until
    // 2026-09-21 the helper read `data` alone, and a failed lookup was
    // indistinguishable from a private listing: no knock, no line, nowhere.
    const fetchSpy = arm();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      notifySiteIfPublic(lookup({ data: null, error: DB_ERROR }), "prop-4"),
    ).resolves.toBeUndefined();
    await settle();
    expect(fetchSpy, "a failed lookup must not guess that the listing is public").not.toHaveBeenCalled();
    expect(Sentry.captureMessage, "reported once, not twice").toHaveBeenCalledTimes(1);
    const [msg, ctx] = vi.mocked(Sentry.captureMessage).mock.calls[0]!;
    expect(String(msg)).toContain("site-revalidate");
    const context = JSON.stringify(ctx);
    expect(context).toContain("XX000");
    expect(context).toContain("properties");
    expect(context).not.toContain("Fixture database error");
    expect(context).not.toContain("k-secret");
    const lines = error.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(lines).toContain("XX000");
    expect(lines).not.toContain("Fixture database error");
    expect(lines).not.toContain("k-secret");
  });

  it("a THROWN lookup is reported by its name, never its message, and does not knock", async () => {
    const fetchSpy = arm();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const thrower = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.reject(new TypeError("fetch failed: 10.0.0.1")) }),
        }),
      }),
    } as unknown as SupabaseClient<Database>;
    await expect(notifySiteIfPublic(thrower, "prop-5")).resolves.toBeUndefined();
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const context = JSON.stringify(vi.mocked(Sentry.captureMessage).mock.calls[0]);
    expect(context).toContain("TypeError");
    expect(context).not.toContain("10.0.0.1");
  });

  it("a reporter that throws is swallowed too — the write it follows is already committed", async () => {
    arm();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(Sentry.captureMessage).mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    await expect(
      notifySiteIfPublic(lookup({ data: null, error: DB_ERROR }), "prop-6"),
    ).resolves.toBeUndefined();
  });
});
