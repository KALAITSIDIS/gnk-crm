import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPortalToken, mintPortalToken } from "./token";

/**
 * 0097 (integrations audit 2026-09-15, INT-10): the database holds
 * sha256(token), never the token. Share links have worked this way since
 * 0023; the portal feed stored its token in clear for one day short of a
 * milestone. The token is 64 hex so the route's path check and the column's
 * CHECK stay what they were; the digest is 64 hex too.
 */
describe("portal feed tokens", () => {
  it("mints 32 random bytes as 64 hex, differently every time", () => {
    const a = mintPortalToken();
    const b = mintPortalToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("hashes to lowercase hex sha256, deterministically, and never to itself", () => {
    const token = "a".repeat(64);
    const digest = hashPortalToken(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hashPortalToken(token)).toBe(digest);
    expect(digest).not.toBe(token);
  });
});
