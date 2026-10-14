import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every write that can change what the public site shows tells the site.
 *
 * The site rebuilds a page on request once told; a write here that forgets
 * to tell it leaves a sold or withdrawn listing visible for up to an hour
 * (the site's stale ceiling), which is exactly the failure the revalidate
 * door exists to end. So the rule is enforced on the actions rather than
 * remembered: each of these functions must call the notifier AFTER its write,
 * and a new action that touches a listing's public face must be added here.
 *
 * And it must call it BEFORE any follow-up that can throw (T-site-knock-order).
 * Next runs an `after()` callback even when the action throws later, but only
 * one that was already scheduled: a knock written after `await logEvent(...)`
 * is lost whenever the event insert fails, and the committed write then sits
 * on the site in its old form until the timers (lib/services/site-revalidate.ts,
 * notifySiteAfter). The second describe below pins that order.
 *
 * Source scan by design — the actions are exercised elsewhere; this pins
 * placement, which no behavioural test of a mocked client can. The unit
 * actions' knocks are ALSO proved by behaviour, through the real notifier, in
 * unit-site-revalidate.test.ts (T-unit-site-revalidate) — this list is where a
 * new action is remembered, that file is where a knock is seen.
 */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * The source with EVERY comment removed, by the TypeScript printer rather than
 * a regex: a trailing `// … await logEvent(` or a comment inside a block must
 * neither satisfy a placement rule nor break one. Strings are kept verbatim.
 */
const printer = ts.createPrinter({ removeComments: true });
function code(path: string): string {
  const text = readFileSync(path, "utf-8");
  return printer.printFile(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

const FILES = ["properties.ts", "media.ts", "units.ts", "unit-inheritance.ts", "settings.ts"];
const SOURCES: Record<string, string> = Object.fromEntries(FILES.map((f) => [f, code(join(here, f))]));

/** The body of one exported async function, up to the next export. */
function body(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

const NOTIFY = /notifySite(?:After|IfPublic)\(/;
// a row write, or the call of a function that writes in one transaction
// (the unit actions' 0141/0142 functions; applyPriceUplift's goes through
// recordPriceList)
const WRITE = /\.(update|insert|delete|rpc)\(|recordPriceList\(/;

/**
 * A follow-up that can THROW once the write has committed — the step a knock
 * scheduled after it is lost to:
 *  - an event write: logEvent / logEvents throw EventWriteError
 *    (lib/services/events.ts);
 *  - a score or health recompute: recomputeQualityScore throws on a failed
 *    read, and recomputeDealsFor is counted with it. recomputeQuietly is not:
 *    it catches, by name and by body (pinned below);
 *  - completeListingStatusChecks, which re-throws an unrecorded superseded line
 *    (lib/services/followup-tasks.ts).
 * An event write that opens its own `try {` is caught where it stands and is
 * not counted: the upload's per-file line, updatePropertySection's `record`.
 */
const THROWING_FOLLOW_UP =
  /(?<!\btry\s*\{\s*)\bawait\s+(?:logEvents?|recompute(?!Quietly\b)\w*|completeListingStatusChecks)\(/;

/**
 * [file, action, why it matters, and — only where the action has one — why it
 * also knocks on a path that writes nothing]
 */
const CASES: Array<[string, string, string, string?]> = [
  ["properties.ts", "updatePropertySection", "a section save can publish, withdraw, reprice or retitle"],
  ["properties.ts", "archiveProperty", "an archive removes a listing from the feed"],
  ["properties.ts", "restoreProperty", "a restore can put it back"],
  ["media.ts", "uploadPropertyMedia", "a photograph appears"],
  ["media.ts", "setMediaCover", "the cover changes"],
  ["media.ts", "setMediaAlt", "the alt text the site renders changes"],
  ["media.ts", "moveMedia", "the gallery order changes"],
  ["media.ts", "deleteMediaBulk", "photographs disappear"],
  // 0143: a repeat of a change whose answer (and knock) was lost is answered
  // by set_unit_status itself ("replayed" / "unchanged") and knocks AFTER it —
  // there is no longer a path that knocks without asking the database
  ["units.ts", "updateUnitStatus", "a published unit sells, reserves or returns to market"],
  ["units.ts", "applyPriceUplift", "a block's prices move"],
  ["units.ts", "applyUnitType", "a block's beds, areas and prices move"],
  // T-site-knock-order: eleven of the feed's columns (0088), on every unit
  // still inheriting the field
  ["unit-inheritance.ts", "syncInheritedField", "a project field moves onto its units"],
  // the feed's `area` is areas.name, on every listing in the area
  ["settings.ts", "renameArea", "an area's name is what every listing in it shows"],
];

describe("writes that change the public face tell the site, after the write", () => {
  for (const [file, fn, why, noWriteKnock] of CASES) {
    it(`${fn} — ${why}`, () => {
      const src = SOURCES[file]!;
      const b = body(src, fn);
      const write = b.search(WRITE);
      expect(write, `${fn} writes`).toBeGreaterThanOrEqual(0);
      expect(b.slice(write).search(NOTIFY), `${fn} calls the notifier after its write`).toBeGreaterThanOrEqual(0);
      const early = b.slice(0, write);
      const knockBefore = early.search(NOTIFY);
      if (!noWriteKnock) {
        expect(knockBefore, `${fn} notifies after its write, not before`).toBe(-1);
      } else {
        // only on a path that returns before the write is reached: the block
        // the early knock sits in reaches a `return` before it closes (any
        // later return — another refusal on the way to the write — does not count)
        expect(knockBefore, `${fn}: ${noWriteKnock}`).toBeGreaterThanOrEqual(0);
        expect(early.slice(knockBefore), `${fn}: the early knock's own block returns before writing`).toMatch(/^[^}]*\breturn\b/);
      }
    });
  }
});

describe("the knock is scheduled before any follow-up that can throw", () => {
  for (const [file, fn] of CASES) {
    it(fn, () => {
      const b = body(SOURCES[file]!, fn);
      const write = b.search(WRITE);
      expect(write, `${fn} writes`).toBeGreaterThanOrEqual(0);
      const afterWrite = b.slice(write);
      const knock = afterWrite.search(NOTIFY);
      expect(knock, `${fn} calls the notifier after its write`).toBeGreaterThanOrEqual(0);
      const followUp = afterWrite.search(THROWING_FOLLOW_UP);
      if (followUp === -1) return; // nothing after the write can swallow the knock
      const what = afterWrite.slice(followUp, followUp + 48).replace(/\s+/g, " ");
      expect(knock, `${fn}: "${what}" runs before the knock and can throw`).toBeLessThan(followUp);
    });
  }

  it("the classifier: what can throw counts, what catches does not", () => {
    for (const [snippet, throws] of [
      ["await logEvent(supabase, {", true],
      ["await logEvents(supabase, rows)", true],
      ["await recomputeQualityScore(supabase, id)", true],
      ["await recomputeDealsFor(supabase, { propertyId })", true],
      ["const closed = await completeListingStatusChecks(supabase, {", true],
      ["try {\n    await logEvent(supabase, {", false],
      ["await recomputeQuietly(supabase, id)", false],
      ["await refreshContainerScores(supabase, parent)", false],
      ["await record({", false],
    ] as const) {
      expect(THROWING_FOLLOW_UP.test(snippet), snippet).toBe(throws);
    }
  });

  it("recomputeQuietly, which the classifier lets pass, really catches", () => {
    const b = body(code(join(here, "..", "services", "quality-score.ts")), "recomputeQuietly");
    expect(b).toMatch(/\{\s*try\s*\{[\s\S]*\}\s*catch\b/);
  });
});
