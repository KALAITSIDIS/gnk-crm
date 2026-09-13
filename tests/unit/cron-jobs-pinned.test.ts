import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPECTED_CRON_JOBS } from "@/lib/services/cron-health";

/**
 * The dashboard's cron-health banner says how many jobs it expects. That
 * number was a literal in the component, and it went stale: 0092 scheduled
 * the ninth job on 2026-09-13 and production read "expected 8 jobs, found 9"
 * for the rest of the day, on the one card whose purpose is to be believed.
 * Every other pin of this count (RLS test 50, the restore pack, docs/10,
 * HANDOFF §0) moved; the one on the screen did not.
 *
 * Now the number lives once, in lib/services/cron-health.ts, and this test
 * derives the truth from the migrations: the distinct names ever given to
 * cron.schedule(). (followup-nudges is unscheduled and re-scheduled by a
 * later migration — one name, one job.) The component must read the constant
 * and carry no literal of its own.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = join(root, "supabase", "migrations");

describe("the cron-health banner's expected job count", () => {
  it("equals the number of distinct jobs the migrations schedule", () => {
    const names = new Set<string>();
    for (const f of readdirSync(migrationsDir).filter((f) => /^\d{4}_.+\.sql$/.test(f))) {
      const sql = readFileSync(join(migrationsDir, f), "utf-8");
      for (const m of sql.matchAll(/cron\.schedule\('([a-z-]+)'/g)) names.add(m[1]!);
    }
    expect(names.size, "the scanner must find the known jobs").toBeGreaterThan(5);
    expect(EXPECTED_CRON_JOBS, `bump EXPECTED_CRON_JOBS: migrations schedule ${[...names].join(", ")}`).toBe(names.size);
  });

  it("is what the dashboard component reads — no literal of its own", () => {
    const src = readFileSync(join(root, "components", "features", "dashboard", "cron-health.tsx"), "utf-8");
    expect(src).toContain("EXPECTED_CRON_JOBS");
    expect(src, "a literal count on the screen is the thing that went stale").not.toMatch(/expected \d+ jobs|!== \d+ \?/);
  });
});
