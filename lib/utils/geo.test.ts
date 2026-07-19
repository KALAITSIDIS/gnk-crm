import { describe, expect, it } from "vitest";
import {
  isGoogleMapsShortLink,
  parseLocationPoint,
  parseMapsCoords,
  toLocationEWKT,
} from "./geo";

describe("toLocationEWKT", () => {
  it("emits SRID 4326 with lng before lat (PostGIS axis order)", () => {
    expect(toLocationEWKT(34.772, 32.4297)).toBe("SRID=4326;POINT(32.4297 34.772)");
  });
});

describe("parseLocationPoint", () => {
  it("decodes the EWKB hex PostgREST returns for a geography point", () => {
    // Paphos-ish point written as SRID=4326;POINT(32.4297 34.772)
    const hex = "0101000020E6100000AC8BDB6800374040894160E5D0624140";
    const pt = parseLocationPoint(hex);
    expect(pt).not.toBeNull();
    expect(pt!.lng).toBeCloseTo(32.4297, 4);
    expect(pt!.lat).toBeCloseTo(34.772, 4);
  });

  it("round-trips with toLocationEWKT via the DB (shape only)", () => {
    const pt = parseLocationPoint("0101000020E6100000AC8BDB6800374040894160E5D0624140");
    expect(toLocationEWKT(pt!.lat, pt!.lng)).toMatch(/^SRID=4326;POINT\(/);
  });

  it("returns null for null, empty, or non-hex input", () => {
    expect(parseLocationPoint(null)).toBeNull();
    expect(parseLocationPoint("")).toBeNull();
    expect(parseLocationPoint("not-hex")).toBeNull();
    expect(parseLocationPoint(123)).toBeNull();
  });
});

describe("parseMapsCoords", () => {
  it("reads the @lat,lng segment of a Google Maps URL", () => {
    const pt = parseMapsCoords("https://www.google.com/maps/@34.772,32.4297,15z");
    expect(pt).toEqual({ lat: 34.772, lng: 32.4297 });
  });

  it("reads the !3d<lat>!4d<lng> place segment", () => {
    const pt = parseMapsCoords(
      "https://www.google.com/maps/place/Villa/data=!3d34.7720!4d32.4297",
    );
    expect(pt).toEqual({ lat: 34.772, lng: 32.4297 });
  });

  it("reads a q=lat,lng query param", () => {
    const pt = parseMapsCoords("https://maps.google.com/?q=34.772,32.4297");
    expect(pt).toEqual({ lat: 34.772, lng: 32.4297 });
  });

  it("reads a q=lat,+lng query param (share-sheet comma-plus form)", () => {
    const pt = parseMapsCoords("https://maps.google.com/?q=34.772,+32.4297");
    expect(pt).toEqual({ lat: 34.772, lng: 32.4297 });
  });

  it("reads the /maps/search/lat,+lng path a short link redirects to", () => {
    // Real redirect target of a maps.app.goo.gl share link (entry=tts).
    const pt = parseMapsCoords(
      "https://www.google.com/maps/search/34.769295,+32.408508?entry=tts&g_ep=EgoyMDI2MDcxNS4wIPu8ASoASAFQAw%3D%3D&skid=a1640aa3-ac21-44f8-b532-36fa32fd76e3",
    );
    expect(pt).toEqual({ lat: 34.769295, lng: 32.408508 });
  });

  it("reads a /maps/place/lat,lng path", () => {
    const pt = parseMapsCoords("https://www.google.com/maps/place/34.772,32.4297");
    expect(pt).toEqual({ lat: 34.772, lng: 32.4297 });
  });

  it("reads a /maps/dir//lat,lng destination path", () => {
    const pt = parseMapsCoords("https://www.google.com/maps/dir//34.772,32.4297");
    expect(pt).toEqual({ lat: 34.772, lng: 32.4297 });
  });

  it("reads percent-encoded coordinates (%2C comma)", () => {
    const pt = parseMapsCoords("https://www.google.com/maps/search/34.769295%2C32.408508");
    expect(pt).toEqual({ lat: 34.769295, lng: 32.408508 });
  });

  it("unwraps a consent-page continue= parameter", () => {
    const target = "https://www.google.com/maps/search/34.769295,+32.408508?entry=tts";
    const pt = parseMapsCoords(
      `https://consent.google.com/m?continue=${encodeURIComponent(target)}&gl=CY`,
    );
    expect(pt).toEqual({ lat: 34.769295, lng: 32.408508 });
  });

  it("reads a bare 'lat, lng' string", () => {
    expect(parseMapsCoords("34.772, 32.4297")).toEqual({ lat: 34.772, lng: 32.4297 });
  });

  it("handles negative coordinates", () => {
    expect(parseMapsCoords("-33.8688, 151.2093")).toEqual({ lat: -33.8688, lng: 151.2093 });
  });

  it("returns null for a short link itself (no coordinates in the URL)", () => {
    expect(parseMapsCoords("https://maps.app.goo.gl/K423ZaRLP2Kdbzzt8")).toBeNull();
  });

  it("does not invent coordinates from place names or street numbers", () => {
    expect(parseMapsCoords("https://www.google.com/maps/place/Villa+Coral+Bay")).toBeNull();
    expect(parseMapsCoords("https://www.google.com/maps/dir/34+Main+St,+Paphos/Villa")).toBeNull();
  });

  it("rejects out-of-range or unparseable input", () => {
    expect(parseMapsCoords("hello world")).toBeNull();
    expect(parseMapsCoords("91.0, 200.0")).toBeNull();
    expect(parseMapsCoords("")).toBeNull();
  });
});

describe("isGoogleMapsShortLink", () => {
  it("recognises maps.app.goo.gl share links", () => {
    expect(isGoogleMapsShortLink("https://maps.app.goo.gl/K423ZaRLP2Kdbzzt8")).toBe(true);
  });

  it("recognises legacy goo.gl and g.co and share.google links", () => {
    expect(isGoogleMapsShortLink("https://goo.gl/maps/AbCd12")).toBe(true);
    expect(isGoogleMapsShortLink("https://g.co/kgs/abc")).toBe(true);
    expect(isGoogleMapsShortLink("https://share.google/xyz")).toBe(true);
  });

  it("accepts a pasted link without a protocol", () => {
    expect(isGoogleMapsShortLink("maps.app.goo.gl/K423ZaRLP2Kdbzzt8")).toBe(true);
  });

  it("rejects full Google Maps URLs (no server round-trip needed)", () => {
    expect(isGoogleMapsShortLink("https://www.google.com/maps/@34.772,32.4297,15z")).toBe(false);
  });

  it("rejects lookalike and unrelated hosts", () => {
    expect(isGoogleMapsShortLink("https://maps.app.goo.gl.evil.com/x")).toBe(false);
    expect(isGoogleMapsShortLink("https://evil.com/maps.app.goo.gl")).toBe(false);
    expect(isGoogleMapsShortLink("hello world")).toBe(false);
    expect(isGoogleMapsShortLink("34.772, 32.4297")).toBe(false);
    expect(isGoogleMapsShortLink("")).toBe(false);
  });
});
