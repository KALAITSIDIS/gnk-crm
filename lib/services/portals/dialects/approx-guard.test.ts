import { describe, expect, it } from "vitest";
import type { Dialect } from "@/lib/services/portals/registry";
import { KYERO_SETTINGS, SALE_VILLA } from "./__fixtures__/listings";
import { DIALECT_RENDERERS } from "./index";
import type { DialectRenderer } from "./types";

/**
 * One guard for "an approximate point never leaves as an exact one", across
 * EVERY dialect (spec 2026-09-14 §Coordinates; `FeedCoords.approx`).
 *
 * `kyero.ts` honours the flag and `kyero.test.ts` pins that for Kyero alone.
 * Milestone 2 adds RERA and Trovit renderers, and without this file nothing
 * would go red if one of them forgot the check — the portal would then draw a
 * district centroid as the property's own pin. The loop below iterates the
 * LIVE `DIALECT_RENDERERS` table, so a renderer is covered the moment it is
 * registered; a renderer whose settings fixture is missing here fails by
 * name rather than being skipped.
 *
 * The needles include the two-decimal prefixes on purpose: a rounded
 * emission is still an emission.
 */
const APPROX = { lat: 34.123456, lng: 32.987654, approx: true } as const;
const EXACT = { ...APPROX, approx: false } as const;
const NEEDLES = ["34.123456", "32.987654", "34.12", "32.98"] as const;

/**
 * Settings each renderer needs in order to render at all. A dialect with a
 * renderer but no entry here is a test failure naming the dialect, not a
 * silent skip — add its settings fixture to `__fixtures__/listings.ts`.
 */
const SETTINGS: Partial<Record<Dialect, Record<string, string>>> = {
  kyero: KYERO_SETTINGS,
};

const live = (Object.entries(DIALECT_RENDERERS) as [Dialect, DialectRenderer | null][]).filter(
  (entry): entry is [Dialect, DialectRenderer] => entry[1] !== null,
);

describe("approx guard — every dialect with a renderer", () => {
  it("at least one renderer is live, so the loop below proves something", () => {
    expect(live.length).toBeGreaterThan(0);
  });

  it.each(live)(
    "%s emits neither the full nor a rounded coordinate for an approximate location",
    (dialect, renderer) => {
      const settings = SETTINGS[dialect];
      if (!settings) {
        throw new Error(
          `approx-guard: no settings fixture for dialect "${dialect}" — add one to SETTINGS in this file so its renderer is tested rather than skipped`,
        );
      }
      const body = renderer.render([{ ...SALE_VILLA, coords: APPROX }], settings);
      for (const needle of NEEDLES) {
        expect(body, `${dialect} emitted ${needle} for an approximate location`).not.toContain(needle);
      }
    },
  );

  // The positive half, so the negative one cannot pass for the wrong reason
  // (a renderer that never emits coordinates at all would satisfy it).
  it("kyero DOES emit both numbers for the same listing once the location is exact", () => {
    const kyero = DIALECT_RENDERERS.kyero;
    expect(kyero, "kyero renderer must exist").not.toBeNull();
    const body = (kyero as DialectRenderer).render([{ ...SALE_VILLA, coords: EXACT }], KYERO_SETTINGS);
    expect(body).toContain("34.123456");
    expect(body).toContain("32.987654");
  });
});
