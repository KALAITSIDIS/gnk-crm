import { describe, expect, it } from "vitest";
import { generateShareToken, hashShareToken } from "./share-links-token";
import {
  DEFAULT_EXPIRY_DAYS,
  daysUntilExpiry,
  expiryFromNow,
  isWellFormedShareToken,
  shareLinkPath,
  shareLinkState,
  withheldCount,
  type Proposal,
} from "./share-links";

describe("share token", () => {
  it("is URL-safe and long enough to be unguessable", () => {
    const token = generateShareToken();
    // 32 bytes base64url = 43 chars, no padding
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // `+` and `/` would be mangled when pasted into WhatsApp
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, generateShareToken));
    expect(seen.size).toBe(500);
  });

  it("hashes deterministically, and the hash is not the token", () => {
    const token = generateShareToken();
    expect(hashShareToken(token)).toBe(hashShareToken(token));
    expect(hashShareToken(token)).toHaveLength(64);
    expect(hashShareToken(token)).not.toContain(token);
    expect(hashShareToken("a")).not.toBe(hashShareToken("b"));
  });

  /**
   * The app hashes in Node; the database looks the link up by that hash
   * (`resolve_share_link`). If the two ever disagreed, every live link would
   * silently stop resolving — so this pins the exact digest, verified to be
   * byte-identical to Postgres's
   * `encode(digest('opensesame','sha256'),'hex')`.
   */
  it("pins the SHA-256 vector Postgres also produces", () => {
    expect(hashShareToken("opensesame")).toBe(
      "d9fb92e3bbe65be1f1aad4a82eef4567f7a1ebe2cd110c8049b9698be7a70c88",
    );
  });

  it("rejects shapes we never mint, before any database round trip", () => {
    expect(isWellFormedShareToken(generateShareToken())).toBe(true);
    expect(isWellFormedShareToken("")).toBe(false);
    expect(isWellFormedShareToken("short")).toBe(false);
    expect(isWellFormedShareToken("a".repeat(44))).toBe(false);
    expect(isWellFormedShareToken("has spaces in it aaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(isWellFormedShareToken("../../etc/passwd")).toBe(false);
    expect(isWellFormedShareToken("a".repeat(42) + "+")).toBe(false);
  });
});

describe("shareLinkState", () => {
  const now = new Date("2026-07-29T12:00:00Z");

  it("is live while unexpired and unrevoked", () => {
    expect(shareLinkState({ expires_at: "2026-08-12T12:00:00Z", revoked_at: null }, now)).toBe(
      "live",
    );
  });

  it("is expired once the moment passes", () => {
    expect(shareLinkState({ expires_at: "2026-07-29T11:59:59Z", revoked_at: null }, now)).toBe(
      "expired",
    );
  });

  it("reports revoked even when also expired — the agent's action is the fact worth showing", () => {
    expect(
      shareLinkState(
        { expires_at: "2026-07-01T12:00:00Z", revoked_at: "2026-07-02T12:00:00Z" },
        now,
      ),
    ).toBe("revoked");
  });
});

describe("expiry helpers", () => {
  const now = new Date("2026-07-29T12:00:00Z");

  it("defaults to a viewing-decision cycle", () => {
    expect(DEFAULT_EXPIRY_DAYS).toBe(14);
    expect(expiryFromNow(DEFAULT_EXPIRY_DAYS, now).toISOString()).toBe("2026-08-12T12:00:00.000Z");
  });

  it("counts remaining days, never negative", () => {
    expect(daysUntilExpiry("2026-08-12T12:00:00Z", now)).toBe(14);
    expect(daysUntilExpiry("2026-07-29T13:00:00Z", now)).toBe(1);
    expect(daysUntilExpiry("2026-07-01T12:00:00Z", now)).toBe(0);
  });
});

describe("withheldCount", () => {
  const base: Proposal = {
    title: null,
    message: null,
    locale: "en",
    expires_at: "2026-08-12T12:00:00Z",
    property_count: 3,
    properties: [],
    agent: null,
    org: null,
  };

  it("reports how many curated properties are no longer shown", () => {
    // a property archived after the link was made drops out of the payload
    expect(withheldCount({ ...base, properties: [{} as never] })).toBe(2);
  });

  it("is zero when everything still resolves, and never negative", () => {
    expect(withheldCount({ ...base, properties: [{}, {}, {}] as never[] })).toBe(0);
    expect(withheldCount({ ...base, properties: [{}, {}, {}, {}] as never[] })).toBe(0);
  });
});

describe("shareLinkPath", () => {
  it("is the public route, outside the authenticated shell", () => {
    expect(shareLinkPath("abc")).toBe("/p/abc");
  });
});
