import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import { reasonText } from "@/lib/services/portals/eligibility";
import { PORTALS, portalById } from "@/lib/services/portals/registry";
import {
  buildPropertyPortalRows,
  portalEligibilityInput,
  type PortalMediaRow,
  type PortalPropertyRow,
  type PortalReason,
  type PortalRow,
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
 *    portal puts every listing that was ever ticked for it back in its feed.
 *    A card built from enabled connections alone would show the desk nothing
 *    at all for those listings — they would look "out of the feed" right up
 *    until an admin flipped the switch and they all went back in.
 *  - ORDER IS THE REGISTRY'S. An unordered select returns rows in whatever
 *    order the last UPDATE left them, so a card built in query order
 *    reshuffles itself between visits for no reason the reader can see.
 *
 * The photo note covers the third: the eligibility sentence says "fewer than
 * 2 photos", the gallery beside it shows five, and only the missing JPEG
 * renditions reconcile the two.
 *
 * WHAT A ROW CLAIMS (portal integrations audit 2026-10-18, finding 7). The
 * row's `state` says only what the CRM knows — selected, and in the feed or
 * left out of it — never that the portal published anything; `lastRequestedAt`
 * is when the feed URL was last asked for, by anyone.
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

/**
 * `n` photographs, the first `withJpeg` of them carrying a JPEG rendition.
 * No size unless one is given: an unmeasured photo is never counted as too
 * small (eligibility.ts acceptedPhotoCount), so the default stays eligible.
 */
function photos(n: number, withJpeg: number, size?: { width: number; height: number }): PortalMediaRow[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: "photo",
    path_jpeg: i < withJpeg ? `p/${i}.jpg` : null,
    ...(size ? { width: size.width, height: size.height } : {}),
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

const reasonsOf = (row: Pick<PortalRow, "eligibility">): PortalReason[] =>
  row.eligibility.ok ? [] : row.eligibility.reasons;
const textsOf = (row: Pick<PortalRow, "eligibility">) => reasonsOf(row).map((r) => r.text);
const rowOf = (rows: PortalRow[], id: string) => {
  const row = rows.find((r) => r.id === id);
  expect(row, `a row for ${id}`).toBeDefined();
  return row!;
};

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
    // no connection, so nothing can carry it — and nothing has asked for a feed
    expect(rows[0].state).toBe("switched_off");
    expect(rows[0].lastRequestedAt).toBeNull();
  });

  // The four states are the card's whole vocabulary for what the CRM knows.
  // One build covers all of them, so a mis-ordered ternary (say, eligibility
  // checked before the switch) shows up as a wrong state on a named portal.
  it("names each row's state: in the feed, excluded, switched off, not selected", async () => {
    // one JPEG: enough for every portal that asks for one, too few for JamesEdition's two
    const { rows } = await build(
      {
        portal_connections: [
          {
            data: [
              conn("jamesedition", true), // selected, fails minPhotos → excluded
              conn("aplaceinthesun", true), // selected, passes → in the feed
              conn("properstar", false), // selected, passes, switched off
              conn("uk_provider", true), // enabled, never selected
            ],
            error: null,
          },
        ],
        portal_listings: [
          { data: [selection("jamesedition"), selection("aplaceinthesun"), selection("properstar")], error: null },
        ],
      },
      property(),
      photos(1, 1),
    );

    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ["jamesedition", "excluded"],
      ["aplaceinthesun", "in_feed"],
      ["properstar", "switched_off"],
      ["uk_provider", "not_selected"],
    ]);
    // eligibility is still reported beside the state, for the toggle and the reasons
    expect(rowOf(rows, "jamesedition").eligibility.ok).toBe(false);
    expect(rowOf(rows, "properstar").eligibility).toEqual({ ok: true });
  });

  it("says off the website — not a failure to fix — for a sold, withdrawn or private selection", async () => {
    // the same split Settings → Portals makes: a departure is not sent on
    // purpose, and the card must not offer to put it back on the website
    for (const p of [property({ status: "sold" }), property({ status: "withdrawn" }), property({ visibility: "private" })]) {
      const { rows } = await build(
        {
          portal_connections: [{ data: [conn("aplaceinthesun", true)], error: null }],
          portal_listings: [{ data: [selection("aplaceinthesun")], error: null }],
        },
        p,
        photos(2, 2),
      );
      expect(rows[0].state).toBe("off_site");
      // eligibility still says why (not_public) for the toggle, but the card hides it
      expect(rows[0].eligibility.ok).toBe(false);
    }
  });

  it("says switched off, not excluded, for an ineligible listing on a switched-off portal", async () => {
    // the switch is the reason no feed carries it; the requirements come second
    const { rows } = await build(
      {
        portal_connections: [{ data: [conn("jamesedition", false)], error: null }],
        portal_listings: [{ data: [selection("jamesedition")], error: null }],
      },
      property(),
      photos(1, 1),
    );

    expect(rows[0].state).toBe("switched_off");
    expect(rows[0].eligibility.ok).toBe(false);
  });

  it("says not selected for an unselected listing, eligible or not", async () => {
    const { rows } = await build(
      {
        portal_connections: [{ data: [conn("jamesedition", true), conn("aplaceinthesun", true)], error: null }],
        portal_listings: [{ data: [], error: null }],
      },
      property(),
      photos(1, 1),
    );

    // JamesEdition fails (one photo), A Place in the Sun passes — neither is "in" or "out" of a feed
    expect(rowOf(rows, "jamesedition").state).toBe("not_selected");
    expect(rowOf(rows, "jamesedition").eligibility.ok).toBe(false);
    expect(rowOf(rows, "aplaceinthesun").state).toBe("not_selected");
    expect(rowOf(rows, "aplaceinthesun").eligibility.ok).toBe(true);
  });

  // UPDATED for the new contract: a reason is `{ text, fixTab }` rather than a
  // bare sentence, and JamesEdition's sentence now names its 800×600 minimum.
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
    expect(reasonsOf(rows[0])).toContainEqual({
      text: "Fewer than 2 photos of at least 800×600 px available in the format this portal accepts (JPEG).",
      fixTab: "media",
    });
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

  // The photo sizes must reach eligibility through this builder: a version
  // that dropped width/height would hand eligibility "unknown size", which is
  // counted as acceptable — and the card would call a listing of thumbnails
  // fit for JamesEdition while the feed's own adapter (which has the sizes)
  // left it out.
  it("measures photos against the portal's minimum size: too small for JamesEdition, fine for A Place in the Sun", async () => {
    const pages = () => ({
      portal_connections: [{ data: [conn("jamesedition", true), conn("aplaceinthesun", true)], error: null }],
      portal_listings: [{ data: [], error: null }],
    });

    const small = await build(pages(), property(), photos(3, 3, { width: 640, height: 480 }));
    expect(reasonsOf(rowOf(small.rows, "jamesedition")).map((r) => r.fixTab)).toEqual(["media"]);
    expect(rowOf(small.rows, "aplaceinthesun").eligibility).toEqual({ ok: true });

    // the same three photos, large enough: the reason goes away
    const large = await build(pages(), property(), photos(3, 3, { width: 2400, height: 1600 }));
    expect(rowOf(large.rows, "jamesedition").eligibility).toEqual({ ok: true });
  });

  it("gives each reason the tab that fixes it, and no tab when nothing on the listing can", async () => {
    const def = portalById("jamesedition")!;
    // pinned so the null below cannot pass because the type stopped being excluded
    expect(def.requirements.excludedPropertyTypes).toContain("office");

    const { rows } = await build(
      {
        portal_connections: [{ data: [conn("jamesedition", true)], error: null }],
        portal_listings: [{ data: [], error: null }],
      },
      property({ public_description: { el: "Μόνο ελληνικά." }, property_type: "office" }),
      photos(1, 1),
    );

    expect(reasonsOf(rows[0])).toEqual([
      { text: reasonText(def, "no_description_en"), fixTab: "marketing" },
      { text: reasonText(def, "too_few_photos"), fixTab: "media" },
      // a portal rule: the desk cannot fix it on the listing, so no link
      { text: "JamesEdition takes residential property only — commercial listings are refused.", fixTab: null },
    ]);
  });

  // An advisory is what the portal's own moderation may refuse AFTER it has
  // the listing. It must never become a reason: the listing IS in the feed.
  it("carries advisories beside an in-feed row without making them reasons", async () => {
    const { rows } = await build(
      {
        portal_connections: [{ data: [conn("jamesedition", true)], error: null }],
        portal_listings: [{ data: [selection("jamesedition")], error: null }],
      },
      // EUR 400,000 is under JamesEdition's EUR 450,000 moderation floor
      property({ asking_price: 400000 }),
    );

    expect(rows[0].state).toBe("in_feed");
    expect(rows[0].eligibility).toEqual({ ok: true });
    expect(rows[0].advisories).toHaveLength(1);
    expect(rows[0].advisories[0]).toContain("JamesEdition's moderation refuses sale listings under EUR 450,000");
  });

  it("names where the desk can check publication, from the registry", async () => {
    const { rows } = await build({
      portal_connections: [{ data: [conn("jamesedition", true)], error: null }],
      portal_listings: [{ data: [selection("jamesedition")], error: null }],
    });

    expect(rows[0].publicationCheck).toBe(portalById("jamesedition")!.publicationCheck);
    expect(rows[0].publicationCheck).not.toBe("");
  });

  // UPDATED for the new contract: reasons are `{ text, fixTab }`.
  // The SQL withholds the point of an approximate listing (0150,
  // portal_feed_supplement), so the feed's adapter sees `coords: null` for
  // such a row. This adapter must say the same: otherwise a needsCoords portal
  // would read "eligible" on the card and drop the listing with no_coords at
  // the pull — one predicate, two adapters, two answers.
  it("withholds an approximate point the way the SQL does: a needsCoords portal reports no_coords", async () => {
    // EWKB of a real point (the value geo.test.ts parses); asserted to parse
    // so a null coords below cannot come from an unparseable fixture
    const POINT = "0101000020E6100000AC8BDB6800374040894160E5D0624140";
    expect(parseLocationPoint(POINT)).not.toBeNull();
    // RERA is the registry's one needsCoords portal — pinned, so this test
    // fails loudly rather than vacuously if that requirement ever moves
    expect(portalById("rera")?.requirements.needsCoords).toBe(true);
    const NO_COORDS = "This portal requires map coordinates.";
    const pages = () => ({
      portal_connections: [{ data: [conn("rera", true)], error: null }],
      portal_listings: [{ data: [], error: null }],
    });

    const approx = await build(pages(), property({ location: POINT, location_approx: true }));
    expect(approx.rows[0].id).toBe("rera");
    expect(reasonsOf(approx.rows[0])).toContainEqual({ text: NO_COORDS, fixTab: "details" });

    // the same point, exact: the coordinate reason goes away (RERA still
    // fails on other grounds today — its type map is empty until milestone 2)
    const exact = await build(pages(), property({ location: POINT, location_approx: false }));
    expect(textsOf(exact.rows[0])).not.toContain(NO_COORDS);
  });

  // UPDATED: `lastPulledAt` is now `lastRequestedAt` — 0150 records every
  // request that carries the token, so the time proves someone ASKED, not that
  // the portal did.
  it("names who selected the listing, and when the feed URL was last requested", async () => {
    const { rows } = await build({
      portal_connections: [{ data: [conn("jamesedition", true, "2026-09-13T22:11:00Z")], error: null }],
      portal_listings: [{ data: [selection("jamesedition", "user-1")], error: null }],
      profiles: [{ data: [{ id: "user-1", full_name: "N. Tsopozidis" }], error: null }],
    });

    expect(rows[0].selected).toEqual({
      at: "2026-09-14T09:00:00Z",
      byName: "N. Tsopozidis",
    });
    expect(rows[0].lastRequestedAt).toBe("2026-09-13T22:11:00Z");
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

  // postgrest-js answers an empty body, or a 404 with none, as `data: null,
  // error: null` (T-null-answer-guard). Read as `?? []`, a hollow connections
  // answer renders "No portal is enabled" — the reassuring direction and the
  // wrong one — and a hollow selections answer shows every selected portal
  // as Select, inviting a second selection of a listing already in the feed.
  it.each([
    ["null", null],
    ["an object", { portal: "jamesedition" }],
  ])("throws on a hollow connections answer (%s), never an empty card", async (_label, data) => {
    await expect(
      build({
        portal_connections: [{ data: data as FakePage["data"], error: null }],
        portal_listings: [{ data: [selection("jamesedition")], error: null }],
      }),
    ).rejects.toThrow("portal connections: the answer held no rows");
  });

  it.each([
    ["null", null],
    ["an object", { portal: "jamesedition" }],
  ])("throws on a hollow selections answer (%s), never 'not selected'", async (_label, data) => {
    await expect(
      build({
        portal_connections: [{ data: [conn("jamesedition", true)], error: null }],
        portal_listings: [{ data: data as FakePage["data"], error: null }],
      }),
    ).rejects.toThrow("portal selections: the answer held no rows");
  });
});

/**
 * THE ONE ADAPTER the property card, Settings → Portals and selectPortal all
 * read eligibility through. Tested directly because its two judgements — what
 * counts as a photo the portal receives, and when a point is withheld — decide
 * every one of those three answers at once.
 */
describe("portalEligibilityInput", () => {
  const POINT = "0101000020E6100000AC8BDB6800374040894160E5D0624140";

  it("counts only photographs with a JPEG rendition, and carries their sizes", () => {
    const media: PortalMediaRow[] = [
      { kind: "photo", path_jpeg: "p/1.jpg", width: 2400, height: 1600 },
      { kind: "photo", path_jpeg: null, width: 4000, height: 3000 }, // no rendition: the portal never sees it
      { kind: "floor_plan", path_jpeg: "p/plan.jpg", width: 1200, height: 900 }, // not a photograph
      { kind: "photo", path_jpeg: "p/2.jpg" }, // never measured
      { kind: "photo", path_jpeg: "p/3.jpg", width: 640, height: null },
    ];

    expect(portalEligibilityInput(property(), media).photos).toEqual([
      { width: 2400, height: 1600 },
      // an absent size is null, never undefined and never guessed
      { width: null, height: null },
      { width: 640, height: null },
    ]);
  });

  it("withholds the point of an approximate location, and carries an exact one", () => {
    const point = parseLocationPoint(POINT)!;
    expect(point).not.toBeNull();

    expect(portalEligibilityInput(property({ location: POINT, location_approx: true }), []).coords).toBeNull();
    expect(portalEligibilityInput(property({ location: POINT, location_approx: false }), []).coords).toEqual({
      lat: point.lat,
      lng: point.lng,
      approx: false,
    });
    // no point at all is no coordinates, whatever the flag says
    expect(portalEligibilityInput(property({ location: null, location_approx: false }), []).coords).toBeNull();
  });

  it("reads the town from the joined district and area names", () => {
    const input = portalEligibilityInput(property(), []);
    expect(input.districtEn).toBe("Paphos");
    expect(input.areaEn).toBe("Peyia");
    expect(portalEligibilityInput(property({ districts: null, areas: null }), []).districtEn).toBeNull();
  });
});
