import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs build script, no types
import {
  findUnexpectedStatic,
  listPrerenderedHtml,
  ALLOWED_STATIC,
} from "./check-static-routes.mjs";

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

/**
 * The tests above hand `findUnexpectedStatic` nested paths like
 * "login/verify.html" — but the guard's own caller could never produce one. It
 * read `.next/server/app` with a NON-RECURSIVE `readdirSync`, which returns
 * `settings` (a directory, filtered out for not ending in .html) and never
 * `settings/organization.html`. So every nested route was invisible to it, and
 * the pure-function tests passed anyway. That is the gap these cover: the walk,
 * against a real directory tree.
 */
describe("listPrerenderedHtml", () => {
  const dir = mkdtempSync(join(tmpdir(), "static-routes-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, "settings"), { recursive: true });
  mkdirSync(join(dir, "(app)", "reports"), { recursive: true });
  writeFileSync(join(dir, "offline.html"), "");
  writeFileSync(join(dir, "page.js"), "");
  writeFileSync(join(dir, "settings", "organization.html"), "");
  writeFileSync(join(dir, "(app)", "reports", "commission.html"), "");

  it("finds NESTED prerendered pages, not just top-level ones", () => {
    expect(listPrerenderedHtml(dir).sort()).toEqual([
      "(app)/reports/commission.html",
      "offline.html",
      "settings/organization.html",
    ]);
  });

  it("reports nested routes with forward slashes on every platform", () => {
    // Windows readdir yields "settings\\organization.html"; the allowlist and
    // the printed route both assume POSIX separators.
    expect(listPrerenderedHtml(dir).every((f: string) => !f.includes("\\"))).toBe(true);
  });

  it("a statically prerendered /settings/organization is now caught", () => {
    expect(findUnexpectedStatic(listPrerenderedHtml(dir))).toEqual([
      "(app)/reports/commission",
      "settings/organization",
    ]);
  });
});
