import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * NO PORTAL STATUS CLAIMS PUBLICATION (portal integrations audit 2026-10-18,
 * finding 7).
 *
 * The CRM knows three things about a listing and a portal: that it is
 * SELECTED, whether it passes the portal's requirements and so is IN THE FEED
 * the portal is offered, and when the feed URL was last REQUESTED — by
 * anyone, the portal or an admin pasting the URL into a browser. No portal
 * ever reports back what it accepted or published. The old wording claimed
 * all of it anyway: a select toast read "On JamesEdition at its next pull",
 * the card said the listing was "advertised", the worklist said a public
 * listing was "live … on every portal", and the timeline said "Removed from
 * portal". Each read as a fact the CRM did not have.
 *
 * Read as source with comments stripped (a comment recalling the old wording
 * is not a UI string — tests/unit/one-time-secret-notices.test.ts is the
 * precedent). The three portal surfaces are checked whole: every string there
 * is about a portal. The quality worklist is checked only in the text runs
 * that mention a portal, because "Live listings" there is the CRM's own word
 * for a listing on the market and says nothing about any portal.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (...parts: string[]) => stripComments(readFileSync(join(root, ...parts), "utf-8"));
/** Whitespace collapsed, so a sentence JSX wrapped over two lines reads as one. */
const flat = (src: string) => src.replace(/\s+/g, " ");

/**
 * The text runs of a source: JSX text and string / template-literal bodies,
 * cut at tag brackets and string quotes. A run is small enough that a claim
 * found in one is in the same sentence as the portal it is about.
 */
const runsOf = (src: string) =>
  flat(src)
    .split(/[<>"`]/)
    .map((s) => s.trim())
    .filter(Boolean);
/** Runs that speak about a portal: the word, or a portal's name interpolated. */
const portalRunsOf = (src: string) => runsOf(src).filter((r) => /portal|\$?\{(row|portal)\.name\}/i.test(r));

/** Wording that claims what the CRM cannot know — each one a sentence it used to ship. */
const CLAIMS: readonly (readonly [string, RegExp])[] = [
  ["'On <portal>' (the old select toast)", /\bon \$?\{(row|portal)\.name\}/i],
  ["'published on'", /\bpublished on\b/i],
  ["'live on' / 'is live on'", /\blive on\b/i],
  ["'advertised'", /\badvertis/i],
  ["'on every portal'", /\bon every portal\b/i],
];
const claimsIn = (text: string) => CLAIMS.filter(([, re]) => re.test(text)).map(([name]) => name);

const PROPERTY_CARD = ["components", "features", "properties", "portals-card.tsx"] as const;
const SETTINGS_CARD = ["components", "features", "settings", "portal-card.tsx"] as const;
const SETTINGS_PAGE = ["app", "(app)", "settings", "portals", "page.tsx"] as const;
const WORKLIST = ["components", "features", "properties", "quality-worklist.tsx"] as const;

describe("the guard can fail", () => {
  // Each pattern is run against the sentence it exists for, as it read before
  // 2026-10-18 — a pattern that cannot match its own example guards nothing.
  it.each([
    ["the property card's select toast", "On ${row.name} at its next pull", "'On <portal>' (the old select toast)"],
    ["the property card's lede", "Where this listing is advertised beyond the website.", "'advertised'"],
    ["the settings page's lede", "Where listings are advertised beyond the website.", "'advertised'"],
    ["the worklist's threshold note", "Live on the site and on every portal. Complete the listing", "'on every portal'"],
    ["a status that would claim publication", "Published on ${row.name}", "'published on'"],
    ["a status that would claim a live advert", "This listing is live on {portal.name}", "'live on' / 'is live on'"],
  ])("%s is caught", (_where, sentence, claim) => {
    expect(claimsIn(sentence)).toContain(claim);
  });

  it("scopes the worklist to portal sentences: its 'Live listings' tile is not one", () => {
    const src = code(...WORKLIST);
    expect(runsOf(src)).toContain("Live listings");
    expect(portalRunsOf(src)).not.toContain("Live listings");
    expect(portalRunsOf(src).some((r) => /live/i.test(r)), "no portal sentence in the worklist says 'live'").toBe(false);
  });
});

describe("no portal status claims publication", () => {
  it.each([
    ["the property page's Portals card", PROPERTY_CARD],
    ["the Settings → Portals card", SETTINGS_CARD],
    ["the Settings → Portals page", SETTINGS_PAGE],
  ])("%s never says a listing is on, live on, published on or advertised by a portal", (_name, parts) => {
    expect(claimsIn(flat(code(...parts)))).toEqual([]);
  });

  it("the quality worklist's portal sentences claim nothing either", () => {
    const offending = portalRunsOf(code(...WORKLIST)).filter((r) => claimsIn(r).length > 0);
    expect(offending).toEqual([]);
  });

  // "pulled" claims the PORTAL asked. The route records every request that
  // carries the token (0150), so the honest word is "requested".
  it.each([
    ["the property page's Portals card", PROPERTY_CARD],
    ["the Settings → Portals card", SETTINGS_CARD],
  ])("%s says the feed URL was requested, never that the portal pulled", (_name, parts) => {
    const src = flat(code(...parts));
    // identifiers such as lastPulledAt / last_pulled_at have no word boundary before "pulled"
    expect(src).not.toMatch(/\bpulled\b/i);
    expect(src).not.toMatch(/\bnext pull\b/i);
    expect(src).toMatch(/Feed URL last requested/);
  });
});

/* The guard above must not be satisfiable by deleting the truth: each surface still says what it can and cannot know. */
describe("each surface says what is not verified", () => {
  it("the settings card says 'Publication not verified', under its own test id", () => {
    const src = flat(code(...SETTINGS_CARD));
    expect(src).toMatch(
      /data-testid=\{`portal-publication-\$\{portal\.id\}`\}> Publication not verified: \{portal\.name\} does not tell the CRM which listings it accepted or published\./,
    );
  });

  it("the property card names its states without a publication claim, and says where to check", () => {
    const src = flat(code(...PROPERTY_CARD));
    expect(src).toContain('in_feed: "Selected · in the feed this portal is offered"');
    expect(src).toContain("Whether it is published: {row.publicationCheck}");
    expect(src).toContain("it does not tell the CRM.");
  });

  it("the settings page says the portal does not report back", () => {
    expect(flat(code(...SETTINGS_PAGE))).toContain(
      "What the portal then publishes is its own decision, and it does not report back to the CRM.",
    );
  });
});

describe("the timeline's portal lines (messages/en.json)", () => {
  const en = JSON.parse(readFileSync(join(root, "messages", "en.json"), "utf-8")) as Record<string, unknown>;
  const events = en.events as Record<string, string>;

  it("a deselection is 'Deselected for portal', not 'Removed from portal'", () => {
    // deleting the portal_listings row takes the listing out of the FEED; what
    // the portal does with that is its own business, so nothing was "removed from" it
    expect(events.portalRemoved).toBe("Deselected for portal {portal}");
    // its pair, which the e2e reads on the Activity tab
    expect(events.portalSelected).toBe("Selected for portal {portal}");
  });

  it("no portal event line claims publication", () => {
    const portalLines = Object.entries(events).filter(([key]) => key.startsWith("portal"));
    expect(portalLines.length, "the portal event keys are where this test looks").toBeGreaterThanOrEqual(6);
    const offending = portalLines.filter(([, text]) => claimsIn(text).length > 0 || /removed from/i.test(text));
    expect(offending).toEqual([]);
  });
});

describe("a switched-off portal is never said to have listings in its feed", () => {
  it("the settings card words the disabled status line as a prediction, not a fact", () => {
    const src = code(...SETTINGS_CARD);
    // the enabled branch names "in the feed"; the disabled one says what WOULD be
    expect(src).toContain("would be in the feed");
    expect(src).toMatch(/enabled\s*\?\s*`\$\{summary\.selected\} selected/);
  });

  it("the property card names a selection that left the website apart from one to fix", () => {
    const src = code("components", "features", "properties", "portals-card.tsx");
    expect(src).toMatch(/off_site:\s*"Selected · not sent while the listing is off the website/);
    expect(src).toMatch(/row\.state === "off_site" \? null/);
  });
});
