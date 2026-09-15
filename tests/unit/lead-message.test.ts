import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LeadMessage } from "@/components/features/leads/lead-message";

/**
 * The inbox rendered `lead.message` with a single-line `truncate` and there
 * is no lead detail page, so a seller's ten-line brief was readable only in
 * the alert e-mail (audit 2026-09-15, LR-03). This component is the fix: the
 * first line stays as the row's summary, the rest opens in place — with no
 * JavaScript, because a <details> needs none — and the structured brief
 * (0098) shows as chips beside it.
 */
const website =
  "Website enquiry\nName: Maria Georgiou\nEmail: m@example.invalid\n\nIs PAF0001 still available?";

describe("LeadMessage", () => {
  it("folds a multi-line message into a disclosure: first line as the summary, the rest with its line breaks", () => {
    const html = renderToStaticMarkup(createElement(LeadMessage, { message: website, criteria: null }));
    expect(html).toContain("<details");
    expect(html).toMatch(/<summary[^>]*>Website enquiry/);
    expect(html).toContain("whitespace-pre-line");
    expect(html).toContain("Is PAF0001 still available?");
    expect(html).toContain("m@example.invalid");
  });

  it("renders a one-line message as a paragraph, with no disclosure", () => {
    const html = renderToStaticMarkup(
      createElement(LeadMessage, { message: "Called about PAF0002", criteria: null }),
    );
    expect(html).not.toContain("<details");
    expect(html).toContain("Called about PAF0002");
  });

  it("shows the brief as chips from criteria", () => {
    const html = renderToStaticMarkup(
      createElement(LeadMessage, {
        message: website,
        criteria: { channel: "website_form", budget: "over_1m", buy_area: "Tala / Tsada", utm_source: "instagram" },
      }),
    );
    expect(html).toContain("Over €1m");
    expect(html).toContain("Tala / Tsada");
    expect(html).toContain("via instagram");
  });

  it("renders nothing for a lead with no message and no brief", () => {
    expect(renderToStaticMarkup(createElement(LeadMessage, { message: null, criteria: null }))).toBe("");
  });
});
