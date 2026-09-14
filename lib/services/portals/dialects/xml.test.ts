import { describe, expect, it } from "vitest";
import { XML_HEADER, escapeXml, tag } from "./xml";

describe("xml builder", () => {
  it("escapes the five specials and nothing else", () => {
    expect(escapeXml(`a<b>&"c'd é`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;d é");
  });

  it("drops control characters XML 1.0 forbids", () => {
    expect(escapeXml("ok\u0000\u0008bad")).toBe("okbad");
  });

  it("renders a tag with escaped text and attributes", () => {
    expect(tag("desc", "1 < 2", { lang: 'en"x' })).toBe('<desc lang="en&quot;x">1 &lt; 2</desc>');
  });

  it("renders raw children when given an array", () => {
    expect(tag("images", [tag("url", "https://a/b.jpg")])).toBe(
      "<images><url>https://a/b.jpg</url></images>",
    );
  });

  it("omits a tag whose value is null or undefined", () => {
    expect(tag("beds", null)).toBe("");
    expect(tag("beds", undefined)).toBe("");
    expect(tag("beds", 0)).toBe("<beds>0</beds>");
  });

  it("header declares UTF-8", () => {
    expect(XML_HEADER).toBe('<?xml version="1.0" encoding="UTF-8"?>\n');
  });

  it("keeps tab, LF and CR — the only C0 characters XML allows", () => {
    expect(escapeXml("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("drops the non-characters and lone surrogate halves, keeps a proper pair", () => {
    expect(escapeXml("x\uFFFEy\uFFFFz")).toBe("xyz");
    expect(escapeXml("a\uD83Db")).toBe("ab");
    expect(escapeXml("a\uDE00b")).toBe("ab");
    expect(escapeXml("a\uD83D\uDE00b")).toBe("a\uD83D\uDE00b");
  });

  it("an empty scalar renders nothing; an empty container renders an empty element", () => {
    expect(tag("town", "")).toBe("");
    expect(tag("images", [])).toBe("<images></images>");
    expect(tag("surface_area", [tag("built", null), tag("plot", null)])).toBe("<surface_area></surface_area>");
  });

  it("drops null, undefined and empty children and keeps the rest in order", () => {
    expect(tag("surface_area", [tag("built", null), tag("plot", 1200), undefined, ""])).toBe(
      "<surface_area><plot>1200</plot></surface_area>",
    );
  });

  it("skips a null or undefined attribute and keeps the others", () => {
    expect(tag("image", "u", { id: null, n: 1, alt: undefined })).toBe('<image n="1">u</image>');
  });

  it("renders a decimal number as JavaScript prints it, unrounded", () => {
    expect(tag("latitude", 34.8821)).toBe("<latitude>34.8821</latitude>");
  });

  it("throws on a non-finite number instead of emitting it", () => {
    expect(() => tag("price", Number.NaN)).toThrow(/non-finite/);
    expect(() => tag("price", Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });

  it("a non-finite attribute throws like a non-finite element", () => {
    expect(() => tag("image", "u", { lat: Number.NaN })).toThrow(/non-finite/);
    expect(tag("image", "u", { alt: "" })).toBe('<image alt="">u</image>');
  });

  it("a whitespace-only scalar renders nothing; padded text is kept as is", () => {
    expect(tag("town", "   ")).toBe("");
    expect(tag("town", " Peyia ")).toBe("<town> Peyia </town>");
  });
});
