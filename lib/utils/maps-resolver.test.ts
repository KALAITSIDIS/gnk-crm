import { describe, expect, it } from "vitest";
import { followMapsRedirects, type RedirectFetch } from "./maps-resolver";

/** Real redirect target shape of a maps.app.goo.gl share link (entry=tts). */
const TTS_TARGET =
  "https://www.google.com/maps/search/34.769295,+32.408508?entry=tts&g_ep=EgoyMDI2MDcxNS4wIPu8ASoASAFQAw%3D%3D";

const SHORT_LINK = "https://maps.app.goo.gl/K423ZaRLP2Kdbzzt8";

/** Build a stub fetch that replies with the given hops in order. */
function stubFetch(hops: Array<{ status: number; location?: string }>) {
  const calls: string[] = [];
  const impl: RedirectFetch = async (url) => {
    calls.push(url);
    const hop = hops[Math.min(calls.length - 1, hops.length - 1)];
    return {
      status: hop.status,
      headers: new Headers(hop.location ? { location: hop.location } : {}),
    };
  };
  return { impl, calls };
}

describe("followMapsRedirects", () => {
  it("resolves a maps.app.goo.gl short link from its redirect Location", async () => {
    const { impl, calls } = stubFetch([{ status: 302, location: TTS_TARGET }]);
    const pt = await followMapsRedirects(SHORT_LINK, impl);
    expect(pt).toEqual({ lat: 34.769295, lng: 32.408508 });
    expect(calls).toEqual([SHORT_LINK]);
  });

  it("unwraps a consent interstitial without fetching it", async () => {
    const { impl, calls } = stubFetch([
      { status: 302, location: `https://consent.google.com/m?continue=${encodeURIComponent(TTS_TARGET)}` },
    ]);
    const pt = await followMapsRedirects(SHORT_LINK, impl);
    expect(pt).toEqual({ lat: 34.769295, lng: 32.408508 });
    expect(calls).toHaveLength(1);
  });

  it("follows Google-host hops until coordinates appear", async () => {
    const { impl, calls } = stubFetch([
      { status: 302, location: "https://www.google.com/interstitial?x=1" },
      { status: 302, location: TTS_TARGET },
    ]);
    const pt = await followMapsRedirects(SHORT_LINK, impl);
    expect(pt).toEqual({ lat: 34.769295, lng: 32.408508 });
    expect(calls).toHaveLength(2);
  });

  it("resolves a relative Location against the current host", async () => {
    const { impl } = stubFetch([{ status: 302, location: "/maps/search/34.772,+32.4297" }]);
    const pt = await followMapsRedirects(SHORT_LINK, impl);
    expect(pt).toEqual({ lat: 34.772, lng: 32.4297 });
  });

  it("only ever fetches Google short-link hosts as the entry point", async () => {
    const { impl, calls } = stubFetch([{ status: 302, location: TTS_TARGET }]);
    expect(await followMapsRedirects("https://www.google.com/maps/place/Villa", impl)).toBeNull();
    expect(await followMapsRedirects("https://evil.example.com/x", impl)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("never fetches past a redirect that leaves Google hosts", async () => {
    const { impl, calls } = stubFetch([
      { status: 302, location: "https://evil.example.com/track" },
      { status: 302, location: TTS_TARGET },
    ]);
    const pt = await followMapsRedirects(SHORT_LINK, impl);
    expect(pt).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("stops on non-http(s) redirect schemes", async () => {
    const { impl, calls } = stubFetch([
      { status: 302, location: "comgooglemaps://?daddr=somewhere" },
    ]);
    expect(await followMapsRedirects(SHORT_LINK, impl)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("gives up after the hop limit on redirect loops", async () => {
    const { impl, calls } = stubFetch([{ status: 302, location: "https://goo.gl/loop" }]);
    expect(await followMapsRedirects(SHORT_LINK, impl)).toBeNull();
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("returns null on a terminal non-redirect response", async () => {
    const { impl } = stubFetch([{ status: 200 }]);
    expect(await followMapsRedirects(SHORT_LINK, impl)).toBeNull();
  });

  it("returns null when a redirect carries no Location header", async () => {
    const { impl } = stubFetch([{ status: 302 }]);
    expect(await followMapsRedirects(SHORT_LINK, impl)).toBeNull();
  });

  it("returns null when fetch rejects (network error or timeout)", async () => {
    const impl: RedirectFetch = async () => {
      throw new Error("network down");
    };
    expect(await followMapsRedirects(SHORT_LINK, impl)).toBeNull();
  });
});
