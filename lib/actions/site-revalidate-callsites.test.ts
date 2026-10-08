import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
 * Source scan by design — the actions are exercised elsewhere; this pins
 * placement, which no behavioural test of a mocked client can. The unit
 * actions' knocks are ALSO proved by behaviour, through the real notifier, in
 * unit-site-revalidate.test.ts (T-unit-site-revalidate) — this list is where a
 * new action is remembered, that file is where a knock is seen.
 */
const here = dirname(fileURLToPath(import.meta.url));
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const properties = strip(readFileSync(join(here, "properties.ts"), "utf-8"));
const media = strip(readFileSync(join(here, "media.ts"), "utf-8"));
const units = strip(readFileSync(join(here, "units.ts"), "utf-8"));
const SOURCES: Record<string, string> = { "properties.ts": properties, "media.ts": media, "units.ts": units };

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
