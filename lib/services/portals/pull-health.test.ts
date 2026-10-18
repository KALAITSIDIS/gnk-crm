import { describe, expect, it } from "vitest";
import { PULL_REASON_TEXT, pullHealth, pullRunText, type PullFacts } from "./pull-health";
import { portalById } from "./registry";

const je = portalById("jamesedition")!; // asks three times a day: stale after 24 h
const ukProvider = portalById("uk_provider")!; // the provider's own schedule: never called stale

const NOW = new Date("2026-10-18T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

/** An enabled connection whose feed URL was last asked an hour ago and served 7 listings. */
const facts = (over: Partial<PullFacts> = {}): PullFacts => ({
  enabled: true,
  hasToken: true,
  lastPulledAt: hoursAgo(1),
  lastPulledUa: "KyeroBot/1.0",
  lastPullCount: 7,
  lastPullOutcome: "served",
  lastSuccessAt: hoursAgo(1),
  lastErrorAt: null,
  lastErrorReason: null,
  ...over,
});

describe("pullHealth", () => {
  it("a disabled connection is muted — even when its last request failed", () => {
    for (const f of [facts({ enabled: false }), facts({ enabled: false, lastPullOutcome: "failed", lastErrorReason: "truncated" })]) {
      const h = pullHealth(je, f, 5, NOW);
      expect(h.tone).toBe("muted");
      expect(h.headline).toMatch(/^Disabled/);
      expect(h.staleHours).toBeNull();
    }
  });

  it("an enabled connection without a token warns that there is no feed URL yet", () => {
    const h = pullHealth(je, facts({ hasToken: false, lastPulledAt: null }), 5, NOW);
    expect(h).toEqual({ tone: "warn", headline: "No feed URL yet — regenerate to issue one.", staleHours: null });
  });

  it("never requested warns while listings are selected, and is only muted when none are", () => {
    const never = facts({ lastPulledAt: null, lastPullOutcome: null, lastPullCount: null, lastSuccessAt: null });
    expect(pullHealth(je, never, 3, NOW)).toMatchObject({ tone: "warn", staleHours: null });
    expect(pullHealth(je, never, 3, NOW).headline).toMatch(/never been requested/);
    expect(pullHealth(je, never, 0, NOW).tone).toBe("muted");
  });

  it("a failed last request is an error that names the reason in the desk's words", () => {
    const h = pullHealth(je, facts({ lastPullOutcome: "failed", lastErrorReason: "supplement_incomplete" }), 4, NOW);
    expect(h.tone).toBe("error");
    expect(h.headline).toContain(PULL_REASON_TEXT.supplement_incomplete);
    expect(h.headline).toContain("503");
    expect(h.staleHours).toBeNull();
  });

  it("a failed request with a code it does not know says 'a fault' — and never reads a prototype key as a reason", () => {
    for (const code of ["some_new_code", "constructor", "toString", null]) {
      const h = pullHealth(je, facts({ lastPullOutcome: "failed", lastErrorReason: code }), 4, NOW);
      expect(h.tone, String(code)).toBe("error");
      expect(h.headline, String(code)).toContain(": a fault.");
    }
  });

  it("is stale past the portal's interval while listings are selected (JamesEdition: 24 h)", () => {
    const h = pullHealth(je, facts({ lastPulledAt: hoursAgo(30.5) }), 2, NOW);
    expect(h.tone).toBe("warn");
    expect(h.staleHours).toBe(30);
    expect(h.headline).toContain("No request for 30 hours");
  });

  it("is not stale at exactly the interval, nor with nothing selected, nor for a portal with no stated schedule", () => {
    expect(pullHealth(je, facts({ lastPulledAt: hoursAgo(24) }), 2, NOW).tone).toBe("ok");
    // nothing selected: a portal with an empty feed has no reason to ask
    expect(pullHealth(je, facts({ lastPulledAt: hoursAgo(100) }), 0, NOW)).toMatchObject({ tone: "ok", staleHours: null });
    expect(ukProvider.staleAfterHours).toBeNull();
    expect(pullHealth(ukProvider, facts({ lastPulledAt: hoursAgo(1000) }), 9, NOW)).toMatchObject({
      tone: "ok",
      staleHours: null,
    });
  });

  it("is ok otherwise, with the count the last request served", () => {
    expect(pullHealth(je, facts(), 9, NOW)).toEqual({
      tone: "ok",
      headline: "Last request served 7 listings.",
      staleHours: null,
    });
    expect(pullHealth(je, facts({ lastPullCount: 1 }), 9, NOW).headline).toBe("Last request served 1 listing.");
    expect(pullHealth(je, facts({ lastPullCount: null }), 9, NOW).headline).toBe("Last request served 0 listings.");
  });

  it("a request answered with the disabled document is not an error once the portal is enabled again", () => {
    expect(pullHealth(je, facts({ lastPullOutcome: "disabled", lastPullCount: 0 }), 3, NOW).tone).toBe("ok");
  });
});

describe("pullRunText", () => {
  it("words a disabled run", () => {
    expect(pullRunText({ outcome: "disabled", served: null, selected: null, excluded: null, reason: null })).toBe(
      "Disabled — answered the empty document",
    );
  });

  it("words a failed run with its reason, or 'a fault' for a code it does not know", () => {
    expect(pullRunText({ outcome: "failed", served: null, selected: 4, excluded: null, reason: "truncated" })).toBe(
      `Refused (503): ${PULL_REASON_TEXT.truncated}`,
    );
    expect(pullRunText({ outcome: "failed", served: null, selected: null, excluded: null, reason: "hasOwnProperty" })).toBe(
      "Refused (503): a fault",
    );
  });

  it("words a served run with what was selected and what the requirements kept out", () => {
    expect(pullRunText({ outcome: "served", served: 5, selected: 7, excluded: 2, reason: null })).toBe(
      "Served 5 listings of 7 selected on the website (2 excluded by its requirements)",
    );
    expect(pullRunText({ outcome: "served", served: 1, selected: 1, excluded: 0, reason: null })).toBe(
      "Served 1 listing of 1 selected on the website",
    );
    // an older run recorded before the selection was counted
    expect(pullRunText({ outcome: "served", served: null, selected: null, excluded: null, reason: null })).toBe(
      "Served 0 listings",
    );
  });

  it("has desk words for every reason the route records", () => {
    for (const [code, text] of Object.entries(PULL_REASON_TEXT)) {
      expect(code).toMatch(/^[a-z_]{1,40}$/); // 0150's CHECK on last_error_reason
      expect(text.trim(), code).not.toBe("");
    }
  });
});
