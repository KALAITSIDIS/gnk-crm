import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

/**
 * NOTIF-1 (six-phase audit, 2026-10-17): `/api/csp-report` is public and
 * sessionless, and it sent ONE Sentry event per distinct directive /
 * blocked-URL / source key, with no cap per request or per window, under a
 * title the caller wrote. Its dedupe Set was cleared whole at 200 entries,
 * so a flood of fresh keys also re-reported every key it had seen.
 *
 * What this file pins about the route, through its real handler and parser:
 *   - a report is read up to its first 50 violations;
 *   - at most 3 NEW violations are reported per request;
 *   - a per-instance token bucket bounds what a run of requests can send;
 *   - every Sentry event carries a fixed fingerprint (["csp-violation",
 *     <known directive | "other">]) and a message the caller did not write;
 *   - the dedupe set forgets its OLDEST key when full, never all of them.
 *
 * Faked: Sentry, and the clock (Date only). The route is re-imported per
 * test so each starts with a cold instance's state, exactly as a fresh
 * serverless instance would.
 */
const capture = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({ captureMessage: capture }));

type Route = typeof import("@/app/api/csp-report/route");
let route: Route;
let warn: MockInstance<typeof console.warn>;

const T0 = new Date("2026-10-17T09:00:00Z").getTime();
const HOUR = 3_600_000;

/** One report-to envelope per violation; `blocked` makes each key distinct. */
const envelope = (blocked: string, directive = "img-src") => ({
  type: "csp-violation",
  url: "https://gnk-crm.vercel.app/properties",
  body: {
    documentURL: "https://gnk-crm.vercel.app/properties",
    effectiveDirective: directive,
    blockedURL: blocked,
    disposition: "enforce",
  },
});
const keys = (n: number, prefix = "k") => Array.from({ length: n }, (_, i) => envelope(`https://${prefix}${i}.example/x.png`));

const send = async (body: unknown) =>
  route.POST(
    new NextRequest("https://crm.example/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/reports+json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  capture.mockClear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.resetModules();
  route = await import("@/app/api/csp-report/route");
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

describe("one request cannot flood Sentry", () => {
  it("reports at most three new violations from a batch of two hundred, and still answers 204", async () => {
    const res = await send(keys(200));
    expect(res.status).toBe(204);
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it("says in the log how many it held back — a dropped report is never silent", async () => {
    await send(keys(10));
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => /7\b.*not reported/.test(l))).toBe(true);
  });

  it("reads only the first fifty violations of a report", async () => {
    await send([envelope("https://seen.example/x.png")]);
    expect(capture).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + HOUR);
    // fifty copies of a key already reported, then ten new ones past the cut
    const padded = [...Array.from({ length: 50 }, () => envelope("https://seen.example/x.png")), ...keys(10, "late")];
    await send(padded);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("a violation held back by the cap is reported on a later request, not forgotten", async () => {
    const batch = keys(4);
    await send(batch);
    expect(capture).toHaveBeenCalledTimes(3);
    await send(batch);
    expect(capture).toHaveBeenCalledTimes(4);
  });
});

describe("a run of requests cannot flood Sentry either", () => {
  it("spends a per-instance budget of ten events, then refills one every six minutes", async () => {
    for (let i = 0; i < 5; i++) await send(keys(3, `r${i}-`));
    // 3 + 3 + 3 + 1: the bucket held ten
    expect(capture).toHaveBeenCalledTimes(10);
    vi.setSystemTime(T0 + 6 * 60_000 - 1);
    await send(keys(3, "early-"));
    expect(capture).toHaveBeenCalledTimes(10);
    vi.setSystemTime(T0 + 6 * 60_000);
    await send(keys(3, "refilled-"));
    expect(capture).toHaveBeenCalledTimes(11);
  });

  it("never holds more than ten, however long the instance was idle", async () => {
    vi.setSystemTime(T0 + 48 * HOUR);
    for (let i = 0; i < 6; i++) await send(keys(3, `idle${i}-`));
    expect(capture).toHaveBeenCalledTimes(10);
  });

  it("a full bucket earns nothing while it waits: a burst is ten, not ten plus a token already earned", async () => {
    // the instance started at T0 with a full bucket and saw nothing for 5:59
    vi.setSystemTime(T0 + 6 * 60_000 - 1000);
    for (let i = 0; i < 4; i++) await send(keys(3, `burst${i}-`));
    expect(capture).toHaveBeenCalledTimes(10);
    // one second later is six minutes after the instance STARTED, but not
    // six minutes after the first token was spent
    vi.setSystemTime(T0 + 6 * 60_000);
    await send(keys(3, "next-"));
    expect(capture).toHaveBeenCalledTimes(10);
  });
});

describe("what reaches Sentry is shaped by the route, not the caller", () => {
  const sent = () => capture.mock.calls.map((c) => ({ message: String(c[0]), hint: c[1] as Record<string, unknown> }));

  it("groups by a fixed fingerprint per known directive, with a message naming only that directive", async () => {
    await send([envelope("https://a.example/x.png", "script-src-elem")]);
    const [{ message, hint }] = sent();
    expect(hint).toMatchObject({ level: "warning", fingerprint: ["csp-violation", "script-src-elem"] });
    expect(message).toBe("[csp] script-src-elem violation");
    expect(message).not.toContain("a.example");
  });

  it("an older browser's violated-directive (a source expression) groups under its directive name", async () => {
    await send({ "csp-report": { "violated-directive": "img-src 'self' data:", "blocked-uri": "https://b.example/y.png", "document-uri": "https://gnk-crm.vercel.app/x" } });
    expect(sent()[0]!.hint).toMatchObject({ fingerprint: ["csp-violation", "img-src"] });
  });

  it("a directive the policy does not have is 'other' — the caller cannot mint a group or a title", async () => {
    await send([envelope("https://c.example/z.png", "Buy-cheap-pills-NOW"), envelope("https://d.example/z.png", "x".repeat(300))]);
    for (const { message, hint } of sent()) {
      expect(hint).toMatchObject({ fingerprint: ["csp-violation", "other"] });
      expect(message).toBe("[csp] other violation");
    }
  });

  it("keeps the details for the operator, beside the message rather than in it", async () => {
    await send([envelope("https://e.example/w.png", "connect-src")]);
    expect(sent()[0]!.hint).toMatchObject({
      extra: { directive: "connect-src", blocked: "https://e.example/w.png", document: "/properties" },
    });
  });
});

describe("the dedupe set forgets its oldest key, never all of them", () => {
  it("after its two hundredth key, the first is forgotten and the rest are still known", async () => {
    // one new key per request, an hour apart, so neither cap is what decides
    for (let i = 0; i < 201; i++) {
      vi.setSystemTime(T0 + i * HOUR);
      await send([envelope(`https://seq${i}.example/x.png`)]);
    }
    expect(capture).toHaveBeenCalledTimes(201);
    vi.setSystemTime(T0 + 202 * HOUR);
    // a key from just before the set filled is still known: not reported again
    await send([envelope("https://seq199.example/x.png")]);
    expect(capture).toHaveBeenCalledTimes(201);
    // the oldest was evicted to make room: reported again
    await send([envelope("https://seq0.example/x.png")]);
    expect(capture).toHaveBeenCalledTimes(202);
  });
});

describe("what was true before stays true", () => {
  it("answers 204 to malformed JSON and reports nothing", async () => {
    const res = await route.POST(
      new NextRequest("https://crm.example/api/csp-report", { method: "POST", body: "not json" }),
    );
    expect(res.status).toBe(204);
    expect(capture).not.toHaveBeenCalled();
  });

  it("refuses an oversized body with 413 and says so in the log", async () => {
    const res = await route.POST(
      new NextRequest("https://crm.example/api/csp-report", { method: "POST", body: "x".repeat(131_073) }),
    );
    expect(res.status).toBe(413);
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes("DROPPED"))).toBe(true);
  });

  it("reports a violation once per instance, not once per page view", async () => {
    await send([envelope("https://once.example/x.png")]);
    await send([envelope("https://once.example/x.png")]);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
