import { SHARE_LOCALES, shareLinkState, type ShareLocale } from "@/lib/services/share-links";

/**
 * A match turned into a buyer-bound proposal (A04). Pure rules shared by the
 * contact side (pick several matches for one buyer) and the property side (one
 * listing for one matched buyer), so the two cannot tell the desk different
 * things about the same listing.
 *
 * NOTHING HERE SENDS ANYTHING. A proposal is the existing magic link
 * (`createShareLink`, B3): minted, shown once, and handed to the buyer by the
 * agent, by hand, as today. No message is drafted or prefilled.
 *
 * Kept free of node-only imports: the client component imports it.
 */

/** The most a proposal holds — `createShareLink` refuses more (its createSchema). */
export const PROPOSAL_MAX_LISTINGS = 25;

/**
 * Visibilities that limit who a listing is for. A match row shows a chip for
 * each, because a proposal page puts the listing in front of the buyer.
 * `public` and `private` carry none: private is the default for stock not on
 * the website, and a chip on most rows would be noise. `archived` never
 * reaches a match row (the matcher drops it).
 */
const AUDIENCE_LIMITED: Record<string, string> = {
  off_market: "Off-market",
  vip: "VIP only",
  partner: "Partner only",
  coming_soon: "Coming soon",
};

export function visibilityChipLabel(visibility: string | null | undefined): string | null {
  return visibility ? (AUDIENCE_LIMITED[visibility] ?? null) : null;
}

/**
 * Only `off_market` asks for an explicit "this buyer may see it" before a
 * proposal is made: it is the visibility whose whole point is that buyers are
 * chosen. Whether VIP, partner and coming-soon stock should ask too has no
 * audience model behind it yet: an open operator decision (T-match-workflow),
 * not guessed here.
 */
export function needsAudienceConfirmation(listings: readonly { visibility: string | null | undefined }[]): boolean {
  return listings.some((l) => l.visibility === "off_market");
}

/**
 * What the proposal page will NOT tell the buyer about this listing. The
 * resolver's payload carries no status (0023 / 0146, pinned by RLS test 25),
 * so a reserved unit reads there as plainly available.
 */
export function statusCaveat(status: string | null | undefined): string | null {
  if (status === "reserved") return "Reserved";
  if (status === "under_offer") return "Under offer";
  return null;
}

/** The proposal page's language: the first of the buyer's languages it speaks, else English. */
export function proposalLocale(languages: readonly string[] | null | undefined): ShareLocale {
  for (const l of languages ?? []) {
    const code = typeof l === "string" ? l.trim().toLowerCase() : "";
    if ((SHARE_LOCALES as readonly string[]).includes(code)) return code as ShareLocale;
  }
  return "en";
}

/**
 * The words behind a "Proposed" chip, and on a Proposals sent row: the link's
 * state and how often it was opened. The count is the public page's own and
 * includes link previews — a chat app unfurling the URL opens it too — so it
 * is never shown as "the buyer looked N times".
 */
export function proposedDetail(
  p: { expiresAt: string; revokedAt: string | null; viewCount: number },
  now: Date = new Date(),
): string {
  const state = shareLinkState({ expires_at: p.expiresAt, revoked_at: p.revokedAt }, now);
  return `Link ${state} · ${opensText(p.viewCount)}`;
}

export function opensText(viewCount: number): string {
  return `opened ${viewCount} time${viewCount === 1 ? "" : "s"} (link previews count too)`;
}

/**
 * Why "Create proposal" cannot be pressed yet, in the words shown beside it —
 * or null when it can. The action re-checks all of it but the confirmation,
 * which is the desk's judgement and exists only here.
 */
export function proposalBlocker(input: {
  listings: readonly { visibility: string | null | undefined }[];
  offMarketConfirmed: boolean;
}): string | null {
  if (input.listings.length === 0) return "Tick at least one listing.";
  if (input.listings.length > PROPOSAL_MAX_LISTINGS) {
    return `A proposal is a shortlist — ${PROPOSAL_MAX_LISTINGS} listings at most.`;
  }
  if (needsAudienceConfirmation(input.listings) && !input.offMarketConfirmed) {
    return "Confirm this buyer may see off-market listings first.";
  }
  return null;
}
