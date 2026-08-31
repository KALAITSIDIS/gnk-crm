import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The restore pack's hand-pinned facts, locked to the repo in CI.
 *
 * verify-restore.sql pins a migrations count and a function-grants table by
 * hand, and both have now gone stale twice: the 2026-08-31 cloud drill found
 * the count at 73 when hosted was at 78, the same-day bump to 78 was stale
 * within hours when 0079 merged, and the grants table missed 0074's
 * cron_health() ELEVEN MINUTES after being generated (2026-09-01 review).
 * The pack only runs at drill time, so CI is where the staleness must fail.
 */

const here = dirname(fileURLToPath(import.meta.url));
const pack = readFileSync(join(here, "verify-restore.sql"), "utf-8");
const migrationsDir = join(here, "..", "..", "supabase", "migrations");
const migrationFiles = readdirSync(migrationsDir).filter((f) => /^\d{4}_.+\.sql$/.test(f));

describe("verify-restore.sql stays in lockstep with the repo", () => {
  it("pins exactly as many migrations as the repo ships", () => {
    const m = pack.match(/(\d+)::bigint as migrations/);
    expect(m, "the migrations pin must exist").not.toBeNull();
    expect(Number(m![1]), "bump the baseline when a migration lands").toBe(
      migrationFiles.length,
    );
  });

  it("pins every SECURITY DEFINER function the migrations create", () => {
    // Track create/drop in file order so functions later dropped (e.g. the
    // pre-partition helpers) don't fire. A function counts as secdef when the
    // clause appears in its header — between the signature and the body
    // opener — matching this repo's uniform `create or replace function ...
    // security definer ... as $...$` layout.
    const live = new Map<string, boolean>();
    for (const file of [...migrationFiles].sort()) {
      const sql = readFileSync(join(migrationsDir, file), "utf-8");
      for (const m of sql.matchAll(
        /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_0-9]+)\s*\(/gi,
      )) {
        const header = sql.slice(m.index!, m.index! + 2000);
        const bodyStart = header.search(/\bas\s+\$[a-z_]*\$/i);
        const clause = bodyStart === -1 ? header : header.slice(0, bodyStart);
        live.set(m[1].toLowerCase(), /security\s+definer/i.test(clause));
      }
      for (const m of sql.matchAll(
        /drop\s+function\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_0-9]+)/gi,
      )) {
        live.delete(m[1].toLowerCase());
      }
    }
    const secdef = [...live.entries()].filter(([, s]) => s).map(([n]) => n);
    expect(secdef.length, "the scanner must find the known surface").toBeGreaterThan(30);

    const table = pack.slice(
      pack.indexOf("grants_expected(fn"),
      pack.indexOf("grants_actual as"),
    );
    const pinned = new Set(
      [...table.matchAll(/\('([a-z_0-9]+)',/g)].map((m) => m[1].toLowerCase()),
    );
    const unpinned = secdef.filter((fn) => !pinned.has(fn));
    expect(
      unpinned,
      "every migration-created SECURITY DEFINER function needs a grants_expected row " +
        "(regenerate the table — the query is in verify-restore.sql's comment)",
    ).toEqual([]);
  });
});
