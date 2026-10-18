import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ONE score-input builder (F03). `buildQualityInput` (lib/services/
 * quality-score.ts) is where every rule about what earns a point lives — that
 * a centroid stand-in is not an exact map location (0054), that a container
 * is graded on its units, that an undefined column is unset. The property
 * page and the publish gate each built their own input by hand beside it; a
 * comment in the gate said the two "must agree", and the page's had already
 * stopped agreeing: it counted an approximate point as exact, so its ring read
 * 10 points above the stored score, the worklist and the gate (fixed in F07;
 * the gate's copy removed in F03).
 *
 * A comment was the whole enforcement. This is the rule as a test: outside
 * quality-score.ts itself, every `computeQualityScore(` in the shipped code
 * (app, components, lib, scripts — not tests) is handed
 * `buildQualityInput(...)`, and nothing spells a QualityScoreInput by hand.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIRS = ["app", "components", "lib", "scripts"];
const DEFINITION = join("lib", "services", "quality-score.ts");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sources(full);
    if (!/\.(ts|tsx|mts)$/.test(name) || /\.test\.(ts|tsx)$/.test(name) || name.endsWith(".d.ts")) return [];
    return [full];
  });
}

const files = DIRS.flatMap((d) => sources(join(root, d))).map((f) => ({
  path: relative(root, f),
  src: readFileSync(f, "utf8"),
}));

/** What each call is handed: the text from its `(` to the first non-space token after it. */
function callArguments(src: string): string[] {
  return [...src.matchAll(/\bcomputeQualityScore\s*\(\s*([A-Za-z_$][\w$]*|\{|\S)/g)].map((m) => m[1]!);
}

describe("one quality-score input builder", () => {
  it("scans the shipped code (the walk found the callers it must)", () => {
    const callers = files.filter((f) => /\bcomputeQualityScore\s*\(/.test(f.src)).map((f) => f.path.replace(/\\/g, "/"));
    // the four the F03 record names — if one moves, this list says so
    for (const known of [
      "app/(app)/properties/[id]/page.tsx",
      "lib/actions/properties.ts",
      "lib/queries/quality-worklist.ts",
      "lib/services/quality-score.ts",
    ]) {
      expect(callers, `${known} still scores through computeQualityScore`).toContain(known);
    }
  });

  it("every computeQualityScore call outside its own file is handed buildQualityInput(...)", () => {
    const offenders = files
      .filter((f) => f.path !== DEFINITION)
      .flatMap((f) =>
        callArguments(f.src)
          .filter((arg) => arg !== "buildQualityInput")
          .map((arg) => `${f.path}: computeQualityScore(${arg}…`),
      );
    expect(offenders, "build the input with buildQualityInput — the one definition").toEqual([]);
  });

  it("nothing outside quality-score.ts spells a QualityScoreInput by hand", () => {
    const offenders = files
      .filter((f) => f.path !== DEFINITION)
      .filter((f) => /:\s*QualityScoreInput\s*=\s*\{|as\s+QualityScoreInput\b|satisfies\s+QualityScoreInput\b/.test(f.src))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("the detector itself flags an inline object, and passes the builder", () => {
    expect(callArguments("computeQualityScore({ isLand: false })")).toEqual(["{"]);
    expect(callArguments("computeQualityScore(\n  buildQualityInput(p, facts),\n)")).toEqual(["buildQualityInput"]);
    expect(callArguments("computeQualityScore(input)")).toEqual(["input"]);
  });
});
