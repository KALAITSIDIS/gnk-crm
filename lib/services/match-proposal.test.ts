import { describe, expect, it } from "vitest";
import {
  PROPOSAL_MAX_LISTINGS,
  needsAudienceConfirmation,
  opensText,
  proposalBlocker,
  proposalLocale,
  proposedDetail,
  statusCaveat,
  visibilityChipLabel,
} from "./match-proposal";
import { VISIBILITY_LEVELS } from "@/lib/validators/properties";

/**
 * The rules a match → proposal step shows the desk before anything is minted
 * (A04): who a listing is for, what the proposal page will not say, and when
 * "Create proposal" may be pressed.
 */

describe("visibilityChipLabel", () => {
  it("marks exactly the audience-limited visibilities, and says nothing for public, private or archived", () => {
    const marked = VISIBILITY_LEVELS.filter((v) => visibilityChipLabel(v) !== null);
    expect([...marked].sort()).toEqual(["coming_soon", "off_market", "partner", "vip"]);
    expect(visibilityChipLabel("off_market")).toBe("Off-market");
    expect(visibilityChipLabel(null)).toBeNull();
    expect(visibilityChipLabel("something_new")).toBeNull();
  });
});

describe("needsAudienceConfirmation", () => {
  it("only an off-market listing asks — VIP, partner and coming soon are an operator decision, not guessed", () => {
    expect(needsAudienceConfirmation([{ visibility: "off_market" }])).toBe(true);
    expect(needsAudienceConfirmation([{ visibility: "private" }, { visibility: "off_market" }])).toBe(true);
    for (const v of ["public", "private", "vip", "partner", "coming_soon"]) {
      expect(needsAudienceConfirmation([{ visibility: v }]), v).toBe(false);
    }
    expect(needsAudienceConfirmation([])).toBe(false);
  });
});

describe("statusCaveat", () => {
  it("names what the proposal page hides — reserved and under offer — and nothing else", () => {
    expect(statusCaveat("reserved")).toBe("Reserved");
    expect(statusCaveat("under_offer")).toBe("Under offer");
    expect(statusCaveat("available")).toBeNull();
    expect(statusCaveat(undefined)).toBeNull();
  });
});

describe("proposalLocale", () => {
  it("the first of the buyer's languages a proposal page speaks, else English", () => {
    expect(proposalLocale(["ru", "en"])).toBe("ru");
    expect(proposalLocale(["de", " EL "])).toBe("el");
    expect(proposalLocale(["de"])).toBe("en");
    expect(proposalLocale([])).toBe("en");
    expect(proposalLocale(null)).toBe("en");
    expect(proposalLocale([42 as unknown as string, "ru"])).toBe("ru");
  });
});

describe("proposalBlocker", () => {
  const listing = (visibility = "private") => ({ visibility });

  it("nothing ticked, too many, or an off-market listing not yet confirmed — each said in words", () => {
    expect(proposalBlocker({ listings: [], offMarketConfirmed: false })).toMatch(/at least one/i);
    expect(
      proposalBlocker({ listings: Array.from({ length: PROPOSAL_MAX_LISTINGS + 1 }, () => listing()), offMarketConfirmed: true }),
    ).toMatch(/25 listings at most/);
    expect(proposalBlocker({ listings: [listing("off_market")], offMarketConfirmed: false })).toMatch(/off-market/i);
  });

  it("ready when something is ticked, within the cap, and any off-market listing is confirmed", () => {
    expect(proposalBlocker({ listings: [listing()], offMarketConfirmed: false })).toBeNull();
    expect(proposalBlocker({ listings: [listing("off_market")], offMarketConfirmed: true })).toBeNull();
    expect(
      proposalBlocker({ listings: Array.from({ length: PROPOSAL_MAX_LISTINGS }, () => listing()), offMarketConfirmed: false }),
    ).toBeNull();
  });

  it("matches the action's cap", () => {
    expect(PROPOSAL_MAX_LISTINGS).toBe(25);
  });
});

describe("proposedDetail / opensText", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  it("says the link's state and how often it was opened, with the link-preview caveat", () => {
    expect(proposedDetail({ expiresAt: "2026-11-01T00:00:00Z", revokedAt: null, viewCount: 1 }, now)).toBe(
      "Link live · opened 1 time (link previews count too)",
    );
    expect(proposedDetail({ expiresAt: "2026-10-01T00:00:00Z", revokedAt: null, viewCount: 0 }, now)).toBe(
      "Link expired · opened 0 times (link previews count too)",
    );
    expect(proposedDetail({ expiresAt: "2026-11-01T00:00:00Z", revokedAt: "2026-10-10T00:00:00Z", viewCount: 5 }, now)).toMatch(
      /^Link revoked/,
    );
    expect(opensText(2)).toBe("opened 2 times (link previews count too)");
  });
});
