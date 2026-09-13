import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Nothing about a client goes into the event log by value (audit SEC-03).
 *
 * Events are hash-chained and never updated, and erasure leaves them alone by
 * design (0017). Until 2026-09-13 a contact's phone and email entered its
 * `created` event, a linked contact's name entered `contact_linked`, and every
 * logged conversation entered the chain verbatim — so an Article 17 request
 * left the person's number, address and the desk's notes about them readable
 * for ever. Identifiers and text now live in mutable rows (`contacts`,
 * `interaction_notes`) and the event carries an id and a digest: the chain
 * still proves what was written and when, and erasure can blank the row.
 *
 * This scans every `payload: { ... }` literal under lib/actions for the keys
 * that carry a person. Staff are not clients: settings.ts (invites, agent
 * names on assignment) is out of scope, and names of agents in `to_name`
 * are allowed.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = join(root, "lib", "actions");
const FORBIDDEN = ["note", "phone", "email", "contact_name", "display_name", "message"];
const OUT_OF_SCOPE = new Set(["settings.ts"]);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("event payloads written by actions", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !OUT_OF_SCOPE.has(f));
  it("scans the files that write events", () => {
    expect(files.length).toBeGreaterThan(20);
  });
  for (const file of files) {
    it(`${file} carries no client identifier or free text by value`, () => {
      const src = stripComments(readFileSync(join(dir, file), "utf-8"));
      const offenders: string[] = [];
      for (const m of src.matchAll(/payload:\s*\{([\s\S]*?)\}\s*,?\s*\n\s*\}\)/g)) {
        const body = m[1]!;
        for (const key of FORBIDDEN) {
          if (new RegExp(`(^|[\\s{,])${key}\\s*:`).test(body)) offenders.push(`${key}: … in ${body.trim().slice(0, 60)}`);
        }
      }
      expect(offenders, `${file} writes a client's data into the chain`).toEqual([]);
    });
  }
});
