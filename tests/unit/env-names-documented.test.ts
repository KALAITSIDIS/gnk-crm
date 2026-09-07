import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `.env.example` is the only human-facing list of what this app reads from its
 * environment, and until this test nothing connected it to the code.
 *
 * It had already drifted: `ENQUIRY_ALERT_TO` and `ENQUIRY_ALERT_FROM` are read
 * by the enquiry alert and were documented in `docs/10_INFRASTRUCTURE.md` and
 * not here — two hand-kept lists, which is two things to remember and one that
 * will be wrong. Found by the 2026-09-07 review, which noted that gnk-web has
 * exactly this binding for its README and this repo praised it for having one.
 *
 * The rule: every `process.env.NAME` in shipped code names a variable
 * `.env.example` lists, unless the PLATFORM sets it — Vercel and Node supply
 * those, and asking an operator to put them in a local env file would be
 * asking for something wrong.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIPPED = ["app", "components", "lib"];
const ROOT_FILES = ["proxy.ts", "instrumentation.ts", "instrumentation-client.ts"];

/** Set by the runtime, not by an operator. */
const PLATFORM = new Set([
  "NODE_ENV",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_GIT_COMMIT_SHA",
  "NEXT_PUBLIC_VERCEL_ENV",
  "NEXT_RUNTIME",
  "TZ",
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.(ts|tsx|mts)$/.test(name) || /\.test\.tsx?$/.test(name)) return [];
    return [full];
  });
}

/** Every `process.env.NAME` in shipped code, with the file that reads it. */
function readsInCode(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const files = [
    ...SHIPPED.flatMap((d) => sourceFiles(join(root, d))),
    ...ROOT_FILES.map((f) => join(root, f)),
  ];
  for (const file of files) {
    let src: string;
    try {
      src = readFileSync(file, "utf-8");
    } catch {
      continue; // an optional root file
    }
    for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      const where = relative(root, file).replace(/\\/g, "/");
      out.set(m[1], [...(out.get(m[1]) ?? []), where]);
    }
  }
  return out;
}

const documented = new Set(
  [...readFileSync(join(root, ".env.example"), "utf-8").matchAll(/^([A-Z0-9_]+)=/gm)].map(
    (m) => m[1],
  ),
);

describe(".env.example names what the code reads", () => {
  it("finds the reads at all — a scan that matches nothing would pass vacuously", () => {
    expect(readsInCode().size).toBeGreaterThanOrEqual(8);
    expect(documented.size).toBeGreaterThanOrEqual(8);
  });

  it("every operator-set variable the code reads is listed", () => {
    const missing: string[] = [];
    for (const [name, files] of readsInCode()) {
      if (PLATFORM.has(name) || documented.has(name)) continue;
      missing.push(`${name} (read in ${[...new Set(files)].join(", ")})`);
    }
    expect(missing, "add these to .env.example, or to PLATFORM if the runtime sets them").toEqual(
      [],
    );
  });

  it("names no variable the code stopped reading — a stale entry is a wrong instruction", () => {
    const reads = readsInCode();
    const stale = [...documented].filter((name) => !reads.has(name) && !PLATFORM.has(name));
    expect(stale, "these are in .env.example and read nowhere").toEqual([]);
  });
});
