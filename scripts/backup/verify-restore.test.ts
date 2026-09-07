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
 *
 * export.mjs's TABLES list is pinned the same way: it lagged ten tables until
 * REL-04 (2026-08-30) and missed 0084's counter five migrations later.
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

  it("pins the task-kind count the migrations themselves assert", () => {
    /*
     * The migrations pin above was bumped for 0089 and this one was not, so a
     * restore drill would have reported `seed: task_kinds expected 12 actual
     * 13` — and this pack's own header calls a false failure "the worst
     * possible signal mid-recovery".
     *
     * Derived from the migrations rather than hand-kept, and specifically from
     * the assertion every kind migration already carries
     * (`select count(*) into n from public.task_kinds; if n <> N then raise`).
     * That is the discipline that governs the number, so tying the pack to it
     * means the next kind cannot land without moving this line too.
     */
    const asserted = migrationFiles
      .map((f) => readFileSync(join(migrationsDir, f), "utf-8"))
      .flatMap((sql) => [...sql.matchAll(/from public\.task_kinds;\s*if n <> (\d+)/g)])
      .map((m) => Number(m[1]));

    expect(asserted.length, "the kind migrations assert their total").toBeGreaterThan(0);
    const latest = Math.max(...asserted);

    const pinned = pack.match(/(\d+)::bigint as task_kinds/);
    expect(pinned, "the task_kinds pin must exist").not.toBeNull();
    expect(Number(pinned![1]), "bump the task_kinds baseline when a kind lands").toBe(latest);
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

  it("export.mjs backs up every table the migrations create", () => {
    // Same technique as the SECURITY DEFINER pin above: replay create / drop /
    // rename in file order, so 0063's rename-then-recreate of `events` resolves
    // the way Postgres did. `--` comments are stripped first (prose mentions
    // CREATE TABLE), and the `(?![.\w])` guard rejects 0063's format string
    // `create table events_parts.%I` — partitions live outside public and
    // are not export targets anyway.
    const live = new Set<string>();
    const stmt =
      /\b(create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?|drop\s+table\s+(?:if\s+exists\s+)?|alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?)(?:([a-z_][a-z_0-9]*)\.)?([a-z_][a-z_0-9]*)(?![.\w])(?:\s+rename\s+to\s+([a-z_][a-z_0-9]*))?/gi;
    for (const file of [...migrationFiles].sort()) {
      const sql = readFileSync(join(migrationsDir, file), "utf-8").replace(/--[^\n]*/g, "");
      for (const m of sql.matchAll(stmt)) {
        const [, verb, schema, name, renamed] = m;
        if (schema && schema.toLowerCase() !== "public") continue;
        const n = name.toLowerCase();
        if (/^create/i.test(verb)) live.add(n);
        else if (/^drop/i.test(verb)) live.delete(n);
        else if (renamed) {
          live.delete(n);
          live.add(renamed.toLowerCase());
        }
      }
    }
    expect(live.size, "the scanner must find the known schema").toBeGreaterThan(30);

    const src = readFileSync(join(here, "export.mjs"), "utf-8");
    const start = src.indexOf("const TABLES = [");
    const block = src.slice(start, src.indexOf("];", start));
    const exported = new Set([...block.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]));

    expect(
      [...live].filter((t) => !exported.has(t)).sort(),
      "created by a migration but absent from export.mjs TABLES — a restore would lose it",
    ).toEqual([]);
    expect(
      [...exported].filter((t) => !live.has(t)).sort(),
      "in export.mjs TABLES but no migration creates it — the nightly export would throw",
    ).toEqual([]);
  });
});
