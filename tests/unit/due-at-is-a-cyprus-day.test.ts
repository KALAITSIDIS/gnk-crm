import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A `due_at` is an INSTANT, and its day is the CYPRUS day.
 *
 * `toISOString()` renders UTC. Cyprus is UTC+2 in winter and UTC+3 in summer, so
 * between local midnight and 02:00/03:00 a day key taken from it names YESTERDAY,
 * the end-of-day built from it is already hours past, and the task is born
 * overdue — in exactly the window the end-of-day rule exists to protect. Cyprus
 * is always ahead of UTC, so the error is one-directional: always early.
 *
 * WHY A SOURCE SCAN. Two of the four historical sites (`markDealWon`,
 * `transitionReservation`) have no unit test at all, so there is no behaviour to
 * pin. Behaviour is pinned where a harness exists
 * (lib/services/followup-tasks.test.ts, lib/services/match-alerts.test.ts,
 * lib/validators/reservations.test.ts); this pins the SHAPE everywhere else,
 * including in code nobody has written yet.
 *
 * THE DISCRIMINATOR, because the same expression is CORRECT elsewhere. A `date`
 * column compared against the database's `current_date` — mandate `start_date`
 * and `expiry_date`, which six sweeps test with `expiry_date < current_date` —
 * belongs to the database's calendar, and the session runs UTC. Moving those to
 * the Cyprus day would introduce the mismatch, not remove it
 * (`lib/services/mandate-renewal.ts` is right as it stands). The rule is about
 * `due_at`: an instant, rendered against now, on a screen in Cyprus.
 *
 * ─── WHY THIS FILE WAS REWRITTEN ────────────────────────────────────────────
 * The first version of this guard was GREEN ON THE BUG IT WAS WRITTEN FOR. An
 * adversarial pass ran it against the actual pre-fix sources and got
 * `OFFENDER: false` for `lib/actions/deals.ts` and `lib/actions/reservations.ts`
 * — precisely the two files with no unit test, the two it existed to cover.
 * Three defects, all measured:
 *
 *   1. The pattern required `toISOString()` to be textually ADJACENT to
 *      `.slice(0, 10)`. Two of the four sites assigned the ISO string to a
 *      variable first (`const now = new Date().toISOString();` … then
 *      `cyprusEndOfDay(now.slice(0, 10))`), so the pattern never matched.
 *   2. The `cyprusEndOfDay(...)` argument check used `\(([^)]*)\)`, which stops
 *      at the FIRST close-paren. Every expression it looks for contains one, so
 *      the capture was always truncated before the part that would match and the
 *      assertion could not fail for any input.
 *   3. The `due_at:` gate was applied to the comment-STRIPPED source, so a naive
 *      strip that ate real code (it does: an unterminated `/*` inside a string,
 *      or a `//` in a URL literal) removes a file from the rule entirely. The
 *      old docstring argued a strip "can only ever remove text, so it cannot
 *      manufacture a false pass" — inverted: removing text is exactly how a file
 *      becomes invisible to a rule gated on what the text contains.
 *
 * The structural fix is the last block in this file: the scanner is a pure
 * function, and it is run against the four real historical shapes as FIXTURES.
 * A pattern that stops recognising the bugs this guard was built for now fails
 * loudly instead of going quiet.
 */

/**
 * A UTC-derived day key. Deliberately BROADER than "toISOString().slice(0,10)":
 * inside a file that stamps a `due_at`, a bare 10-character slice or a `split`
 * on the ISO separator is worth flagging whatever it was sliced from, because
 * the variable form is the shape half the real defects took. Measured against
 * the current tree: zero false positives outside comments.
 */
const UTC_DAY = /\.slice\(0, ?10\)|\.split\(["']T["']\)\[0\]/;

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
 * Naive, and only ever used to SUPPRESS a match — never to decide whether a file
 * is in scope. That separation is the fix for defect 3 above: if the strip eats
 * real code the worst it can do is hide one match inside a file the scan is
 * still looking at, and the fixtures below would catch a strip broken enough to
 * matter.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The whole rule, as one pure function, so fixtures exercise the real thing. */
export function scanForUtcDayKey(src: string): { stampsDueAt: boolean; offendingLine: number | null } {
  // GATE ON THE RAW SOURCE — see defect 3.
  const stampsDueAt = src.includes("due_at:");
  if (!stampsDueAt) return { stampsDueAt: false, offendingLine: null };
  const lines = stripComments(src).split("\n");
  const idx = lines.findIndex((l) => UTC_DAY.test(l));
  return { stampsDueAt: true, offendingLine: idx === -1 ? null : idx + 1 };
}

/** Lines that call cyprusEndOfDay AND carry a UTC day key on the same line. */
export function scanForUtcArgument(src: string): number[] {
  return stripComments(src)
    .split("\n")
    .map((l, i) => (l.includes("cyprusEndOfDay(") && UTC_DAY.test(l) ? i + 1 : 0))
    .filter(Boolean);
}

const files = ROOTS.flatMap((r) => sourceFiles(join(process.cwd(), r)));

describe("a due_at is stamped with the Cyprus day, never the UTC one", () => {
  it("finds the source tree it means to scan", () => {
    expect(files.length, "lib + app + components").toBeGreaterThan(200);
    expect(
      files.filter((f) => scanForUtcDayKey(readFileSync(f, "utf-8")).stampsDueAt).length,
      "the raisers this rule is about",
    ).toBeGreaterThanOrEqual(6);
  });

  it("no file that stamps a due_at derives a day key from UTC", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const { stampsDueAt, offendingLine } = scanForUtcDayKey(readFileSync(file, "utf-8"));
      if (stampsDueAt && offendingLine !== null) {
        offenders.push(`${relative(process.cwd(), file).replace(/\\/g, "/")}:${offendingLine}`);
      }
    }
    expect(
      offenders,
      "use cyprusEndOfToday / cyprusEndOfTomorrow (lib/validators/reservations.ts) — " +
        "a day key sliced off an ISO string is the UTC day, a day short until 03:00 Cyprus",
    ).toEqual([]);
  });

  it("cyprusEndOfDay is never handed a UTC-derived day key on the spot", () => {
    // The helper itself is fine: `cyprusEndOfDay("2026-07-16")` is exactly right
    // for a key from a form field or a Cyprus-local calculation. What was wrong
    // every time is where the key came from.
    const offenders: string[] = [];
    for (const file of files) {
      for (const line of scanForUtcArgument(readFileSync(file, "utf-8"))) {
        offenders.push(`${relative(process.cwd(), file).replace(/\\/g, "/")}:${line}`);
      }
    }
    expect(offenders, "pass a Cyprus day key, not a UTC one").toEqual([]);
  });
});

/**
 * ─── THE GUARD'S OWN REGRESSION SUITE ───────────────────────────────────────
 *
 * Every fixture below is a REAL historical defect, copied from the commit that
 * carried it. If a future edit narrows the pattern, these go red — which is what
 * the first version of this file had no way of doing.
 */
describe("the guard recognises every shape the bug actually took", () => {
  const HISTORIC = [
    {
      name: "markDealWon — ISO in a variable, sliced later (lib/actions/deals.ts before 5546b61)",
      src: `const now = new Date().toISOString();\nawait supabase.from("tasks").insert({\n  due_at: cyprusEndOfDay(now.slice(0, 10)).toISOString(),\n});`,
    },
    {
      name: "transitionReservation — same shape, different variable (lib/actions/reservations.ts before 5546b61)",
      src: `const nowIso = new Date().toISOString();\nawait supabase.from("tasks").insert({\n  due_at: cyprusEndOfDay(nowIso.slice(0, 10)).toISOString(),\n});`,
    },
    {
      name: "raiseLiveHoldCheck — inline slice into a named const (lib/services/followup-tasks.ts before 5546b61)",
      src: `const today = new Date().toISOString().slice(0, 10);\nawait supabase.from("tasks").insert({\n  due_at: cyprusEndOfDay(today).toISOString(),\n});`,
    },
    {
      name: "raiseOneTask — tomorrow, stepped then sliced (lib/services/match-alerts.ts before c122e05)",
      src: `const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);\nawait supabase.from("tasks").insert({\n  due_at: cyprusEndOfDay(tomorrow).toISOString(),\n});`,
    },
    {
      name: "the split variant, which no site used but the rule names",
      src: `const day = new Date().toISOString().split("T")[0];\nawait supabase.from("tasks").insert({\n  due_at: cyprusEndOfDay(day).toISOString(),\n});`,
    },
  ];

  it.each(HISTORIC)("flags $name", ({ src }) => {
    const { stampsDueAt, offendingLine } = scanForUtcDayKey(src);
    expect(stampsDueAt, "the fixture stamps a due_at").toBe(true);
    expect(offendingLine, "this exact source shipped and was a defect").not.toBeNull();
  });

  it("flags the two that the FIRST version of this guard missed", () => {
    // Named separately because these are the ones it was green on: no
    // `toISOString()` adjacent to the slice, and no unit test behind them.
    const variableForm = HISTORIC.slice(0, 2);
    for (const { src } of variableForm) {
      expect(scanForUtcDayKey(src).offendingLine).not.toBeNull();
    }
  });

  it("the argument check can actually fail, which its first version could not", () => {
    // `[^)]*` truncated at the first close-paren, and every pattern it looked
    // for contains one, so the old offenders array was always empty.
    expect(scanForUtcArgument(`due_at: cyprusEndOfDay(now.slice(0, 10)).toISOString(),`)).toEqual([
      1,
    ]);
    expect(
      scanForUtcArgument(`due_at: cyprusEndOfDay(dayKey).toISOString(),`),
      "a Cyprus day key passed by name is not an offence",
    ).toEqual([]);
  });

  it("does not flag correct code", () => {
    const good = [
      `due_at: cyprusEndOfToday().toISOString(),`,
      `due_at: cyprusEndOfTomorrow().toISOString(),`,
      `due_at: cyprusEndOfDay(zonedParts(now).dayKey).toISOString(),`,
      // a date column compared against current_date — the discriminator
      `start_date: new Date().toISOString().slice(0, 10),`,
    ];
    for (const src of good) {
      const r = scanForUtcDayKey(src);
      if (src.includes("due_at:")) expect(r.offendingLine, src).toBeNull();
      else expect(r.stampsDueAt, "no due_at, out of scope").toBe(false);
    }
  });

  it("a file is in scope even when comment-stripping mangles it", () => {
    // defect 3: the gate is decided on the RAW source, so a strip that eats code
    // can no longer remove a file from the rule.
    // The `/*` opens inside a string literal and the `*/` closes inside another
    // one three lines later, so the naive strip swallows the due_at between them.
    const src = [
      `const OPEN = "/* not really a comment";`,
      `await supabase.from("tasks").insert({`,
      `  due_at: cyprusEndOfDay(now.slice(0, 10)).toISOString(),`,
      `});`,
      `const CLOSE = "*/";`,
    ].join("\n");
    expect(stripComments(src).includes("due_at:"), "the strip really does eat it").toBe(false);
    expect(scanForUtcDayKey(src).stampsDueAt, "but the scan still sees the file").toBe(true);
  });
});
