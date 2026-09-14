import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import { PORTALS, portalById } from "@/lib/services/portals/registry";
import {
  buildPropertyPortalRows,
  type PortalMediaRow,
  type PortalPropertyRow,
} from "@/lib/services/portals/property-portals";
import { parseLocationPoint } from "@/lib/utils/geo";

/**
 * What the property page's Portals card is told, and — more to the point —
 * what it is NOT told.
 *
 * Two of these rules exist because the obvious implementation is wrong in a
 * way nobody would notice from the screen:
 *
 *  - A SWITCHED-OFF PORTAL'S SELECTIONS SURVIVE. 0095 does not delete
 *    `portal_listings` when a connection is disabled, so re-enabling the
 *    portal republishes every listing that was ever ticked for it. A card
 *    built from enabled connections alone would show the desk nothing at all
 *    for those listings — they would look "off the portal" right up until an
 *    admin flipped the switch and they all went out again.
 *  - ORDER IS THE REGISTRY'S. An unordered select returns rows in whatever
 *    order the last UPDATE left them, so a card built in query order
 *    reshuffles itself between visits for no reason the reader can see.
 *
 * The photo note covers the third: the eligibility sentence says "fewer than
 * 2 photos", the gallery beside it shows five, and only the missing JPEG
 * renditions reconcile the two.
 */

// as plain strings: a `PortalRow.id` is a string, and the point of the check
// is that the two lists agree, not that tsc already knew they would
const REGISTRY_ORDER: string[] = PORTALS.map((p) => p.id);

/** Eligible for every Kyero portal: public, priced in EUR, English text, a town. */
function property(over: Partial<PortalPropertyRow> = {}): PortalPropertyRow {
  return {
    visibility: "public",
    status: "available",
    transaction_type: "sale",
    asking_price: 500000,
    rent_price_month: null,
    currency: "EUR",
    public_description: { en: "A villa above the sea." },
    property_type: "villa",
    location: null,
    location_approx: false,
    districts: { name: { en: "Paphos" } },
    areas: { name: { en: "Peyia" } },
    ...over,
  };
}

/** `n` photographs, the first `withJpeg` of them carrying a JPEG rendition. */
function photos(n: number, withJpeg: number): PortalMediaRow[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "photo",
    path_jpeg: i < withJpeg ? `p/${i}.jpg` : null,
  }));
}

const conn = (portal: string, enabled: boolean, lastPulledAt: string | null = null) => ({
  portal,
  enabled,
  last_pulled_at: lastPulledAt,
});

const selection = (portal: string, by: string | null = null) => ({
  portal,
  selected_at: "2026-09-14T09:00:00Z",
  selected_by: by,
});

function build(
  pages: Record<string, FakePage[]>,
  p: PortalPropertyRow = property(),
  media: PortalMediaRow[] = photos(4, 4),
) {
  const fake = fakeClient(pages);
  return buildPropertyPortalRows(fake.client as never, p, media, "prop-1");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildPropertyPortalRows", () => {
  it("returns rows in registry order, whatever order the connections came back in", async () => {
    const { rows } = await build({
      portal_connections: [
        {
          // deliberately not registry order, and not alphabetical either
          data: [conn("properstar", true), conn("jamesedition", true), conn("aplaceinthesun", true)],
          error: null,
        },
      ],
      portal_listings: [{ data: [], error: null }],
    });

    expect(rows.map((r) => r.id)).toEqual(["jamesedition", "aplaceinthesun", "properstar"]);
    // and that really is the registry's order, not a coincidence of these three
    const positions = rows.map((r) => REGISTRY_ORDER.indexOf(r.id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("keeps a switched-off portal's selection visible, and hides a switched-off portal with none", async () => {
    const { rows } = await build({
      portal_connections: [
        {
          data: [
            conn("jamesedition", true), // enabled, never selected
            conn("aplaceinthesun", false), // switched off, but selected
            conn("properstar", false), // switched off, not selected
          ],
          error: null,
        },
      ],
      portal_listings: [{ data: [selection("aplaceinthesun")], error: null }],
    });

    expect(rows.map((r) => r.id)).toEqual(["jamesedition", "aplaceinthesun"]);

    const james = rows[0];
    expect(james.connectionEnabled).toBe(true);
    expect(james.selected).toBeNull();

    const sun = rows[1];
    expect(sun.connectionEnabled).toBe(false);
    expect(sun.selected).toEqual({ at: "2026-09-14T09:00:00Z", byName: null });
  });

  it("shows a selection whose portal has no connection row at all", async () => {
    const { rows } = await build({
      portal_connections: [{ data: [], error: null }],
      portal_listings: [{ data: [selection("properstar")], error: null }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("properstar");
    expect(rows[0].connectionEnabled).toBe(false);
    expect(rows[0].lastPulledAt).toBeNull();
  });

  it("counts only photographs with a JPEG rendition, and says how many are missing", async () => {
    const { rows, photoNote } = await build(
      {
        portal_connections: [{ data: [conn("jamesedition", true)], error: null }],
        portal_listings: [{ data: [], error: null }],
      },
      property(),
      photos(3, 1),
    );

    expect(photoNote).toBe("2 of 3 photos are not yet prepared for portals.");
    // JamesEdition asks for two; one JPEG is not two, however full the gallery looks
    expect(rows[0].eligibility.ok).toBe(false);
    expect(rows[0].eligibility.ok === false && rows[0].eligibility.reasons).toContain(
      "Fewer than 2 photos available in the format this portal accepts (JPEG).",
    );
  });

  it("says nothing about photos when every one of them is prepared", async () => {
    const { rows, photoNote } = await build(
      {
        portal_connections: [{ data: [conn("jamesedition", true)], error: null }],
        portal_listings: [{ data: [], error: null }],
      },
      property(),
      photos(3, 3),
    );

    expect(photoNote).toBeNull();
    expect(rows[0].eligibility).toEqual({ ok: true });
  });

  // The SQL withholds the point of an approximate listing (0095,
  // portal_supplement), so the feed's adapter sees `coords: null` for such a
  // row. This adapter must say the same: otherwise a needsCoords portal would
  // read "eligible" on the card and drop the listing with no_coords at the
  // pull — one predicate, two adapters, two answers.
  it("withholds an approximate point the way the SQL does: a needsCoords portal reports no_coords", async () => {
    // EWKB of a real point (the value geo.test.ts parses); asserted to parse
    // so a null coords below cannot come from an unparseable fixture
    const POINT = "0101000020E6100000AC8BDB6800374040894160E5D0624140";
    expect(parseLocationPoint(POINT)).not.toBeNull();
    // RERA is the registry's one needsCoords portal — pinned, so this test
    // fails loudly rather than vacuously if that requirement ever moves
    expect(portalById("rera")?.requirements.needsCoords).toBe(true);
    const NO_COORDS = "This portal requires map coordinates.";
    const reasonsOf = (row: { eligibility: { ok: true } | { ok: false; reasons: string[] } }) =>
      row.eligibility.ok ? [] : row.eligibility.reasons;
    const pages = () => ({
      portal_connections: [{ data: [conn("rera", true)], error: null }],
      portal_listings: [{ data: [], error: null }],
    });

    const approx = await build(pages(), property({ location: POINT, location_approx: true }));
    expect(approx.rows[0].id).toBe("rera");
    expect(reasonsOf(approx.rows[0])).toContain(NO_COORDS);

    // the same point, exact: the coordinate reason goes away (RERA still
    // fails on other grounds today — its type map is empty until milestone 2)
    const exact = await build(pages(), property({ location: POINT, location_approx: false }));
    expect(reasonsOf(exact.rows[0])).not.toContain(NO_COORDS);
  });

  it("names who selected the listing", async () => {
    const { rows } = await build({
      portal_connections: [{ data: [conn("jamesedition", true, "2026-09-13T22:11:00Z")], error: null }],
      portal_listings: [{ data: [selection("jamesedition", "user-1")], error: null }],
      profiles: [{ data: [{ id: "user-1", full_name: "N. Tsopozidis" }], error: null }],
    });

    expect(rows[0].selected).toEqual({
      at: "2026-09-14T09:00:00Z",
      byName: "N. Tsopozidis",
    });
    expect(rows[0].lastPulledAt).toBe("2026-09-13T22:11:00Z");
  });

  it("still shows the selection when the names cannot be read, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { rows } = await build({
      portal_connections: [{ data: [conn("jamesedition", true)], error: null }],
      portal_listings: [{ data: [selection("jamesedition", "user-1")], error: null }],
      profiles: [{ data: null, error: { message: "permission denied for table profiles" } }],
    });

    // the fact survives; only the courtesy is lost
    expect(rows[0].selected).toEqual({ at: "2026-09-14T09:00:00Z", byName: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("permission denied for table profiles");
  });

  it("warns about a connection naming a portal the registry does not have", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { rows } = await build({
      portal_connections: [
        { data: [conn("jamesedition", true), conn("some_retired_portal", true)], error: null },
      ],
      portal_listings: [{ data: [], error: null }],
    });

    expect(rows.map((r) => r.id)).toEqual(["jamesedition"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("some_retired_portal");
  });

  it("throws when the connections cannot be read rather than reporting none", async () => {
    await expect(
      build({
        portal_connections: [{ data: null, error: { message: "timeout" } }],
        portal_listings: [{ data: [], error: null }],
      }),
    ).rejects.toThrow("portal connections: timeout");
  });

  it("throws when the selections cannot be read", async () => {
    await expect(
      build({
        portal_connections: [{ data: [conn("jamesedition", true)], error: null }],
        portal_listings: [{ data: null, error: { message: "timeout" } }],
      }),
    ).rejects.toThrow("portal selections: timeout");
  });
});
