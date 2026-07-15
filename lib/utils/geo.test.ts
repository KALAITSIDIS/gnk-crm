import { describe, expect, it } from "vitest";
import { parseLocationPoint, parseMapsCoords, toLocationEWKT } from "./geo";

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

  it("reads a bare 'lat, lng' string", () => {
    expect(parseMapsCoords("34.772, 32.4297")).toEqual({ lat: 34.772, lng: 32.4297 });
  });

  it("handles negative coordinates", () => {
    expect(parseMapsCoords("-33.8688, 151.2093")).toEqual({ lat: -33.8688, lng: 151.2093 });
  });

  it("rejects out-of-range or unparseable input", () => {
    expect(parseMapsCoords("hello world")).toBeNull();
    expect(parseMapsCoords("91.0, 200.0")).toBeNull();
    expect(parseMapsCoords("")).toBeNull();
  });
});
