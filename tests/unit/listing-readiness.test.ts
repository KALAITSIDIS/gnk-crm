import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ListingReadiness } from "@/components/features/properties/listing-readiness";
import { PropertyTabs } from "@/components/features/properties/property-tabs";
import { QualityWorklist } from "@/components/features/properties/quality-worklist";
import { QualityScoreRing } from "@/components/features/shared/quality-score-ring";
import { TooltipProvider } from "@/components/ui/tooltip";
import { computeQualityScore, type QualityScoreInput } from "@/lib/services/quality-score";
import { buildWorklist, type ScoredProperty } from "@/lib/services/quality-worklist";

/**
 * F03, rendered the way the server renders it: the property page's readiness
 * panel says — in visible text, not in a hover tooltip — whether the listing
 * has what the website needs, how complete it is, and what is wrong with its
 * data, each linked to the tab it is fixed on; the ring is a focusable button;
 * the worklist names public listings without essentials first and groups an
 * inherited build contradiction under its source.
 */
const perfect: QualityScoreInput = {
  isLand: false,
  isContainer: false,
  unitCount: 0,
  hasCoverPhoto: true,
  photoCount: 6,
  titleEn: "A title",
  publicDescriptionEn: "x".repeat(300),
  hasPrice: true,
  hasArea: true,
  hasBedroomsAndBathrooms: true,
  hasPlanningZoneAndDensity: true,
  hasCoords: true,
  titleDeedSet: true,
  permitSet: true,
  mandateActive: true,
  hasAssignedAgent: true,
  hasOwnerOrDeveloper: true,
};
const NO_PHOTO = { hasCoverPhoto: false, photoCount: 0 };
const DELIVERY_PASSED = "The delivery date has passed and the build is not recorded as finished.";

const panel = (
  over: Partial<QualityScoreInput>,
  props: Partial<{ visibility: string; status: string; container: boolean; buildSource: { id: string; reference: string } | null }> = {},
) =>
  renderToStaticMarkup(
    createElement(
      PropertyTabs,
      // children go as createElement's third argument (react/no-children-prop)
      { initialTab: "overview" } as ComponentProps<typeof PropertyTabs>,
      createElement(ListingReadiness, {
        propertyId: "p1",
        visibility: "public",
        status: "available",
        container: false,
        quality: computeQualityScore({ ...perfect, ...over }),
        buildSource: null,
        ...props,
      }),
    ),
  );
/** visible text, tags stripped, whitespace collapsed */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("the readiness panel on the property page", () => {
  it("says, in visible text, that a public 85-point listing is on the website without a cover photo", () => {
    const html = panel(NO_PHOTO);
    const t = text(html);
    expect(t).toContain("Website essentials");
    expect(t).toMatch(/Public on the website without: cover photo \./);
    expect(t).toContain("It stays public until someone changes it");
    expect(t).toContain("Completeness 85/100");
    expect(t).toContain("Clears the publish threshold of 70.");
    expect(t).toContain("Data warnings None.");
    // the gap links to the tab it is fixed on
    expect(html).toMatch(/<a [^>]*href="\/properties\/p1\?tab=media"[^>]*>cover photo<\/a>/);
    expect(html).toMatch(/href="\/properties\/p1\?tab=media"[^>]*>At least 6 photos/);
    // and per-portal requirements are pointed to, not re-derived
    expect(html).toMatch(/Portals card of the <a [^>]*href="\/properties\/p1\?tab=marketing"/);
  });

  it("asks for the essentials before publishing when the listing is not on the website", () => {
    const t = text(panel({ ...NO_PHOTO, hasPrice: false }, { visibility: "private" }));
    expect(t).toMatch(/Needed before it goes on the website: cover photo , price \./);
    expect(t).not.toContain("Public on the website without");
    expect(t).toContain("Completeness 75/100");
  });

  it("is not alarmed by a public listing whose status takes it off the website", () => {
    const t = text(panel(NO_PHOTO, { status: "reserved" }));
    expect(t).toContain("Needed before it goes on the website");
  });

  it("says everything is in place, and names the threshold, for a complete listing", () => {
    const t = text(panel({}));
    expect(t).toContain("All in place: cover photo, English title, price.");
    expect(t).toContain("All criteria met.");
  });

  it("states a below-threshold score as such, for a listing not yet public", () => {
    const t = text(panel({ titleDeedSet: false, mandateActive: false, hasCoords: false, permitSet: false }, { visibility: "private" }));
    expect(t).toContain("Completeness 65/100");
    expect(t).toContain("Below the publish threshold of 70: going public needs an admin's override.");
  });

  it("sends a container's missing prices to its Units page", () => {
    const html = panel(
      { isContainer: true, unitCount: 2, pricedUnitCount: 0, hasArea: false, hasBedroomsAndBathrooms: false },
      { container: true },
    );
    expect(html).toMatch(/href="\/properties\/p1\/units"[^>]*>priced units<\/a>/);
    expect(html).toMatch(/href="\/properties\/p1\/units"[^>]*>Units priced<span/);
  });

  it("never suggests an override can publish an empty project", () => {
    const t = text(
      panel(
        { isContainer: true, unitCount: 0, pricedUnitCount: 0, hasArea: false, hasBedroomsAndBathrooms: false, mandateActive: false },
        { container: true, visibility: "private" },
      ),
    );
    expect(t).toContain("Completeness 65/100");
    expect(t).toContain(
      "No units yet: it cannot be published whatever its score, and no override changes that — add its units first.",
    );
    expect(t).not.toContain("admin's override");
  });

  it("says where an inherited build contradiction is corrected", () => {
    const html = panel({ buildConflict: DELIVERY_PASSED }, { buildSource: { id: "proj", reference: "PAF0002" } });
    const t = text(html);
    expect(t).toContain(DELIVERY_PASSED);
    expect(t).toContain("Inherited from PAF0002 — correct it there, then sync from its Units page .");
    expect(html).toContain('href="/properties/proj?tab=details"');
    expect(html).toContain('href="/properties/proj/units"');
  });

  it("sends a listing's own contradiction and a shared photograph to its own tabs", () => {
    const html = panel({ buildConflict: DELIVERY_PASSED, sharedPhotoWith: ["PAF0007"] });
    expect(html).toMatch(/href="\/properties\/p1\?tab=details"[^>]*>Details tab<\/a>/);
    expect(text(html)).toContain("A photograph also appears on PAF0007");
    expect(html).toMatch(/href="\/properties\/p1\?tab=media"[^>]*>Media tab<\/a>/);
  });
});

describe("the score ring is a button (F03)", () => {
  const ring = (score: number, missing: number, warnings = 0) =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(QualityScoreRing, {
          score,
          missing: Array.from({ length: missing }, (_, i) => ({ key: `k${i}`, label: `Item ${i}`, points: 5 })),
          warnings: Array.from({ length: warnings }, (_, i) => ({ key: "shared_photo" as const, label: `W${i}` })),
        }),
      ),
    );

  it("is reachable by keyboard and says the score and what is missing", () => {
    const html = ring(85, 2, 1);
    expect(html).toMatch(/^<button[^>]* type="button"/);
    expect(html).toContain('aria-label="Quality score 85 of 100, 2 criteria missing, 1 data warning"');
    expect(ring(100, 0)).toContain('aria-label="Quality score 100 of 100, all criteria met"');
  });
});

describe("the worklist page (F03)", () => {
  const scored = (
    reference: string,
    listing: ScoredProperty["listing"],
    over: Partial<QualityScoreInput> = {},
    lineage?: ScoredProperty["lineage"],
  ): ScoredProperty => {
    const result = computeQualityScore({ ...perfect, ...over });
    return {
      property: { id: `id-${reference}`, reference, title: null, score: result.score },
      listing,
      result,
      ...(lineage ? { lineage } : {}),
    };
  };
  const PUBLIC = { visibility: "public", status: "available", publishedAt: "2026-10-01T00:00:00Z" };
  const PRIVATE = { visibility: "private", status: "available", publishedAt: null };
  const INHERITS = ["construction_status", "delivery_date"];

  it("names public listings without website essentials first, each gap linked to its tab", () => {
    const html = renderToStaticMarkup(
      createElement(QualityWorklist, {
        worklist: buildWorklist([scored("PAF0004", PUBLIC, NO_PHOTO), scored("PAF0009", PRIVATE, NO_PHOTO)]),
      }),
    );
    const t = text(html);
    expect(t).toContain("Public without website essentials: 1 listing");
    expect(t).toContain("PAF0004 85 lacks cover photo");
    expect(t.indexOf("Public without website essentials")).toBeLessThan(t.indexOf("missing: Cover photo"));
    expect(html).toMatch(/href="\/properties\/id-PAF0004\?tab=media"[^>]*>cover photo<\/a>/);
    // the category chips open each listing on the tab the gap is fixed on
    expect(html).toMatch(/href="\/properties\/id-PAF0009\?tab=media"/);
  });

  it("lists a project's contradiction once, with the units inheriting it", () => {
    const html = renderToStaticMarkup(
      createElement(QualityWorklist, {
        worklist: buildWorklist([
          scored("PAF0002", PRIVATE, { buildConflict: DELIVERY_PASSED }, { parentId: null, inheritedFields: [] }),
          ...["A1", "A2", "A3"].map((u) =>
            scored(`PAF0002-${u}`, PRIVATE, { buildConflict: DELIVERY_PASSED }, { parentId: "id-PAF0002", inheritedFields: INHERITS }),
          ),
        ]),
      }),
    );
    const t = text(html);
    expect(t).toContain("4 listings declare build details that contradict each other — 1 to correct");
    expect(t).toContain(
      "Inherited by 3 listings under it (PAF0002-A1, PAF0002-A2, PAF0002-A3): fix it on PAF0002, then sync them from its Units page .",
    );
    expect(html).toContain('href="/properties/id-PAF0002/units"');
    expect(html.match(/href="\/properties\/id-PAF0002\?tab=details"/g)).toHaveLength(1);
    expect(html).not.toContain('href="/properties/id-PAF0002-A1?tab=details"');
  });
});
