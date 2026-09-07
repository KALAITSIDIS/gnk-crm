import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The standalone scripts run under PLAIN NODE, which resolves neither a
 * tsconfig `@/` alias nor an extensionless path — so every module they can
 * reach must import its VALUES relatively and with the file extension.
 *
 * This has now broken twice. `d01b3ba` fixed it the first time, when the
 * shared unit definition reached `quality-score.ts` through the alias and
 * `npm run recompute:scores` died with ERR_MODULE_NOT_FOUND; a comment was
 * left above the import saying exactly what the rule is. On 2026-09-07 the
 * shared-photograph lookup was added directly ABOVE that comment, outside its
 * protection, and the script broke again — found only because someone happened
 * to run it. Nothing in CI runs these scripts, so a comment was the entire
 * enforcement.
 *
 * This walks the real import graph from every script and fails on the exact
 * thing Node cannot resolve. A `import type` is fine: TypeScript erases it
 * before Node ever sees it.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT_DIR = join(root, "scripts");

function scriptEntryPoints(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return scriptEntryPoints(full);
    return /\.(mts|mjs)$/.test(name) ? [full] : [];
  });
}

/** `import ... from "x"` / `export ... from "x"`, with whether it was type-only. */
function importsOf(src: string): { spec: string; typeOnly: boolean }[] {
  const out: { spec: string; typeOnly: boolean }[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([\s\S]*?)from\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) {
    // `import { type Foo, bar }` is a value import of `bar`; only a leading
    // `import type` erases the whole statement.
    out.push({ spec: m[3], typeOnly: Boolean(m[1]) });
  }
  return out;
}

/** Resolve a relative specifier the way Node would, tolerating a missing extension. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.mts`, `${base}.js`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every module reachable from `entry` through relative imports, plus any aliased value imports found. */
function walk(entry: string) {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const { spec, typeOnly } of importsOf(src)) {
      if (spec.startsWith("@/")) {
        if (!typeOnly) {
          offenders.push(
            `${relative(root, file).replace(/\\/g, "/")} imports VALUES from "${spec}"`,
          );
        }
        continue; // an alias is never followed — Node cannot follow it either
      }
      if (!spec.startsWith(".")) continue; // a real package
      const next = resolveRelative(file, spec);
      if (next) stack.push(next);
    }
  }
  return { reached: seen, offenders };
}

describe("the standalone scripts can actually run under plain Node", () => {
  const entries = scriptEntryPoints(SCRIPT_DIR);

  it("finds the scripts at all — an empty scan would pass vacuously", () => {
    expect(entries.length).toBeGreaterThanOrEqual(3);
  });

  it("no module a script can reach imports VALUES through the @/ alias", () => {
    const offenders: string[] = [];
    for (const entry of entries) {
      const { offenders: bad } = walk(entry);
      for (const b of bad) {
        offenders.push(`${relative(root, entry).replace(/\\/g, "/")}: ${b}`);
      }
    }
    expect(
      [...new Set(offenders)],
      'import it relatively WITH the extension — plain Node resolves neither "@/" nor a missing extension',
    ).toEqual([]);
  });

  it("actually reaches the scoring module, so the guard is not scanning nothing", () => {
    // recompute-scores.mts is the script the two breakages were found through.
    const entry = entries.find((e) => e.endsWith("recompute-scores.mts"));
    expect(entry, "recompute-scores.mts").toBeDefined();
    const reached = [...walk(entry!).reached].map((f) => relative(root, f).replace(/\\/g, "/"));
    expect(reached).toContain("lib/services/quality-score.ts");
    expect(reached, "and the modules it pulls in behind it").toEqual(
      expect.arrayContaining(["lib/services/container-units.ts", "lib/services/shared-photos.ts"]),
    );
  });
});
