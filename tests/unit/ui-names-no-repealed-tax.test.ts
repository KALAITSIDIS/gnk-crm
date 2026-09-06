import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Stamp duty is repealed for documents signed on or after 2026-01-01
 * (Law 239(I)/2025; migration 0070; DECISIONS T-tax-2026). The ONLY code that
 * knows this is the code that reads `cyprus_config.stamp_duty` — its
 * `abolished` block is what the calculators panel renders instead of a figure.
 *
 * Any other UI string naming the tax is an unbound copy that quotes a repealed
 * tax until someone notices: the property and deal "Costs" tooltips read
 * "Transfer fees & stamp duty" for nine months after the repeal. Rule: a .tsx
 * under app/ or components/ may name stamp duty only if it imports the
 * calculators service — i.e. only if it renders what the config says. A link
 * to the calculators names its destination, not the taxes.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVICE = "lib/services/calculators";

/** UI strings live in code; a comment recalling the tax's history is not one. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return /\.tsx$/.test(name) ? [full] : [];
  });
}

describe("no UI string names stamp duty unless it renders the config", () => {
  it("every .tsx that says 'stamp duty' imports the calculators service", () => {
    const offenders: string[] = [];
    for (const dir of ["app", "components"]) {
      for (const file of tsxFiles(join(root, dir))) {
        const src = readFileSync(file, "utf-8");
        if (!/stamp duty/i.test(stripComments(src))) continue;
        if (src.includes(SERVICE)) continue;
        offenders.push(relative(root, file).replace(/\\/g, "/"));
      }
    }
    expect(
      offenders,
      "names a repealed tax without reading cyprus_config.stamp_duty — name the destination instead",
    ).toEqual([]);
  });

  it("the calculators themselves still say it, because they read whether it applies", () => {
    // The guard above must not be satisfiable by deleting the truth.
    const client = readFileSync(
      join(root, "components", "features", "calculators", "calculators-client.tsx"),
      "utf-8",
    );
    expect(client).toMatch(/stamp duty/i);
    expect(client).toContain(SERVICE);
  });
});
