import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MatchVerdict } from "@/lib/services/matching";

// the components' actions, outside a Next app: rendering must call none of them
const createShareLink = vi.hoisted(() => vi.fn());
vi.mock("@/lib/actions/share-links", () => ({ createShareLink }));
vi.mock("@/lib/actions/viewings", () => ({ createViewing: vi.fn(), checkViewingConflicts: vi.fn() }));
vi.mock("@/lib/actions/entity-search", () => ({ searchEntities: vi.fn() }));

const { MatchProposalList, BuyerRowActions } = await import("@/components/features/shared/match-proposal");

/**
 * A match row, one step further (A04), as the server renders it before any
 * click: the visibility and "Proposed" chips, every tick EMPTY (a proposal is
 * a deliberate shortlist), the Create button disabled until something is
 * ticked, the "nothing is sent" line under it — and for an archived or erased
 * contact, none of the actions at all. Nothing is minted by rendering.
 */

const markup = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const verdict: MatchVerdict = { eligible: true, score: 90, blockers: [], misses: [], hits: [] };
const buyer = { id: "c1", name: "Elena Petrova", languages: ["ru"] };
const row = (id: string, status: string, visibility: string, proposed: { date: string; detail: string } | null = null) => ({
  listing: { id, reference: `REF-${id}`, status, visibility },
  title: `Title ${id}`,
  subline: `REF-${id} · €300.000 · 3 bed`,
  verdict,
  proposed,
});

describe("MatchProposalList", () => {
  const rows = [
    row("p1", "available", "private", { date: "12 Oct 2026", detail: "Link live · opened 2 times (link previews count too)" }),
    row("p2", "reserved", "off_market"),
    row("p3", "available", "vip"),
  ];

  it("shows the chips, starts with nothing ticked, and cannot be pressed yet", () => {
    const html = markup(createElement(MatchProposalList, { listKey: "req1", buyer, rows, canAct: true, role: "agent" }));
    expect(html).toContain("Proposed 12 Oct 2026");
    expect(html).toContain("Off-market");
    expect(html).toContain("VIP only");
    // three ticks, none checked
    expect(html.match(/role="checkbox"/g)).toHaveLength(3);
    expect(html).not.toMatch(/aria-checked="true"/);
    expect(html).toContain('aria-label="Include REF-p2 in the proposal"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Create proposal for Elena Petrova \(0\)/);
    // the reserved row says what a proposal page would not
    expect(html).toContain("Reserved — a proposal page does not show that");
    expect(html.match(/a proposal page does not show that/g), "only the reserved row").toHaveLength(1);
    // the off-market confirmation appears once one is ticked, not before
    expect(html).not.toContain("This buyer may see off-market listings");
    expect(html).toContain("Nothing is sent");
    expect(html, "in the buyer's language").toContain("in Russian");
    // a viewing per row, both parties filled in
    expect(html).toContain('aria-label="Viewing — REF-p1 with Elena Petrova"');
    // no link was minted by drawing the list
    expect(html).not.toContain("Proposal link ready");
    expect(createShareLink).not.toHaveBeenCalled();
  });

  it("an archived or erased contact: the matches, and no tick, no Create, no Viewing", () => {
    const html = markup(createElement(MatchProposalList, { listKey: "req1", buyer, rows, canAct: false, role: "admin" }));
    expect(html).toContain("Title p1");
    expect(html).not.toContain('role="checkbox"');
    expect(html).not.toContain("Create proposal");
    expect(html).not.toContain("Viewing —");
  });

  it("a listing manager gets ticks and Create, but no Viewing — the dialog's own role gate", () => {
    const html = markup(createElement(MatchProposalList, { listKey: "req1", buyer, rows, canAct: true, role: "listing_manager" }));
    expect(html).toContain("Create proposal for");
    expect(html).not.toContain("Viewing —");
  });
});

describe("BuyerRowActions (the property side)", () => {
  it("offers Proposal and Viewing for that buyer and listing", () => {
    const html = markup(
      createElement(BuyerRowActions, {
        buyer,
        listing: { id: "p1", reference: "PAF0001", status: "available", visibility: "private" },
        listingLabel: "Sea view villa",
        role: "agent",
      }),
    );
    expect(html).toContain('aria-label="Proposal — PAF0001 for Elena Petrova"');
    expect(html).toContain('aria-label="Viewing — PAF0001 with Elena Petrova"');
    expect(createShareLink).not.toHaveBeenCalled();
  });
});
