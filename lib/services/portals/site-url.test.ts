import { afterEach, describe, expect, it, vi } from "vitest";
import { publicListingUrl, publicSiteOrigin } from "./site-url";

/**
 * A portal's "visit the agent's website" link (Kyero <url><en>). The CRM
 * emits one only when PUBLIC_SITE_URL tells it where the website is: a link
 * to a guessed address would be an invented fact on someone else's site.
 * Every case passes its env explicitly; the one test of the process.env
 * default — the feed route's call — stubs and restores it.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

const SITE = { PUBLIC_SITE_URL: "https://gnk-web.vercel.app" };

describe("publicSiteOrigin", () => {
  it("takes an absolute https origin, with or without a trailing slash", () => {
    expect(publicSiteOrigin(SITE)).toBe("https://gnk-web.vercel.app");
    expect(publicSiteOrigin({ PUBLIC_SITE_URL: " https://gnk-web.vercel.app/ " })).toBe("https://gnk-web.vercel.app");
  });

  it("is null when unset or blank", () => {
    expect(publicSiteOrigin({})).toBeNull();
    expect(publicSiteOrigin({ PUBLIC_SITE_URL: "" })).toBeNull();
    expect(publicSiteOrigin({ PUBLIC_SITE_URL: "   " })).toBeNull();
  });

  it("is null for anything that is not an absolute https origin", () => {
    for (const v of [
      "not a url",
      "gnk-web.vercel.app", // not absolute: the CRM does not guess the scheme of someone else's site
      "http://gnk-web.vercel.app",
      "http://localhost:3001",
      "https://gnk-web.vercel.app/en",
      "https://gnk-web.vercel.app?utm_source=kyero",
      "https://gnk-web.vercel.app/#listings",
      "https://user:pass@gnk-web.vercel.app",
    ]) {
      expect(publicSiteOrigin({ PUBLIC_SITE_URL: v }), v).toBeNull();
    }
  });
});

describe("publicListingUrl", () => {
  it("is gnk-web's listing route on the configured origin", () => {
    expect(publicListingUrl("PAF0001", SITE)).toBe("https://gnk-web.vercel.app/properties/PAF0001");
    expect(publicListingUrl("PAF0001", { PUBLIC_SITE_URL: "https://gnk-web.vercel.app/" })).toBe(
      "https://gnk-web.vercel.app/properties/PAF0001",
    );
  });

  it("percent-encodes the reference, so a slash or a space cannot change the path", () => {
    expect(publicListingUrl("PAF/0001", SITE)).toBe("https://gnk-web.vercel.app/properties/PAF%2F0001");
    expect(publicListingUrl("PAF 0001", SITE)).toBe("https://gnk-web.vercel.app/properties/PAF%200001");
    expect(publicListingUrl("../admin", SITE)).toBe("https://gnk-web.vercel.app/properties/..%2Fadmin");
    expect(publicListingUrl("A?b#c", SITE)).toBe("https://gnk-web.vercel.app/properties/A%3Fb%23c");
  });

  it("is null when the site's address is unset, invalid, http or carries a path", () => {
    for (const env of [
      {},
      { PUBLIC_SITE_URL: "not a url" },
      { PUBLIC_SITE_URL: "http://gnk-web.vercel.app" },
      { PUBLIC_SITE_URL: "https://gnk-web.vercel.app/en" },
    ]) {
      expect(publicListingUrl("PAF0001", env), JSON.stringify(env)).toBeNull();
    }
  });

  it("reads PUBLIC_SITE_URL from process.env when no env is passed — how the feed route calls it", () => {
    vi.stubEnv("PUBLIC_SITE_URL", "https://gnk-web.vercel.app");
    expect(publicListingUrl("PAF0001")).toBe("https://gnk-web.vercel.app/properties/PAF0001");
    vi.stubEnv("PUBLIC_SITE_URL", "");
    expect(publicListingUrl("PAF0001")).toBeNull();
  });
});
