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
 *
 * A08 (2026-10-18) widened "text tokens" from the three greys to every token
 * the app sets as text: `--warning` (#B7791F) measured 3.64:1 under the
 * Reserved / Under offer / Contacted badges, and VIP was set in
 * `--accent-500` (3.09:1). It also measures the keyboard-focus outline drawn
 * by the one `:focus-visible` rule in globals.css, against the 3:1 that a
 * non-text indicator needs. All of these are WCAG-formula measurements, not a
 * conformance claim.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(root, "app", "globals.css"), "utf-8");
const doc = readFileSync(join(root, "docs", "06_UI_DESIGN_SYSTEM.md"), "utf-8");

/** The body of the first `:root { ... }` block of a text. */
function rootBlock(text: string): string {
  return /:root\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? "";
}

/** `--name: #HEX` pairs inside the first `:root { ... }` block of a text. */
function rootTokens(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of rootBlock(text).matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) {
    out.set(m[1], m[2].toUpperCase());
  }
  return out;
}

/** Every `--name: value` declaration in the CSS `:root`, aliases included. */
const cssVars = new Map<string, string>();
for (const m of rootBlock(css).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
  cssVars.set(m[1], m[2].trim());
}

/** A CSS variable followed through `var(--x)` aliases down to its hex. */
function resolveHex(name: string, seen: string[] = []): string {
  const value = cssVars.get(name);
  if (value === undefined) throw new Error("--" + name + " is not declared in :root");
  if (seen.includes(name)) throw new Error("--" + name + " is a var() cycle");
  const hex = /^#[0-9a-fA-F]{6}$/.exec(value);
  if (hex) return hex[0].toUpperCase();
  const alias = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (alias) return resolveHex(alias[1], [...seen, name]);
  throw new Error("--" + name + " is " + value + ", not a hex or a var() alias");
}

function channels(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, order-independent. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * `color` at `alpha` painted over `base`, as the browser composites it (in
 * gamma-encoded sRGB). Tailwind's `bg-warning/10` is the token at 10% alpha.
 */
function over(color: string, alpha: number, base: string): string {
  const top = channels(color);
  const bottom = channels(base);
  return (
    "#" +
    top
      .map((c, i) => Math.round(alpha * c + (1 - alpha) * bottom[i]).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

const cssTokens = rootTokens(css);
const docTokens = rootTokens(doc);

describe("the palette in doc 06 is the palette in globals.css", () => {
  it("the doc still prints a palette (the guard is not satisfiable by deleting it)", () => {
    expect(docTokens.size).toBeGreaterThanOrEqual(12);
    for (const name of [
      "brand-950",
      "brand-700",
      "surface",
      "surface-2",
      "text-1",
      "text-2",
      "text-3",
      "warning",
      "accent-700",
    ]) {
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

  it("every bronze/brand token has a Tailwind colour, so `text-accent-700` is a real class", () => {
    for (const name of ["accent-500", "accent-700", "warning"]) {
      expect(css, "@theme inline does not map --" + name).toContain("--color-" + name + ": var(--" + name + ");");
    }
  });
});

describe("text tokens read on both surfaces (WCAG-formula 4.5:1)", () => {
  const surfaces = ["surface", "surface-2"] as const;
  // every token the app sets as TEXT; --accent-500 is not one of them (fills,
  // rings and icons only — bronze text is --accent-700)
  const texts = [
    "text-1",
    "text-2",
    "text-3",
    "brand-700",
    "brand-500",
    "success",
    "warning",
    "danger",
    "accent-700",
  ] as const;

  for (const text of texts) {
    for (const surface of surfaces) {
      it("--" + text + " on --" + surface, () => {
        const ratio = contrast(resolveHex(text), resolveHex(surface));
        expect(ratio, "--" + text + " on --" + surface + " is " + ratio.toFixed(2) + ":1").toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("--warning on its own 10% tint (the warning-notice idiom: bg-warning/10)", () => {
    const tint = over(resolveHex("warning"), 0.1, resolveHex("surface"));
    const ratio = contrast(resolveHex("warning"), tint);
    expect(ratio, "--warning on " + tint + " is " + ratio.toFixed(2) + ":1").toBeGreaterThanOrEqual(4.5);
  });

  it("the measurement is the formula, not a constant: the old warning and accent fail it", () => {
    // the values A08 replaced, measured by the same function — so a broken
    // contrast() that passes everything cannot keep this suite green
    expect(contrast("#B7791F", "#FFFFFF")).toBeLessThan(4.5);
    expect(contrast("#B08D57", "#FFFFFF")).toBeLessThan(4.5);
    expect(contrast(resolveHex("accent-500"), resolveHex("surface"))).toBeLessThan(4.5);
  });
});

describe("the keyboard-focus outline (A08) is visible where it is drawn", () => {
  /** The declarations of the first rule whose selector ends in `selectorTail {`. */
  function ruleBody(selectorTail: RegExp): string {
    const m = new RegExp(selectorTail.source + "\\s*\\{([^}]*)\\}").exec(css);
    expect(m, "globals.css lost the rule " + selectorTail).not.toBeNull();
    return m![1];
  }

  const baseLayer = /@layer base\s*\{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? "";

  it("the general rule is in @layer base, so the ui primitives' own utilities win (no double ring)", () => {
    expect(baseLayer).toMatch(/:where\([^)]*\ba\[href\][^)]*\bbutton\b[^{]*:focus-visible\s*\{/);
    expect(baseLayer).toMatch(/\.bg-brand-950 :focus-visible\s*\{/);
  });

  it("is a solid outline at least 2px wide in a colour with 3:1 on every light surface it sits on", () => {
    const body = ruleBody(/\):where\(:not\(\[role="tab"\]\)\):focus-visible/);
    const m = /outline:\s*(\d+)px\s+solid\s+var\(--([a-z0-9-]+)\)/.exec(body);
    expect(m, "the focus rule is not `outline: Npx solid var(--token)`").not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(2);
    const ring = resolveHex(m![2]);
    // --brand-100 is the selected settings tab; the others are page surfaces
    for (const surface of ["surface", "surface-2", "brand-100"]) {
      const ratio = contrast(ring, resolveHex(surface));
      expect(ratio, "focus outline " + ring + " on --" + surface + " is " + ratio.toFixed(2) + ":1").toBeGreaterThanOrEqual(3);
    }
  });

  it("turns white-enough on the navy sidebar and drawer (3:1 on --brand-950 and its hover --brand-900)", () => {
    const body = ruleBody(/\.bg-brand-950 :focus-visible/);
    const m = /outline-color:\s*var\(--([a-z0-9-]+)\)/.exec(body);
    expect(m, "the navy rule is not `outline-color: var(--token)`").not.toBeNull();
    const onDark = resolveHex(m![1]);
    for (const navy of ["brand-950", "brand-900"]) {
      const ratio = contrast(onDark, resolveHex(navy));
      expect(ratio, "focus outline " + onDark + " on --" + navy + " is " + ratio.toFixed(2) + ":1").toBeGreaterThanOrEqual(3);
    }
    // and the general colour would NOT have been enough there — the reason
    // the navy rule exists (brand-500 on brand-900 measures under 3:1)
    expect(contrast(resolveHex("ring"), resolveHex("brand-900"))).toBeLessThan(3);
  });
});
