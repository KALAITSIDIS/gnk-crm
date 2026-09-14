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
});
