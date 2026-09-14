import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { PROPERTY_TYPES } from "@/lib/validators/properties";
import { kyero, KYERO_TYPES } from "./kyero";
import {
  ALL,
  KYERO_SETTINGS,
  LAND_PLOT,
  RENT_FLAT,
  SALE_OR_RENT,
  SALE_VILLA,
  SHOP_UNIT,
} from "./__fixtures__/listings";

const GOLDEN = join(import.meta.dirname, "__fixtures__", "kyero.golden.xml");

/** `UPDATE_GOLDEN=1 npx vitest run …kyero.test.ts` rewrites the golden. Read the diff before committing it. */
function golden(actual: string): string {
  if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, actual);
  if (!existsSync(GOLDEN)) throw new Error(`missing ${GOLDEN} — run with UPDATE_GOLDEN=1 and read the diff`);
  return readFileSync(GOLDEN, "utf8");
}

const parse = (xml: string) =>
  new XMLParser({
    ignoreAttributes: false,
    isArray: (name) => name === "property" || name === "image" || name === "feature",
  }).parse(xml);

describe("kyero dialect", () => {
  it("renders the golden document byte for byte", () => {
    const xml = kyero.render(ALL, KYERO_SETTINGS);
    expect(xml).toBe(golden(xml));
  });

  it("is well-formed XML with the v3 header", () => {
    const xml = kyero.render(ALL, KYERO_SETTINGS);
    expect(XMLValidator.validate(xml)).toBe(true);
    const doc = parse(xml);
    expect(doc.root.kyero.feed_version).toBe(3);
    expect(doc.root.property).toHaveLength(5);
  });

  it("every property carries the mandatory Kyero nodes", () => {
    const doc = parse(kyero.render(ALL, KYERO_SETTINGS));
    for (const p of doc.root.property) {
      for (const k of [
        "id",
        "date",
        "ref",
        "price",
        "currency",
        "price_freq",
        "type",
        "town",
        "province",
        "country",
        "desc",
      ]) {
        expect(p, `${p.ref} lacks ${k}`).toHaveProperty(k);
      }
      expect(p.country).toBe("Cyprus");
    }
  });

  it("a sale carries price_freq=sale and the asking price; a rent carries month and the monthly rent", () => {
    const doc = parse(kyero.render([SALE_VILLA, RENT_FLAT], KYERO_SETTINGS));
    const [sale, rent] = doc.root.property;
    expect(sale.price_freq).toBe("sale");
    expect(sale.price).toBe(650000);
    expect(rent.price_freq).toBe("month");
    expect(rent.price).toBe(1400);
  });

  it("sale-or-rent goes out once, as a sale", () => {
    const doc = parse(kyero.render([SALE_OR_RENT], KYERO_SETTINGS));
    expect(doc.root.property).toHaveLength(1);
    expect(doc.root.property[0].price_freq).toBe("sale");
    expect(doc.root.property[0].price).toBe(320000);
  });

  it("an approximate location is never emitted as coordinates", () => {
    const doc = parse(kyero.render([SALE_VILLA, RENT_FLAT], KYERO_SETTINGS));
    const [exact, approx] = doc.root.property;
    expect(exact.location.latitude).toBe(34.8821);
    expect(approx.location).toBeUndefined();
  });

  it("a listing with an area but no district still carries town and province", () => {
    const areaOnly = { ...SALE_VILLA, row: { ...SALE_VILLA.row, district: null } };
    const p = parse(kyero.render([areaOnly], KYERO_SETTINGS)).root.property[0];
    expect(p.town).toBe("Peyia");
    expect(p.province).toBe("Peyia");
  });

  it("emits en and ru descriptions, never el (Kyero has no Greek node)", () => {
    const xml = kyero.render([SALE_VILLA], KYERO_SETTINGS);
    expect(xml).toContain("<desc><en>");
    expect(xml).toContain("<ru>");
    expect(xml).not.toContain("<el>");
  });

  it("escapes the description", () => {
    const xml = kyero.render([SALE_VILLA], KYERO_SETTINGS);
    expect(xml).toContain("&lt;200 m from the coast&gt; &amp; pool");
  });

  it("land has a plot and no beds; the date is Kyero's format", () => {
    const doc = parse(kyero.render([LAND_PLOT], KYERO_SETTINGS));
    const p = doc.root.property[0];
    expect(p.surface_area.plot).toBe(1200);
    expect(p.surface_area.built).toBeUndefined();
    expect(p.beds).toBeUndefined();
    expect(p.date).toBe("2026-09-12 09:00:00");
  });

  it("all-blank features emit no features element; blanks among real ones are dropped", () => {
    const blank = { ...SALE_VILLA, row: { ...SALE_VILLA.row, features: ["  ", ""] } };
    expect(kyero.render([blank], KYERO_SETTINGS)).not.toContain("<features>");
    const mixed = { ...SALE_VILLA, row: { ...SALE_VILLA.row, features: ["Private pool", " "] } };
    const doc = parse(kyero.render([mixed], KYERO_SETTINGS));
    expect(doc.root.property[0].features.feature).toEqual(["Private pool"]);
  });

  it("folds B+ to B and omits an energy class Kyero cannot express", () => {
    const doc = parse(kyero.render([SHOP_UNIT], KYERO_SETTINGS));
    expect(doc.root.property[0].energy_rating.consumption).toBe("B");
    const none = { ...SHOP_UNIT, row: { ...SHOP_UNIT.row, energy_class: "none" } };
    expect(kyero.render([none], KYERO_SETTINGS)).not.toContain("<energy_rating>");
  });

  it("omits surface_area and images when there is nothing to put in them", () => {
    const bare = { ...SHOP_UNIT, row: { ...SHOP_UNIT.row, covered_area_sqm: null, plot_area_sqm: null }, images: [] };
    const xml = kyero.render([bare], KYERO_SETTINGS);
    expect(xml).not.toContain("<surface_area>");
    expect(xml).not.toContain("<images>");
  });

  it("caps images at fifty", () => {
    const many = {
      ...SALE_VILLA,
      images: Array.from({ length: 60 }, (_, i) => ({ url: `https://x/${i}.jpg`, alt: null })),
    };
    const doc = parse(kyero.render([many], KYERO_SETTINGS));
    expect(doc.root.property[0].images.image).toHaveLength(50);
  });

  it("the empty document is well-formed and holds no property", () => {
    expect(XMLValidator.validate(kyero.empty())).toBe(true);
    expect(kyero.empty()).not.toContain("<property>");
  });

  it("the empty document is exactly the header and an empty root", () => {
    expect(kyero.empty()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n<kyero><feed_version>3</feed_version></kyero>\n</root>\n',
    );
  });

  it("maps every CRM property type except mixed_use and other, and folds the commercial ones", () => {
    const UNMAPPED = new Set(["mixed_use", "other"]);
    for (const t of PROPERTY_TYPES) expect(Object.hasOwn(KYERO_TYPES, t), t).toBe(!UNMAPPED.has(t));
    for (const t of ["shop", "office", "warehouse"]) expect(KYERO_TYPES[t]).toBe("Commercial");
  });

  it("settings defaults apply: missing contact fields emit no nodes, and a malformed e-mail is refused", () => {
    const xml = kyero.render([SALE_VILLA], {});
    expect(xml).not.toContain("<contact_number>");
    expect(xml).not.toContain("<email>");
    expect(() => kyero.render([SALE_VILLA], { email: "nope" })).toThrow();
  });
});
