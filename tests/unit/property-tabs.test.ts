import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The property page's tabs follow `?tab=` (components/features/properties/
 * property-tabs.tsx), and a tab click writes it back with
 * `history.replaceState`. Measured 2026-10-18 in the browser: passing
 * `window.history.state` — which carries Next's own `__NA` marker — makes
 * Next's patched replaceState pass the call straight through
 * (node_modules/next/dist/client/components/app-router.js, `if (data?.__NA ||
 * data?._N)`), so useSearchParams never changed and the clicked tab never
 * opened, while the URL did. Nothing but a browser shows it, so the call's
 * first argument is pinned here, comments stripped.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(root, "components", "features", "properties", "property-tabs.tsx"), "utf-8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("PropertyTabs writes the tab back where Next can see it", () => {
  it("calls replaceState with null data, never Next's own history state", () => {
    expect(src).toMatch(/window\.history\.replaceState\(null,/);
    expect(src).not.toMatch(/replaceState\(\s*window\.history\.state/);
  });

  it("reads the open tab from useSearchParams, so a Fix link on the same page moves it", () => {
    expect(src).toMatch(/useSearchParams\(\)/);
    expect(src).toMatch(/value=\{value\}/);
  });
});
