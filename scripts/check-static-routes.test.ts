import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs build script, no types
import { findUnexpectedStatic, ALLOWED_STATIC } from "./check-static-routes.mjs";

/**
 * The guard has to fail for the real case, or it is decoration. The case it
 * exists for is `/login` being prerendered — which is what actually happened,
 * and what would have blocked every script on the page under an enforced CSP.
 */
describe("findUnexpectedStatic", () => {
  it("flags a prerendered /login — the 2026-08-09 case", () => {
    expect(findUnexpectedStatic(["login.html", "offline.html"])).toEqual(["login"]);
  });

  it("passes the build we actually ship", () => {
    // Exactly what `.next/server/app` holds after the fix.
    expect(
      findUnexpectedStatic(["_global-error.html", "_not-found.html", "index.html", "offline.html"]),
    ).toEqual([]);
  });

  it("keeps /offline allowed — force-static is deliberate for the PWA", () => {
    expect(ALLOWED_STATIC.has("offline")).toBe(true);
    expect(findUnexpectedStatic(["offline.html"])).toEqual([]);
  });

  it("catches a NEW page that is accidentally static, not just the known ones", () => {
    // The regression this really guards: someone adds a page, forgets it is
    // static, and nothing else in the repo would notice.
    expect(findUnexpectedStatic(["offline.html", "pricing.html", "login/verify.html"])).toEqual([
      "login/verify",
      "pricing",
    ]);
  });

  it("ignores non-HTML build artifacts", () => {
    expect(findUnexpectedStatic(["offline.html", "page.js", "route.js.nft.json"])).toEqual([]);
  });

  it("returns nothing for an all-dynamic build", () => {
    expect(findUnexpectedStatic([])).toEqual([]);
  });
});
