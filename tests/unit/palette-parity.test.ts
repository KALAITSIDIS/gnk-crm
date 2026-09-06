import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Doc 06 promises "changing the palette must be a one-file edit" and then
 * prints the palette a second time. Two copies of one fact drift: the audit of
 * 2026-09-06 found `--text-3` at #98A2B3 — 2.58:1 on white, under 322 class
 * usages including error text — and the doc agreeing with it. This test reads
 * every hex token out of the doc's `:root` block and holds it to the CSS, and
 * holds the text tokens to WCAG AA (4.5:1) on both surfaces, so the next
 * palette change is one edit plus one doc line, and neither can quietly go
 * illegible again.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(root, "app", "globals.css"), "utf-8");
const doc = readFileSync(join(root, "docs", "06_UI_DESIGN_SYSTEM.md"), "utf-8");

/** `--name: #HEX` pairs inside the first `:root { ... }` block of a text. */
function rootTokens(text: string): Map<string, string> {
  const block = /:root\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? "";
  const out = new Map<string, string>();
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) {
    out.set(m[1], m[2].toUpperCase());
  }
  return out;
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2 contrast ratio, order-independent. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const cssTokens = rootTokens(css);
const docTokens = rootTokens(doc);

describe("the palette in doc 06 is the palette in globals.css", () => {
  it("the doc still prints a palette (the guard is not satisfiable by deleting it)", () => {
    expect(docTokens.size).toBeGreaterThanOrEqual(12);
    for (const name of ["brand-950", "brand-700", "surface", "surface-2", "text-1", "text-2", "text-3"]) {
      expect(docTokens.has(name), "doc 06 lost --" + name).toBe(true);
    }
  });

  it("every hex token the doc prints equals the CSS token of the same name", () => {
    const drift: string[] = [];
    for (const [name, docHex] of docTokens) {
      const cssHex = cssTokens.get(name);
      if (cssHex !== docHex) drift.push("--" + name + ": doc " + docHex + " vs css " + (cssHex ?? "(absent)"));
    }
    expect(drift, "doc 06 and app/globals.css disagree — the palette is a one-file edit plus this doc line").toEqual([]);
  });
});

describe("text tokens read on both surfaces (WCAG AA, 4.5:1)", () => {
  const surfaces = ["surface", "surface-2"] as const;
  const texts = ["text-1", "text-2", "text-3"] as const;

  for (const text of texts) {
    for (const surface of surfaces) {
      it("--" + text + " on --" + surface, () => {
        const ratio = contrast(cssTokens.get(text)!, cssTokens.get(surface)!);
        expect(ratio, "--" + text + " on --" + surface + " is " + ratio.toFixed(2) + ":1").toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
