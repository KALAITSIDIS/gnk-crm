import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A `due_at` is an INSTANT, and its day is the CYPRUS day.
 *
 * This class of defect has now been fixed four times in two days — three prompt
 * raisers on 2026-09-07 (`cyprusEndOfToday`), the match-alert raiser and a SQL
 * function on 2026-09-08 (`cyprusEndOfTomorrow`, migration 0091) — and each time
 * the same expression:
 *
 *     const today = new Date().toISOString().slice(0, 10);
 *     ...
 *     due_at: cyprusEndOfDay(today).toISOString(),
 *
 * `toISOString()` renders UTC. Cyprus is UTC+2 in winter and UTC+3 in summer, so
 * between local midnight and 02:00/03:00 that string names YESTERDAY, the
 * end-of-day it builds is already hours past, and the task is born overdue — in
 * exactly the window the end-of-day rule exists to protect. Cyprus is always
 * ahead of UTC, so the error is one-directional: always early, never late.
 *
 * WHY A SOURCE SCAN AND NOT A BEHAVIOURAL TEST. Two of the four sites
 * (`markDealWon`, `transitionReservation`) have no unit test at all, and the one
 * that does had an assertion — `expect(due_at).toBeGreaterThan(Date.now())` —
 * that a mutation run showed CANNOT FAIL during working hours: restoring the bug
 * left all sixteen tests green at 13:05 local, because the assertion is only
 * violated inside the three-hour window. Behaviour is pinned where a harness
 * exists (lib/services/followup-tasks.test.ts, lib/validators/reservations.test.ts);
 * this pins the shape everywhere else, including in code nobody has written yet.
 *
 * THE DISCRIMINATOR, because the same expression is CORRECT elsewhere. A `date`
 * column compared against the database's `current_date` — mandate `start_date`
 * and `expiry_date`, which six sweeps test with `expiry_date < current_date` —
 * belongs to the database's calendar, and the database session runs in UTC.
 * Moving those to the Cyprus day would introduce the mismatch, not remove it
 * (`lib/services/mandate-renewal.ts` is right as it stands). The rule is about
 * `due_at` specifically: an instant, rendered relative to now, on a screen in
 * Cyprus.
 */

const UTC_DAY = /toISOString\(\)\.slice\(0, ?10\)|\.split\("T"\)\[0\]/;
const ROOTS = ["lib", "app", "components"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Comments are stripped before the scan, so the prose explaining the bug in
 * `match-alerts.ts` and `reservations.ts` does not trip the rule it documents.
 * Naive on purpose: it can only ever remove text, so it cannot manufacture a
 * false pass — the worst it does is leave a `//` inside a string literal in
 * place, which is a match this test would want to look at anyway.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = ROOTS.flatMap((r) => sourceFiles(join(process.cwd(), r)));

describe("a due_at is stamped with the Cyprus day, never the UTC one", () => {
  it("finds the source tree it means to scan", () => {
    // guards against a silent zero-file pass after a directory move
    expect(files.length, "lib + app + components").toBeGreaterThan(200);
    expect(
      files.filter((f) => stripComments(readFileSync(f, "utf-8")).includes("due_at:")).length,
      "the raisers this rule is about",
    ).toBeGreaterThanOrEqual(6);
  });

  it("no file that stamps a due_at derives a day key from UTC", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf-8"));
      if (!src.includes("due_at:")) continue;
      if (!UTC_DAY.test(src)) continue;
      const line = src.split("\n").findIndex((l) => UTC_DAY.test(l)) + 1;
      offenders.push(`${relative(process.cwd(), file).replace(/\\/g, "/")}:${line}`);
    }
    expect(
      offenders,
      "use cyprusEndOfToday / cyprusEndOfTomorrow (lib/validators/reservations.ts) — " +
        "toISOString().slice(0, 10) is the UTC day and is a day short until 03:00 Cyprus",
    ).toEqual([]);
  });

  it("cyprusEndOfDay is never handed a UTC-derived day key", () => {
    // The helper itself is fine — `cyprusEndOfDay("2026-07-16")` is exactly right
    // for a day key that came from a form field or a Cyprus-local calculation.
    // What was wrong every time is where the key came from.
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf-8"));
      const calls = [...src.matchAll(/cyprusEndOfDay\(([^)]*)\)/g)].map((m) => m[1].trim());
      for (const arg of calls) {
        if (UTC_DAY.test(arg)) {
          offenders.push(`${relative(process.cwd(), file).replace(/\\/g, "/")}: cyprusEndOfDay(${arg})`);
        }
      }
    }
    expect(offenders, "pass a Cyprus day key, not a UTC one").toEqual([]);
  });
});
