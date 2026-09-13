import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifySite, notifySiteAfter, resetSiteRevalidateLatch } from "./site-revalidate";

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
