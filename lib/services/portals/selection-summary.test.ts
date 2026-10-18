import { describe, expect, it } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import { reasonText } from "@/lib/services/portals/eligibility";
import { PORTAL_PROPERTY_COLUMNS, type PortalMediaRow } from "@/lib/services/portals/property-portals";
import { PORTALS, portalById } from "@/lib/services/portals/registry";
import { buildPortalSelectionSummary } from "@/lib/services/portals/selection-summary";

/**
 * Settings → Portals' count of every selected listing, per portal (portal
 * integrations audit 2026-10-18, finding 5).
 *
 * Three rules this pins, each of which the obvious implementation gets wrong:
 *
 *  - A LISTING THAT LEFT THE WEBSITE IS NOT A FAILURE. A sold, withdrawn or
 *    private listing leaves every feed on purpose. Counted as "excluded" it
 *    would put a warning on the card for the desk's own correct decision, so
 *    it is listed apart (offSite) — and never ALSO as excluded, whatever its
 *    photos or description would say.
 *  - ELIGIBILITY IS PER PORTAL. The same listing can be in A Place in the
 *    Sun's feed (one photo) and out of JamesEdition's (two of 800×600).
 *  - IT PAGES, AND FAILS LOUD. portal_listings is read through fetchAll: a
 *    full page of 1,000 is not the end, and a failed or hollow page throws
 *    rather than handing back what was read so far as everything — a summary
 *    that silently stopped at 1,000 would under-count every portal at once.
 */

type Media = PortalMediaRow;

/** Two large JPEG photographs: enough for every Kyero portal, JamesEdition included. */
const GOOD_PHOTOS: Media[] = [
  { kind: "photo", path_jpeg: "p/1.jpg", width: 2400, height: 1600 },
  { kind: "photo", path_jpeg: "p/2.jpg", width: 2400, height: 1600 },
];

/** An embedded `properties` row as the summary's select returns it — eligible everywhere by default. */
function prop(id: string, reference: string, over: Record<string, unknown> = {}) {
  return {
    id,
    reference,
    title: { en: `Listing ${reference}` },
    visibility: "public",
    status: "available",
    transaction_type: "sale",
    asking_price: 600000,
    rent_price_month: null,
    currency: "EUR",
    public_description: { en: "A house." },
    property_type: "villa",
    location: null,
    location_approx: false,
    districts: { name: { en: "Paphos" } },
    areas: null,
    property_media: GOOD_PHOTOS,
    ...over,
  };
}

const sel = (portal: string, p: ReturnType<typeof prop> | null) => ({
  portal,
  property_id: p?.id ?? "gone",
  properties: p,
});

const EMPTY = { selected: 0, inFeed: 0, excluded: [], offSite: [] };

function run(pages: FakePage[]) {
  const fake = fakeClient({ portal_listings: pages });
  return { fake, result: buildPortalSelectionSummary(fake.client as never) };
}

describe("buildPortalSelectionSummary", () => {
  it("sorts each portal's selections into in the feed, excluded (with why and where to fix it), and off the website", async () => {
    const je = portalById("jamesedition")!;

    // deliberately NOT in reference order: the lists must come back sorted
    const inFeed = prop("p-b", "B-002");
    const onePhoto = prop("p-c", "C-003", { property_media: [GOOD_PHOTOS[0]] });
    const noEnglish = prop("p-a", "A-001", { public_description: { el: "Σπίτι." }, title: {} });
    // gone from the website — and failing requirements too, which must not
    // make it "excluded" as well
    const sold = prop("p-s", "S-009", { status: "sold", property_media: [] });
    const withdrawn = prop("p-w", "W-008", { status: "withdrawn" });
    const privateOne = prop("p-p", "P-007", { visibility: "private" });

    const { result } = run([
      {
        data: [
          sel("jamesedition", sold),
          sel("jamesedition", onePhoto),
          sel("jamesedition", inFeed),
          sel("jamesedition", privateOne),
          sel("jamesedition", noEnglish),
          sel("jamesedition", withdrawn),
          // the one-photo listing again, for a portal that asks for one photo
          sel("aplaceinthesun", onePhoto),
          // a portal id this build does not know: no entry, no crash
          sel("some_retired_portal", inFeed),
        ],
        error: null,
      },
    ]);
    const summary = await result;

    // one entry per registry portal, and nothing else
    expect([...summary.keys()]).toEqual(PORTALS.map((p) => p.id));

    const j = summary.get("jamesedition")!;
    expect(j.selected).toBe(6);
    expect(j.inFeed).toBe(1);
    expect(j.excluded).toEqual([
      {
        propertyId: "p-a",
        reference: "A-001",
        // no English title: the reference stands in, never an empty link
        title: "A-001",
        reasons: [{ text: reasonText(je, "no_description_en"), fixTab: "marketing" }],
      },
      {
        propertyId: "p-c",
        reference: "C-003",
        title: "Listing C-003",
        reasons: [{ text: reasonText(je, "too_few_photos"), fixTab: "media" }],
      },
    ]);
    expect(j.offSite).toEqual([
      { propertyId: "p-p", reference: "P-007", title: "Listing P-007", status: "available", visibility: "private" },
      { propertyId: "p-s", reference: "S-009", title: "Listing S-009", status: "sold", visibility: "public" },
      { propertyId: "p-w", reference: "W-008", title: "Listing W-008", status: "withdrawn", visibility: "public" },
    ]);
    // every selection is accounted for exactly once
    expect(j.inFeed + j.excluded.length + j.offSite.length).toBe(j.selected);

    // the same one-photo listing passes A Place in the Sun's requirements
    expect(summary.get("aplaceinthesun")).toEqual({ selected: 1, inFeed: 1, excluded: [], offSite: [] });

    // a portal nobody selected anything for reads zero, not missing
    expect(summary.get("properstar")).toEqual(EMPTY);
  });

  it("measures photos against the portal's minimum size", async () => {
    const small: Media[] = [
      { kind: "photo", path_jpeg: "p/1.jpg", width: 640, height: 480 },
      { kind: "photo", path_jpeg: "p/2.jpg", width: 640, height: 480 },
      // not a photo, and a photo with no JPEG: neither counts
      { kind: "floor_plan", path_jpeg: "p/plan.jpg", width: 2400, height: 1600 },
      { kind: "photo", path_jpeg: null, width: 2400, height: 1600 },
    ];
    const { result } = run([
      { data: [sel("jamesedition", prop("p-1", "R-1", { property_media: small }))], error: null },
    ]);
    const j = (await result).get("jamesedition")!;

    expect(j.inFeed).toBe(0);
    expect(j.excluded.map((l) => l.reasons.map((r) => r.fixTab))).toEqual([["media"]]);
  });

  it("reads a listing with no media rows as one with no photos, not as a crash", async () => {
    const { result } = run([
      { data: [sel("aplaceinthesun", prop("p-1", "R-1", { property_media: null }))], error: null },
    ]);
    const a = (await result).get("aplaceinthesun")!;

    expect(a.inFeed).toBe(0);
    expect(a.excluded[0].reasons.map((r) => r.fixTab)).toEqual(["media"]);
  });

  // fetchAll stops on an EMPTY page and advances by what arrived. A summary
  // that took the first 1,000 rows for the whole selection would under-count
  // every portal with no sign anywhere.
  it("pages through every selection: a full page of 1,000, a short one, then the empty one that ends it", async () => {
    const full = Array.from({ length: 1000 }, (_, i) =>
      sel("properstar", prop(`p-${i}`, `R-${String(i).padStart(4, "0")}`)),
    );
    const { fake, result } = run([
      { data: full, error: null },
      {
        data: [
          sel("properstar", prop("p-x", "X-1", { status: "sold" })),
          sel("jamesedition", prop("p-y", "Y-1")),
        ],
        error: null,
      },
      { data: [], error: null },
    ]);
    const summary = await result;

    expect(summary.get("properstar")!.selected).toBe(1001);
    expect(summary.get("properstar")!.inFeed).toBe(1000);
    expect(summary.get("properstar")!.offSite.map((l) => l.reference)).toEqual(["X-1"]);
    expect(summary.get("jamesedition")!.inFeed).toBe(1);

    // three reads over consecutive ranges, each uniquely ordered — a page over
    // an unordered result is a different random sample each time
    expect(fake.served.portal_listings).toBe(3);
    expect(fake.argsOf("portal_listings", "range")).toEqual([
      [0, 999],
      [1000, 1999],
      [1002, 2001],
    ]);
    expect(fake.argsOf("portal_listings", "order")).toEqual([
      ["property_id"],
      ["portal"],
      ["property_id"],
      ["portal"],
      ["property_id"],
      ["portal"],
    ]);
  });

  // The embed is what keeps ids out of the URL (BACKLOG "id lists"): one read
  // of portal_listings carrying its property, names and photos — through the
  // composite tenant key, so a selection can only ever embed its own org's row.
  it("embeds each selection's property, names and photos in the one read", async () => {
    const { fake, result } = run([{ data: [], error: null }]);
    await result;

    const [[columns]] = fake.argsOf("portal_listings", "select") as [[string]];
    expect(columns).toContain("properties!portal_listings_org_property_fkey(");
    expect(columns).toContain(PORTAL_PROPERTY_COLUMNS);
    expect(columns).toContain("property_media(kind, path_jpeg, width, height)");
    // and nothing else is read: no second query keyed by a list of property ids
    expect(new Set(fake.calls.map((c) => c.table))).toEqual(new Set(["portal_listings"]));
  });

  it("throws when a page fails, rather than summarising the pages before it", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => sel("properstar", prop(`p-${i}`, `R-${i}`)));
    const { result } = run([
      { data: full, error: null },
      { data: null, error: { message: "canceling statement due to statement timeout" } },
    ]);

    await expect(result).rejects.toThrow(
      "Query failed (portal selections): canceling statement due to statement timeout",
    );
  });

  it("throws on a failed first page, never an all-zero summary", async () => {
    const { result } = run([{ data: null, error: { message: "permission denied for table portal_listings" } }]);
    await expect(result).rejects.toThrow("Query failed (portal selections): permission denied");
  });

  // postgrest-js answers an empty body as `data: null, error: null`; read as
  // "no rows" it would show every portal as "No listing is selected".
  it.each([
    ["null", null],
    ["an object", { portal: "jamesedition" }],
  ])("throws on a hollow page (%s)", async (_label, data) => {
    const { result } = run([{ data: data as FakePage["data"], error: null }]);
    await expect(result).rejects.toThrow("Query failed (portal selections): the answer held no rows");
  });
});
