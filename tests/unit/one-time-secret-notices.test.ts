import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// the components' actions, outside a Next app: rendering must need none of them
vi.mock("@/lib/actions/settings", () => ({
  inviteUser: vi.fn(),
  resetUserTwoFactor: vi.fn(),
  setUserActive: vi.fn(),
  setUserRole: vi.fn(),
}));
vi.mock("@/lib/actions/portals", () => ({
  regeneratePortalToken: vi.fn(),
  savePortalSettings: vi.fn(),
  setPortalEnabled: vi.fn(),
}));

const { InviteCredentials } = await import("@/components/features/settings/users-panel");
const { IssuedFeedUrl } = await import("@/components/features/settings/portal-card");
const { MintedLink } = await import("@/components/features/share-links/minted-link");

/**
 * Where a one-time secret's notice is shown (T-one-time-secrets).
 *
 * The actions now hand back the secret WITH a notice when its timeline line
 * could not be written (or, for an invite and a link, when a step after the
 * secret could not be confirmed). A notice that renders somewhere the person
 * is not looking is the same as none, so it is pinned BESIDE the secret:
 *   - the invite dialog's credentials branch — `state.error` renders only in
 *     the form branch, so the notice has its own place there;
 *   - the feed URL on the portal card, and the minted link on both pages that
 *     mint one, each with a toast as well (the source guards below).
 * Rendered the way the server renders them (upload-form-labels.test.ts is the
 * precedent): the presentational pieces are exported so they can be.
 */
const markup = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(element)
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const NOTICE = "Saved — but the change could not be recorded in the timeline. Tell an admin so the record can be completed.";
/** the notice as the house renders one: a polite live region in the warning colour */
const NOTICE_ELEMENT = /<p role="status" class="[^"]*text-warning[^"]*"[^>]*>Saved — but the change could not be recorded in the timeline\. Tell an admin so the record can be completed\.<\/p>/;
const noop = () => {};

describe("the invite dialog's credentials branch", () => {
  const props = { email: "new.agent@example.com", password: "Zq3-x_Y9aBcD", onDone: noop };

  it("shows the notice beside the password, between it and the buttons", () => {
    const html = markup(createElement(InviteCredentials, { ...props, notice: NOTICE }));
    expect(html).toMatch(NOTICE_ELEMENT);
    const password = html.indexOf(props.password);
    const notice = html.search(NOTICE_ELEMENT);
    const copy = html.indexOf("Copy credentials");
    expect(password, "the password is shown").toBeGreaterThan(-1);
    expect(notice, "after the password").toBeGreaterThan(password);
    expect(notice, "before the buttons that end the flow").toBeLessThan(copy);
  });

  it("shows no notice when there is none", () => {
    const html = markup(createElement(InviteCredentials, { ...props, notice: null }));
    expect(html).toContain(props.password);
    expect(html).not.toContain('role="status"');
  });
});

describe("the minted link (both share-link pages)", () => {
  it("shows the notice right after the link it is about", () => {
    const html = markup(createElement(MintedLink, { path: "/p/abc", heading: "Proposal link ready", onDone: noop, notice: NOTICE }));
    expect(html).toMatch(NOTICE_ELEMENT);
    const url = html.indexOf('value="/p/abc"');
    expect(url).toBeGreaterThan(-1);
    expect(html.search(NOTICE_ELEMENT), "after the link's field").toBeGreaterThan(url);
  });

  it("shows no notice when there is none", () => {
    const html = markup(createElement(MintedLink, { path: "/p/abc", onDone: noop }));
    expect(html).not.toContain('role="status"');
  });
});

describe("the portal card's issued feed URL", () => {
  const props = {
    portalId: "jamesedition",
    url: "https://crm.example/api/portals/jamesedition/" + "a".repeat(64),
    rotating: false,
    onRegenerate: noop,
  };

  it("shows the notice right after the URL it is about", () => {
    const html = markup(createElement(IssuedFeedUrl, { ...props, notice: NOTICE }));
    expect(html).toMatch(NOTICE_ELEMENT);
    const url = html.indexOf(`value="${props.url}"`);
    expect(url).toBeGreaterThan(-1);
    expect(html.search(NOTICE_ELEMENT), "after the URL's field").toBeGreaterThan(url);
    expect(html, "the shown-once warning still stands").toContain('data-testid="portal-feed-url-once-jamesedition"');
  });

  it("shows no notice when there is none", () => {
    const html = markup(createElement(IssuedFeedUrl, { ...props, notice: null }));
    expect(html).toContain(`value="${props.url}"`);
    expect(html).not.toContain('role="status"');
  });
});

/* ------------------------------------------------------------------ */
/* The wiring: each caller passes the action's notice to the piece     */
/* above and toasts it. Read as source, comments stripped.             */
/* ------------------------------------------------------------------ */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const code = (...parts: string[]) =>
  readFileSync(join(root, ...parts), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const count = (src: string, re: RegExp) => (src.match(new RegExp(re.source, "g")) ?? []).length;
/** One JSX element, from its name to its `/>`: props hold arrows (`=>`) but never `/>`. */
const tagOf = (src: string, name: string) => {
  const tags = src.match(new RegExp(String.raw`<${name}\b[\s\S]*?\/>`, "g")) ?? [];
  expect(tags, `exactly one <${name}>`).toHaveLength(1);
  return tags[0]!;
};

describe("the callers hand the notice on", () => {
  it("InviteFlow passes the action's notice into the credentials branch", () => {
    const src = code("components", "features", "settings", "users-panel.tsx");
    expect(tagOf(src, "InviteCredentials")).toContain("notice={state.notice}");
  });

  it.each([
    ["share-links", "share-links-client.tsx"],
    ["properties", "availability-share.tsx"],
  ])("%s/%s shows the notice beside the minted link and toasts it", (dir, file) => {
    const src = code("components", "features", dir, file);
    expect(tagOf(src, "MintedLink")).toContain("notice={minted.notice}");
    expect(src).toMatch(/setMinted\(\{\s*path:\s*res\.path,\s*notice:\s*res\.notice\s*\}\)/);
    expect(src).toMatch(/if \(res\.notice\) toast\.warning\(res\.notice\)/);
  });

  it("the portal card shows the notice beside the URL and toasts it from both the switch and Regenerate", () => {
    const src = code("components", "features", "settings", "portal-card.tsx");
    expect(tagOf(src, "IssuedFeedUrl")).toContain("notice={issued.notice}");
    expect(count(src, /setIssued\(\{\s*token:\s*r\.token,\s*notice:\s*r\.notice \?\? null\s*\}\)/), "the switch and Regenerate").toBe(2);
    expect(count(src, /if \(r\.notice\) toast\.warning\(r\.notice\)/), "the switch and Regenerate").toBe(2);
  });
});
