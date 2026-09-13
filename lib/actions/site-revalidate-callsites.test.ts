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
 * placement, which no behavioural test of a mocked client can.
 */
const here = dirname(fileURLToPath(import.meta.url));
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const properties = strip(readFileSync(join(here, "properties.ts"), "utf-8"));
const media = strip(readFileSync(join(here, "media.ts"), "utf-8"));

/** The body of one exported async function, up to the next export. */
function body(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

const NOTIFY = /notifySite(?:After|IfPublic)\(/;
const WRITE = /\.(update|insert|delete)\(/;

const CASES: Array<[string, string, string]> = [
  ["properties.ts", "updatePropertySection", "a section save can publish, withdraw, reprice or retitle"],
  ["properties.ts", "archiveProperty", "an archive removes a listing from the feed"],
  ["properties.ts", "restoreProperty", "a restore can put it back"],
  ["media.ts", "uploadPropertyMedia", "a photograph appears"],
  ["media.ts", "setMediaCover", "the cover changes"],
  ["media.ts", "setMediaAlt", "the alt text the site renders changes"],
  ["media.ts", "moveMedia", "the gallery order changes"],
  ["media.ts", "deleteMediaBulk", "photographs disappear"],
];

describe("writes that change the public face tell the site, after the write", () => {
  for (const [file, fn, why] of CASES) {
    it(`${fn} — ${why}`, () => {
      const src = file === "properties.ts" ? properties : media;
      const b = body(src, fn);
      const write = b.search(WRITE);
      const notify = b.search(NOTIFY);
      expect(write, `${fn} writes`).toBeGreaterThanOrEqual(0);
      expect(notify, `${fn} calls the notifier`).toBeGreaterThanOrEqual(0);
      expect(notify, `${fn} notifies after its write, not before`).toBeGreaterThan(write);
    });
  }
});
