import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { PROPERTY_FEATURES } from "@/lib/constants/features";
import type { FeedListing, FeedRow } from "@/lib/services/portals/feed-listing";
import { PROPERTY_TYPES } from "@/lib/validators/properties";
import { kyero, KYERO_TYPES } from "./kyero";
import {
  ALL,
  img,
  KYERO_SETTINGS,
  LAND_PLOT,
  RENT_FLAT,
  SALE_OR_RENT,
  SALE_VILLA,
  SHOP_UNIT,
  siteUrl,
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

/** A fixture with some of its row (and optionally its listing fields) replaced. */
const variant = (l: FeedListing, row: Partial<FeedRow>, over: Partial<FeedListing> = {}): FeedListing => ({
  ...l,
  ...over,
  row: { ...l.row, ...row },
});

/** The one rendered property, parsed. */
const one = (l: FeedListing, settings: Record<string, string> = KYERO_SETTINGS) =>
  parse(kyero.render([l], settings)).root.property[0];

/** The features element's values for one listing, `[]` when the element is absent. */
const featuresOf = (features: string[]): string[] => {
  const p = one(variant(SALE_VILLA, { features }));
  return (p.features?.feature ?? []).map(String);
};

/**
 * The raw text of every occurrence of a leaf element. Read from the XML, not
 * the parsed tree: the parser turns "0035726000000" into a number and "1"
 * into 1, and the point of several tests is the exact characters Kyero gets.
 */
const raw = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))].map((m) => m[1]);

/**
 * Every problem with the document's LAYOUT: each line must be the XML header,
 * `<root>`/`</root>`, or exactly ONE element — a leaf `<x>value</x>`, an
 * opening tag or a closing tag — indented two spaces per level below the
 * root. Kyero's parser has a per-line character limit (kyero.ts LAYOUT), so a
 * line holding two siblings, or a value split by a raw line break, is a
 * defect even though the XML is well-formed.
 */
function layoutProblems(xml: string): string[] {
  const problems: string[] = [];
  const lines = xml.split("\n");
  if (lines[0] !== '<?xml version="1.0" encoding="UTF-8"?>') problems.push(`line 1 is not the header: ${lines[0]}`);
  if (lines[1] !== "<root>") problems.push(`line 2 is not <root>: ${lines[1]}`);
  if (lines.at(-2) !== "</root>" || lines.at(-1) !== "") problems.push("the document does not end with </root> and a newline");
  const stack: string[] = [];
  const ATTRS = String.raw`(?: [a-z_]+="[^"<>]*")*`;
  const LEAF = new RegExp(String.raw`^<([a-z_]+)${ATTRS}>([^<>\r\n]+)</\1>$`);
  const OPEN = new RegExp(String.raw`^<([a-z_]+)${ATTRS}>$`);
  const CLOSE = /^<\/([a-z_]+)>$/;
  lines.slice(2, -2).forEach((text, i) => {
    const at = `line ${i + 3}`;
    const body = text.trimStart();
    const indent = text.length - body.length;
    let m: RegExpExecArray | null;
    if ((m = LEAF.exec(body)) || (m = OPEN.exec(body))) {
      if (indent !== 2 * stack.length) problems.push(`${at} indented ${indent}, expected ${2 * stack.length}: ${text}`);
      if (!LEAF.test(body)) stack.push(m[1]);
    } else if ((m = CLOSE.exec(body))) {
      const open = stack.pop();
      if (open !== m[1]) problems.push(`${at} closes ${m[1]} but ${open ?? "nothing"} is open`);
      if (indent !== 2 * stack.length) problems.push(`${at} indented ${indent}, expected ${2 * stack.length}: ${text}`);
    } else {
      problems.push(`${at} is not exactly one element: ${JSON.stringify(text)}`);
    }
  });
  if (stack.length) problems.push(`unclosed at the end: ${stack.join(" > ")}`);
  return problems;
}

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

  it("a listing with an area but no district still carries town and province", () => {
    const areaOnly = variant(SALE_VILLA, { district: null });
    const p = one(areaOnly);
    expect(p.town).toBe("Peyia");
    expect(p.province).toBe("Peyia");
  });

  it("emits en and ru descriptions, never el (Kyero has no Greek node)", () => {
    // Updated for the one-element-per-line layout: was `toContain("<desc><en>")`.
    const xml = kyero.render([SALE_VILLA], KYERO_SETTINGS);
    expect(xml).toContain("  <desc>\n    <en>");
    expect(xml).toContain("    <ru>Отдельная вилла у моря.</ru>");
    expect(xml).not.toContain("<el>");
    expect(xml).not.toContain("Μονοκατοικία");
  });

  it("escapes the description", () => {
    const xml = kyero.render([SALE_VILLA], KYERO_SETTINGS);
    expect(xml).toContain("&lt;200 m from the coast&gt; &amp; pool");
  });

  it("land has a plot and no beds; the date is Kyero's format", () => {
    // The date now comes from the fixture's revision (09:20:00.5 → whole
    // seconds), no longer from updated_at (09:00:00) — see the <date> block.
    const p = one(LAND_PLOT);
    expect(p.surface_area.plot).toBe(1200);
    expect(p.surface_area.built).toBeUndefined();
    expect(p.beds).toBeUndefined();
    expect(p.date).toBe("2026-09-12 09:20:00");
  });

  it("all-blank features emit no features element; blanks among real ones are dropped", () => {
    expect(kyero.render([variant(SALE_VILLA, { features: ["  ", ""] })], KYERO_SETTINGS)).not.toContain("<features>");
    // Updated to the shape production stores: a key, not a label.
    expect(featuresOf(["private_pool", " "])).toEqual(["Private pool"]);
  });

  it("folds B+ to B and omits an energy class Kyero cannot express", () => {
    expect(one(SHOP_UNIT).energy_rating.consumption).toBe("B");
    const none = variant(SHOP_UNIT, { energy_class: "none" });
    expect(kyero.render([none], KYERO_SETTINGS)).not.toContain("<energy_rating>");
  });

  it("omits surface_area and images when there is nothing to put in them", () => {
    const bare = variant(SHOP_UNIT, { covered_area_sqm: null, plot_area_sqm: null }, { images: [] });
    const xml = kyero.render([bare], KYERO_SETTINGS);
    expect(xml).not.toContain("<surface_area>");
    expect(xml).not.toContain("<images>");
  });

  it("caps images at fifty, numbered from 1 in the order given", () => {
    const many = { ...SALE_VILLA, images: Array.from({ length: 60 }, (_, i) => img(i + 1)) };
    const images = one(many).images.image;
    expect(images).toHaveLength(50);
    expect(images[0]["@_id"]).toBe("1");
    expect(images[0].url).toBe(img(1).url);
    expect(images[49]["@_id"]).toBe("50");
    expect(images[49].url).toBe(img(50).url);
  });

  it("maps every CRM property type except mixed_use and other, and folds the commercial ones", () => {
    const UNMAPPED = new Set(["mixed_use", "other"]);
    for (const t of PROPERTY_TYPES) expect(Object.hasOwn(KYERO_TYPES, t), t).toBe(!UNMAPPED.has(t));
    for (const t of ["shop", "office", "warehouse"]) expect(KYERO_TYPES[t]).toBe("Commercial");
  });

  it("settings defaults apply: missing contact fields emit no nodes, and a malformed e-mail is refused", () => {
    const xml = kyero.render([SALE_VILLA], {});
    expect(xml).not.toContain("<contact_number>");
    expect(xml).not.toContain("<whatsapp_number>");
    expect(xml).not.toContain("<email>");
    expect(() => kyero.render([SALE_VILLA], { email: "nope" })).toThrow();
  });
});

describe("kyero layout — one element per line", () => {
  it("the whole fixture document is one element per line, indented by depth", () => {
    const xml = kyero.render(ALL, KYERO_SETTINGS);
    expect(layoutProblems(xml)).toEqual([]);
    // The literal form of the rule: no line holds two closing tags (two siblings, or a container closed on a child's line).
    for (const text of xml.split("\n")) expect(text.match(/<\//g)?.length ?? 0, text).toBeLessThanOrEqual(1);
  });

  it("the checker itself refuses the old single-line layout, so the test above can fail", () => {
    expect(layoutProblems('<?xml version="1.0" encoding="UTF-8"?>\n<root>\n<a><b>1</b><c>2</c></a>\n</root>\n')).not.toEqual([]);
    expect(layoutProblems('<?xml version="1.0" encoding="UTF-8"?>\n<root>\n<a>\n<b>1</b>\n</a>\n</root>\n')).toEqual([
      "line 4 indented 0, expected 2: <b>1</b>",
    ]);
    expect(layoutProblems('<?xml version="1.0" encoding="UTF-8"?>\n<root>\n<a>one\ntwo</a>\n</root>\n')).not.toEqual([]);
  });

  it("nests the containers as Kyero's sample feed does", () => {
    const xml = kyero.render([SALE_VILLA], KYERO_SETTINGS);
    expect(xml).toContain(
      [
        "  <location>",
        "    <latitude>34.8821</latitude>",
        "    <longitude>32.3789</longitude>",
        "  </location>",
      ].join("\n"),
    );
    expect(xml).toContain(
      [
        "  <images>",
        '    <image id="1">',
        `      <url>${img(1).url}</url>`,
        "    </image>",
      ].join("\n"),
    );
  });
});

describe("kyero features — keys go out as English words", () => {
  it("the stored keys become their labels", () => {
    expect(featuresOf(["private_pool", "sea_view"])).toEqual(["Private pool", "Sea view"]);
    const xml = kyero.render([SALE_VILLA], KYERO_SETTINGS);
    expect(xml).not.toContain("private_pool");
    expect(xml).not.toContain("sea_view");
  });

  it("every key the property form can store goes out as its label, in the stored order", () => {
    const keys = PROPERTY_FEATURES.map(([k]) => k);
    expect(featuresOf([...keys])).toEqual(PROPERTY_FEATURES.map(([, label]) => label));
  });

  it("deduplicates: a repeated key, and a key next to its own label (or a punctuated copy of it), go out once", () => {
    expect(featuresOf(["sea_view", "sea_view", "Sea view", "private_pool", "Private pool!"])).toEqual([
      "Sea view",
      "Private pool",
    ]);
  });

  it("an unknown key falls back to its words", () => {
    expect(featuresOf(["sauna_room", "24h_security"])).toEqual(["sauna room", "24h security"]);
  });

  it("strips punctuation, which Kyero forbids, and drops a feature that was nothing but punctuation", () => {
    expect(featuresOf(["pool/spa (heated)!", "—", "sea_view"])).toEqual(["pool spa heated", "Sea view"]);
    expect(kyero.render([variant(SALE_VILLA, { features: ["!!!", "—"] })], KYERO_SETTINGS)).not.toContain(
      "<features>",
    );
  });

  it("cuts a feature to 35 characters without leaving a trailing space", () => {
    const [cut, spaced] = featuresOf([
      "heated_infinity_pool_with_panoramic_sea_and_mountain_views",
      // the 35th character is a space: the cut must not end on it
      "abcdefghij_abcdefghij_abcdefghij_a_bcdef",
    ]);
    expect(cut).toBe("heated infinity pool with panoramic");
    expect(spaced).toBe("abcdefghij abcdefghij abcdefghij a");
  });

  it("sends at most fifty, the first fifty in stored order", () => {
    const out = featuresOf(Array.from({ length: 60 }, (_, i) => `amenity_${i}`));
    expect(out).toHaveLength(50);
    expect(out[0]).toBe("amenity 0");
    expect(out[49]).toBe("amenity 49");
  });

  it("whatever the input, every feature sent is ≤ 35 characters of letters, digits and single spaces", () => {
    const messy = [
      ...PROPERTY_FEATURES.map(([k]) => k),
      "pool/spa (heated)!",
      "  padded_key  ",
      "a__double__underscore",
      "x".repeat(80),
      "tab\tand\nnewline",
    ];
    for (const f of featuresOf(messy)) {
      expect(f.length, f).toBeLessThanOrEqual(35);
      expect(f, f).toMatch(/^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u);
    }
  });
});

describe("kyero <pool>", () => {
  const poolOf = (features: string[]) => raw(kyero.render([variant(SALE_VILLA, { features })], KYERO_SETTINGS), "pool");

  it("is 1 for a private pool and for a communal pool", () => {
    expect(poolOf(["private_pool"])).toEqual(["1"]);
    expect(poolOf(["communal_pool"])).toEqual(["1"]);
    expect(poolOf(["private_pool", "communal_pool"])).toEqual(["1"]);
  });

  it("is 1 for the plain word the importer's own template writes (docs/samples/properties_import.csv: pool;garden;…)", () => {
    expect(poolOf(["pool", "garden"])).toEqual(["1"]);
    expect(poolOf([" Pool "])).toEqual(["1"]);
  });

  it("is absent — never 0 — when no feature says pool; a key that only contains the word is not a pool", () => {
    expect(poolOf([])).toEqual([]);
    expect(poolOf(["sea_view", "garden"])).toEqual([]);
    expect(poolOf(["pool_table"])).toEqual([]);
    expect(kyero.render(ALL, KYERO_SETTINGS)).not.toContain("<pool>0</pool>");
  });
});

describe("kyero <new_build>", () => {
  const newBuildOf = (row: Partial<FeedRow>): string | null => {
    const found = raw(kyero.render([variant(SALE_VILLA, row)], KYERO_SETTINGS), "new_build");
    expect(found.length).toBeLessThanOrEqual(1);
    return found[0] ?? null;
  };
  const SALE = { transaction_type: "sale", property_type: "villa", construction_status: null } as const;

  // Pinned to kyero.ts newBuild as it stands: the site's own wording (vatLabel)
  // is the limit of what the feed may claim.
  it.each<[string, Partial<FeedRow>, string | null]>([
    ["a declared new build (new_vat)", { ...SALE, vat_status: "new_vat", year_built: 2025 }, "1"],
    ["a declared resale (resale_no_vat)", { ...SALE, vat_status: "resale_no_vat" }, "0"],
    ["sale-or-rent goes out as a sale", { ...SALE, transaction_type: "sale_or_rent", vat_status: "new_vat" }, "1"],
    ["reduced_rate_eligible, built (a claim about the buyer)", { ...SALE, vat_status: "reduced_rate_eligible" }, null],
    ["unknown VAT, no construction stage", { ...SALE, vat_status: "unknown" }, null],
    [
      "unknown VAT, under construction, no build year",
      { ...SALE, vat_status: "unknown", construction_status: "under_construction", year_built: null },
      "1",
    ],
    [
      "unknown VAT, planning stage, no build year",
      { ...SALE, vat_status: "unknown", construction_status: "planning", year_built: null },
      "1",
    ],
    [
      "unknown VAT, a stale off-plan stage on a villa with a build year",
      { ...SALE, vat_status: "unknown", construction_status: "under_construction", year_built: 2016 },
      null,
    ],
    [
      "unknown VAT, completed, no build year",
      { ...SALE, vat_status: "unknown", construction_status: "completed", year_built: null },
      null,
    ],
    [
      "reduced_rate_eligible while still off-plan",
      { ...SALE, vat_status: "reduced_rate_eligible", construction_status: "finishing", year_built: null },
      "1",
    ],
    [
      "a declared resale wins over an off-plan stage",
      { ...SALE, vat_status: "resale_no_vat", construction_status: "under_construction", year_built: null },
      "0",
    ],
    ["a rental, even declared new_vat", { ...SALE, transaction_type: "rent", rent_price_month: 1400, vat_status: "new_vat" }, null],
    [
      "a rental still off-plan",
      {
        ...SALE,
        transaction_type: "rent",
        rent_price_month: 1400,
        vat_status: "unknown",
        construction_status: "under_construction",
        year_built: null,
      },
      null,
    ],
    ["land, even declared new_vat (no dwelling)", { ...SALE, property_type: "land", vat_status: "new_vat" }, null],
    ["land declared resale", { ...SALE, property_type: "land", vat_status: "resale_no_vat" }, null],
  ])("%s → %s", (_label, row, expected) => {
    expect(newBuildOf(row)).toBe(expected);
  });
});

describe("kyero <url>", () => {
  it("links the listing's page on the website when the site's address is known", () => {
    const p = one(SALE_VILLA);
    expect(p.url).toEqual({ en: siteUrl("PAF0001") });
    expect(kyero.render([SALE_VILLA], KYERO_SETTINGS)).toContain(
      `  <url>\n    <en>${siteUrl("PAF0001")}</en>\n  </url>`,
    );
  });

  it("emits no <url> at all when there is none (an image's own <url> is not it)", () => {
    const p = one({ ...SALE_VILLA, url: null });
    expect(p.url).toBeUndefined();
    expect(p.images.image[0].url).toBe(img(1).url);
    expect(kyero.render([{ ...SALE_VILLA, url: null }], KYERO_SETTINGS)).not.toContain("<en>https://www.example.com");
  });
});

describe("kyero contact numbers — 00 and the country code, digits only", () => {
  it("rewrites the form's + numbers to the 00 form", () => {
    const xml = kyero.render([SALE_VILLA], KYERO_SETTINGS);
    expect(raw(xml, "contact_number")).toEqual(["0035726000000"]);
    expect(raw(xml, "whatsapp_number")).toEqual(["0035799000000"]);
    expect(xml).not.toContain("+357");
  });

  it("drops separators and keeps a number already written with 00", () => {
    const xml = kyero.render([SALE_VILLA], {
      ...KYERO_SETTINGS,
      contact_number: "(+357) 26-000-000",
      whatsapp_number: "00357 99 000 000",
    });
    expect(raw(xml, "contact_number")).toEqual(["0035726000000"]);
    expect(raw(xml, "whatsapp_number")).toEqual(["0035799000000"]);
  });

  it("omits a number that does not convert, rather than sending it without a country code", () => {
    const xml = kyero.render([SALE_VILLA], { ...KYERO_SETTINGS, contact_number: "26 000000", whatsapp_number: "+357 abc" });
    expect(xml).not.toContain("<contact_number>");
    expect(xml).not.toContain("<whatsapp_number>");
    expect(raw(xml, "email")).toEqual(["sales@example.com"]);
  });
});

describe("kyero text values — no raw line break inside an element", () => {
  it("a description's line break goes out as &#13;", () => {
    const xml = kyero.render([RENT_FLAT], KYERO_SETTINGS);
    expect(xml).toContain("    <en>Furnished, second floor, lift.&#13;Communal pool and covered parking.</en>");
  });

  it("CRLF, CR and LF each become ONE &#13;, in every description language, after escaping", () => {
    const multi = variant(SALE_VILLA, {
      public_description: { en: "One & two\r\nThree\rFour\nFive", ru: "Один\nДва" },
    });
    const xml = kyero.render([multi], KYERO_SETTINGS);
    expect(raw(xml, "en")).toContain("One &amp; two&#13;Three&#13;Four&#13;Five");
    expect(raw(xml, "ru")).toEqual(["Один&#13;Два"]);
    expect(xml).not.toContain("&amp;#13;");
    expect(layoutProblems(xml)).toEqual([]);
  });

  it("every other text folds its line breaks to a space", () => {
    const xml = kyero.render(
      // textIn trims the ends, so the breaks sit INSIDE the values
      [variant(SALE_VILLA, { area: { en: "Kato\nPaphos" }, district: { en: "Paphos\r\n\r\nDistrict" } })],
      KYERO_SETTINGS,
    );
    expect(raw(xml, "town")).toEqual(["Kato Paphos"]);
    expect(raw(xml, "province")).toEqual(["Paphos District"]);
    expect(layoutProblems(xml)).toEqual([]);
  });

  it("no element value anywhere in the fixture document holds a raw CR or LF", () => {
    const xml = kyero.render(ALL, KYERO_SETTINGS);
    for (const [, value] of xml.matchAll(/>([^<]*)</g)) {
      // whitespace-only runs between tags are layout, not values
      if (value.trim()) expect(value, value).not.toMatch(/[\r\n]/);
    }
  });
});

describe("kyero <location>", () => {
  it("rounds coordinates to six decimals", () => {
    const precise = { ...SALE_VILLA, coords: { lat: 34.88213456789, lng: 32.37891249, approx: false } };
    const xml = kyero.render([precise], KYERO_SETTINGS);
    expect(raw(xml, "latitude")).toEqual(["34.882135"]);
    expect(raw(xml, "longitude")).toEqual(["32.378912"]);
  });

  it("keeps a coordinate that already has fewer decimals as it is", () => {
    const xml = kyero.render([SALE_OR_RENT], KYERO_SETTINGS);
    expect(raw(xml, "latitude")).toEqual(["34.77"]);
    expect(raw(xml, "longitude")).toEqual(["32.43"]);
  });

  it("an approximate location never emits <location>, in the document or the fingerprint", () => {
    expect(one(SALE_VILLA).location.latitude).toBe(34.8821);
    expect(one(RENT_FLAT).location).toBeUndefined();
    expect(kyero.render([RENT_FLAT], KYERO_SETTINGS)).not.toContain("<location>");
    expect(kyero.fingerprint(RENT_FLAT, KYERO_SETTINGS)).not.toContain("<location>");
    expect(kyero.render([LAND_PLOT], KYERO_SETTINGS)).not.toContain("<location>");
  });
});

describe("kyero <date>", () => {
  it("is the export revision when the assembler synced one", () => {
    expect(one(SALE_VILLA).date).toBe("2026-09-10 08:41:02");
  });

  it("falls back to the row's updated_at when there is no revision", () => {
    expect(one({ ...SALE_VILLA, revisionAt: null }).date).toBe("2026-09-10 08:30:15");
  });

  it("follows the revision even when updated_at is NEWER (an edit the portal does not receive)", () => {
    expect(SHOP_UNIT.revisionAt! < SHOP_UNIT.row.updated_at).toBe(true);
    expect(one(SHOP_UNIT).date).toBe("2026-09-02 07:30:00");
  });

  it("is written in UTC whatever offset the revision carries", () => {
    expect(one({ ...SALE_VILLA, revisionAt: "2026-09-14T10:05:09+03:00" }).date).toBe("2026-09-14 07:05:09");
  });

  // Kyero updates a listing only when its date changes; "Invalid Date" or an
  // empty node would be a date it cannot compare. The assembler turns the
  // throw into a render_failed refusal (feed.ts), never a served document.
  it("refuses an unreadable date instead of emitting one", () => {
    expect(() => kyero.render([{ ...SALE_VILLA, revisionAt: "not a date" }], KYERO_SETTINGS)).toThrow();
    expect(() => kyero.render([variant(SALE_VILLA, { updated_at: "soon" }, { revisionAt: null })], KYERO_SETTINGS)).toThrow();
  });
});

describe("kyero fingerprint — the listing as the portal receives it, minus its date", () => {
  const fp = (l: FeedListing, settings: Record<string, string> = KYERO_SETTINGS) => kyero.fingerprint(l, settings);

  it("contains no <date>, neither the revision's nor the row's", () => {
    const f = fp(SALE_VILLA);
    expect(f).not.toContain("<date>");
    expect(f).not.toContain("2026-09-10 08:41:02");
    expect(f).not.toContain("2026-09-10 08:30:15");
  });

  it("is the rendered property with its date line removed, byte for byte", () => {
    for (const l of ALL) {
      const rendered = kyero
        .render([l], KYERO_SETTINGS)
        .split("\n")
        .filter((text) => !text.startsWith("  <date>"))
        .join("\n");
      expect(rendered).toContain(`\n${fp(l)}\n`);
    }
  });

  it("is byte-identical across calls and across equal copies", () => {
    expect(fp(SALE_VILLA)).toBe(fp(SALE_VILLA));
    expect(fp(structuredClone(SALE_VILLA))).toBe(fp(SALE_VILLA));
  });

  it.each<[string, FeedListing]>([
    ["only the revision moves", { ...SALE_VILLA, revisionAt: "2026-10-01T00:00:00+00:00" }],
    ["the revision is not synced yet", { ...SALE_VILLA, revisionAt: null }],
    ["only the row's updated_at moves", variant(SALE_VILLA, { updated_at: "2026-10-01T00:00:00+00:00" })],
    ["only the Greek text moves (Kyero has no Greek node)", variant(SALE_VILLA, { public_description: { ...(SALE_VILLA.row.public_description as object), el: "Άλλο κείμενο." } })],
    ["only a photo's measured size moves", { ...SALE_VILLA, images: [img(1, 4000, 3000), img(2)] }],
  ])("does NOT change when %s", (_label, changed) => {
    expect(fp(changed)).toBe(fp(SALE_VILLA));
  });

  it.each<[string, FeedListing, Record<string, string>]>([
    ["the images are reordered", { ...SALE_VILLA, images: [img(2), img(1)] }, KYERO_SETTINGS],
    ["a photo is added", { ...SALE_VILLA, images: [img(1), img(2), img(3)] }, KYERO_SETTINGS],
    ["the contact number in the settings changes", SALE_VILLA, { ...KYERO_SETTINGS, contact_number: "+357 26 111111" }],
    ["the WhatsApp number in the settings changes", SALE_VILLA, { ...KYERO_SETTINGS, whatsapp_number: "+357 99 111111" }],
    ["the e-mail in the settings changes", SALE_VILLA, { ...KYERO_SETTINGS, email: "desk@example.com" }],
    ["the url changes", { ...SALE_VILLA, url: "https://www.example.org/properties/PAF0001" }, KYERO_SETTINGS],
    ["the url goes away", { ...SALE_VILLA, url: null }, KYERO_SETTINGS],
    ["the price changes", variant(SALE_VILLA, { asking_price: 640000 }), KYERO_SETTINGS],
    ["a feature is added", variant(SALE_VILLA, { features: ["private_pool", "sea_view", "garden"] }), KYERO_SETTINGS],
    ["the location turns approximate", { ...SALE_VILLA, coords: { ...SALE_VILLA.coords!, approx: true } }, KYERO_SETTINGS],
    ["the English description changes", variant(SALE_VILLA, { public_description: { en: "New text." } }), KYERO_SETTINGS],
  ])("changes when %s", (_label, changed, settings) => {
    expect(fp(changed, settings)).not.toBe(fp(SALE_VILLA));
  });
});

describe("kyero empty document", () => {
  it("is well-formed, holds no property and keeps the v3 header", () => {
    const xml = kyero.empty();
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).not.toContain("<property>");
    expect(parse(xml).root.kyero.feed_version).toBe(3);
    expect(layoutProblems(xml)).toEqual([]);
  });

  it("is exactly the header and an empty root", () => {
    // Updated for the one-element-per-line layout: the header was
    // `<kyero><feed_version>3</feed_version></kyero>` on one line.
    expect(kyero.empty()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n<kyero>\n  <feed_version>3</feed_version>\n</kyero>\n</root>\n',
    );
  });

  it("starts exactly as a full document does, so a portal sees the same header either way", () => {
    const head = kyero.empty().replace(/<\/root>\n$/, "");
    expect(kyero.render([SALE_VILLA], KYERO_SETTINGS).startsWith(head)).toBe(true);
  });
});
