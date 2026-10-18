import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentKind, feedTokenIssuance, portalFeedOrigin, portalFeedUrl, type FeedEnv } from "./feed-origin";

/**
 * A feed URL is handed to a production portal and lives for years, so where
 * it points is decided from configuration, never from whatever host the page
 * happened to be served on (portal integrations audit 2026-10-18, finding 8).
 * Every case passes its env explicitly; the one test of the process.env
 * default stubs and restores it.
 */
const TOKEN = "ab".repeat(32);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("portalFeedOrigin", () => {
  it("NEXT_PUBLIC_APP_URL wins over Vercel's production domain", () => {
    expect(
      portalFeedOrigin({ NEXT_PUBLIC_APP_URL: "https://crm.example.com", VERCEL_PROJECT_PRODUCTION_URL: "gnk-crm.vercel.app" }),
    ).toBe("https://crm.example.com");
  });

  it("falls back to VERCEL_PROJECT_PRODUCTION_URL, a bare host Vercel sets, as https", () => {
    expect(portalFeedOrigin({ VERCEL_PROJECT_PRODUCTION_URL: "gnk-crm.vercel.app" })).toBe("https://gnk-crm.vercel.app");
  });

  it("falls back past an unusable NEXT_PUBLIC_APP_URL instead of trusting it", () => {
    expect(
      portalFeedOrigin({ NEXT_PUBLIC_APP_URL: "http://crm.example.com", VERCEL_PROJECT_PRODUCTION_URL: "gnk-crm.vercel.app" }),
    ).toBe("https://gnk-crm.vercel.app");
  });

  it("reduces a trailing slash and surrounding blanks to the origin", () => {
    expect(portalFeedOrigin({ NEXT_PUBLIC_APP_URL: "  https://crm.example.com/  " })).toBe("https://crm.example.com");
  });

  it("refuses plain http, except for localhost and 127.0.0.1", () => {
    expect(portalFeedOrigin({ NEXT_PUBLIC_APP_URL: "http://crm.example.com" })).toBeNull();
    expect(portalFeedOrigin({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
    expect(portalFeedOrigin({ NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000" })).toBe("http://127.0.0.1:3000");
    expect(portalFeedOrigin({ NEXT_PUBLIC_APP_URL: "ftp://crm.example.com" })).toBeNull();
  });

  it("refuses a value with a path, a query, a fragment or user info — it is not an origin", () => {
    for (const v of [
      "https://crm.example.com/app",
      "https://crm.example.com?env=prod",
      "https://crm.example.com/#top",
      "https://admin:secret@crm.example.com",
      "https://admin@crm.example.com",
    ]) {
      expect(portalFeedOrigin({ NEXT_PUBLIC_APP_URL: v }), v).toBeNull();
      expect(portalFeedOrigin({ VERCEL_PROJECT_PRODUCTION_URL: v }), v).toBeNull();
    }
  });

  it("is null when neither is set, or what is set is blank or not a URL", () => {
    expect(portalFeedOrigin({})).toBeNull();
    expect(portalFeedOrigin({ NEXT_PUBLIC_APP_URL: "", VERCEL_PROJECT_PRODUCTION_URL: "   " })).toBeNull();
    expect(portalFeedOrigin({ NEXT_PUBLIC_APP_URL: "not a url" })).toBeNull();
  });

  it("reads process.env when no env is passed — how the settings page and the actions call it", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.com");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "gnk-crm.vercel.app");
    expect(portalFeedOrigin()).toBe("https://crm.example.com");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(portalFeedOrigin()).toBe("https://gnk-crm.vercel.app");
  });
});

describe("portalFeedUrl", () => {
  it("builds the feed route's URL on the configured origin", () => {
    expect(portalFeedUrl("jamesedition", TOKEN, { NEXT_PUBLIC_APP_URL: "https://crm.example.com/" })).toBe(
      `https://crm.example.com/api/portals/jamesedition/${TOKEN}`,
    );
  });

  it("is null without a canonical origin — the card must not mint a URL to nowhere", () => {
    expect(portalFeedUrl("jamesedition", TOKEN, {})).toBeNull();
    expect(portalFeedUrl("jamesedition", TOKEN, { NEXT_PUBLIC_APP_URL: "http://crm.example.com" })).toBeNull();
  });
});

describe("feedTokenIssuance", () => {
  const ORIGIN: FeedEnv = { VERCEL_PROJECT_PRODUCTION_URL: "gnk-crm.vercel.app" };

  it("refuses on a preview and on Vercel's development environment, naming where URLs are issued", () => {
    for (const VERCEL_ENV of ["preview", "development"]) {
      const r = feedTokenIssuance({ ...ORIGIN, VERCEL_ENV });
      expect(r.allowed, VERCEL_ENV).toBe(false);
      expect(r.allowed === false && r.reason, VERCEL_ENV).toContain("(https://gnk-crm.vercel.app)");
      expect(r.allowed === false && r.reason, VERCEL_ENV).toMatch(/production CRM only/);
    }
  });

  it("refuses on a preview with no origin configured, without an empty pair of brackets", () => {
    const r = feedTokenIssuance({ VERCEL_ENV: "preview" });
    expect(r).toEqual({
      allowed: false,
      reason: "Feed URLs are issued on the production CRM only — this is a preview deployment.",
    });
  });

  it("allows production and a local `next dev` (VERCEL_ENV unset)", () => {
    expect(feedTokenIssuance({ ...ORIGIN, VERCEL_ENV: "production" })).toEqual({ allowed: true });
    expect(feedTokenIssuance(ORIGIN)).toEqual({ allowed: true });
    expect(feedTokenIssuance({})).toEqual({ allowed: true });
  });

  it("reads VERCEL_ENV from process.env when no env is passed — how lib/actions/portals.ts calls it", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(feedTokenIssuance().allowed).toBe(false);
    vi.stubEnv("VERCEL_ENV", "production");
    expect(feedTokenIssuance().allowed).toBe(true);
  });
});

describe("deploymentKind", () => {
  it("names production, preview (Vercel's development too) and local", () => {
    expect(deploymentKind({ VERCEL_ENV: "production" })).toBe("production");
    expect(deploymentKind({ VERCEL_ENV: "preview" })).toBe("preview");
    expect(deploymentKind({ VERCEL_ENV: "development" })).toBe("preview");
    expect(deploymentKind({})).toBe("local");
    expect(deploymentKind({ VERCEL_ENV: "staging" })).toBe("local");
  });
});
