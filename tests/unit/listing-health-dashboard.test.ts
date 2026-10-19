import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeQualityScore, type QualityScoreInput } from "@/lib/services/quality-score";
import { buildWorklist, type ScoredProperty, type Worklist } from "@/lib/services/quality-worklist";

/**
 * F03: the admin dashboard's Listing health, rendered with the real English
 * messages (dashboard.listingHealth.*). It reads the worklist's fresh
 * computation — the module is mocked here to hand it one — and states the
 * website essentials, completeness, the market and the data warnings as
 * separate lines; green only when the first two are clean and no price
 * review is due. A failed read says so, never "nothing to report".
 */
const h = vi.hoisted(() => ({ worklist: null as Worklist | null, fail: null as Error | null }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/queries/quality-worklist", () => ({
  fetchQualityWorklist: vi.fn(async () => {
    if (h.fail) throw h.fail;
    return h.worklist;
  }),
}));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const en = (await import("@/messages/en.json")).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({
        locale: "en",
        messages: en,
        namespace: namespace as never,
        onError: (e) => {
          throw e;
        },
      }),
  };
});

const { ListingHealth } = await import("@/components/features/dashboard/listing-health");

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
const DAY = 86_400_000;
const row = (
  reference: string,
  daysAgo: number | null,
  over: Partial<QualityScoreInput> = {},
  extra: Partial<ScoredProperty> = {},
): ScoredProperty => {
  const result = computeQualityScore({ ...perfect, ...over });
  return {
    property: { id: `id-${reference}`, reference, title: null, score: result.score },
    listing:
      daysAgo === null
        ? { visibility: "private", status: "available", publishedAt: null }
        : { visibility: "public", status: "available", publishedAt: new Date(Date.now() - daysAgo * DAY).toISOString() },
    result,
    ...extra,
  };
};

async function render(rows: ScoredProperty[]) {
  h.worklist = buildWorklist(rows);
  const html = renderToStaticMarkup((await ListingHealth()) as ReactElement);
  const lines = [...html.matchAll(/<li[^>]*data-line="(\w+)"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => [
    m[1]!,
    m[2]!.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").trim(),
  ]);
  return { html, lines: Object.fromEntries(lines) as Record<string, string> };
}

beforeEach(() => {
  h.worklist = null;
  h.fail = null;
});

describe("the dashboard's Listing health line (F03)", () => {
  it("names a public 85-point listing with no photograph under website essentials — and is not green", async () => {
    const { html, lines } = await render([row("PAF0004", 12, { hasCoverPhoto: false, photoCount: 0 }), row("PAF0001", 30)]);
    expect(html).toContain('data-listing-health="attention"');
    expect(html).toContain("Listing health — needs attention");
    expect(lines.essentials).toBe(
      "Website essentials: 1 public listing lacks what the site needs — PAF0004 (cover photo).",
    );
    // a separate statement: both clear the threshold
    expect(lines.completeness).toBe("Completeness: all 2 public listings score 70 or more.");
    expect(lines.market).toBe("Longest on the market: PAF0001, 30 days.");
    expect(lines.warnings).toBe("Data warnings across live listings: none.");
  });

  it("is green only when the essentials and completeness are clean and no price review is due", async () => {
    const { html, lines } = await render([row("PAF0001", 10)]);
    expect(html).toContain('data-listing-health="healthy"');
    expect(html).toContain("Listing health — ready to market");
    expect(lines.essentials).toBe(
      "Website essentials: the 1 public listing has a cover photo, an English title and a price.",
    );
    expect(lines.completeness).toBe("Completeness: the 1 public listing scores 70 or more.");
  });

  it("names public listings below the threshold with their fresh scores", async () => {
    const { html, lines } = await render([
      row("THIN", 3, { titleDeedSet: false, mandateActive: false, hasCoords: false, permitSet: false }),
    ]);
    expect(html).toContain('data-listing-health="attention"');
    expect(lines.completeness).toBe("Completeness: 1 public listing scores below 70 — THIN (65).");
  });

  it("states data warnings apart — counted by source — and never lets them turn the line amber", async () => {
    const conflict = "The delivery date has passed and the build is not recorded as finished.";
    const inherits = ["construction_status", "delivery_date"];
    const { html, lines } = await render([
      row("PAF0001", 5),
      row("PAF0002", null, { buildConflict: conflict }, { lineage: { parentId: null, inheritedFields: [] } }),
      row("PAF0002-A1", null, { buildConflict: conflict }, { lineage: { parentId: "id-PAF0002", inheritedFields: inherits } }),
      row("PAF0002-A2", null, { buildConflict: conflict }, { lineage: { parentId: "id-PAF0002", inheritedFields: inherits } }),
      row("PAF0005", null, { sharedPhotoWith: ["PAF0006"] }),
    ]);
    expect(lines.warnings).toBe(
      "Data warnings across live listings: 3 build contradictions (1 to correct) · 1 listing shares a photograph.",
    );
    expect(html).toContain('data-listing-health="healthy"');
  });

  it("flags a price review on the market line", async () => {
    const { html, lines } = await render([row("OLD", 95)]);
    expect(lines.market).toBe("Longest on the market: OLD, 95 days. 1 listing at 90+ days, due a price review.");
    expect(html).toContain('data-listing-health="attention"');
  });

  it("says nothing is public — never 'all 0 listings'", async () => {
    const { html, lines } = await render([row("PRIVATE", null)]);
    expect(lines.essentials).toBe("Website essentials: nothing is public on the website.");
    expect(lines.completeness).toBeUndefined();
    expect(lines.market).toBeUndefined();
    expect(html).toContain(">Listing health</h2>");
  });

  it("says the read failed, rather than painting a failure as a clean bill", async () => {
    h.fail = new Error("Query failed (worklist live listings): boom");
    const html = renderToStaticMarkup((await ListingHealth()) as ReactElement);
    expect(html).toContain("Listing health: unreadable (Query failed (worklist live listings): boom).");
    expect(html).not.toContain("ready to market");
  });
});
