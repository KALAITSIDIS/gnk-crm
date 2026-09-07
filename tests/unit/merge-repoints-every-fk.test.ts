import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `mergeContacts` hand-lists the tables whose rows follow a duplicate onto the
 * primary. A table added later and forgotten there fails SILENTLY: the
 * duplicate is archived rather than deleted, so the orphaned row is valid,
 * raises nothing, and simply stops appearing on any screen.
 *
 * That is not hypothetical. `buyer_requirements`, `reservations` and
 * `share_links` were all missing from the list until 2026-09-07 — merging a
 * duplicate quietly took a buyer's saved searches out of matching.
 *
 * So the list is re-derived here from the migrations rather than trusted. This
 * catches the NEXT one, which the e2e spec cannot: that spec can only assert
 * about tables someone remembered to seed.
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const ACTION = join(process.cwd(), "lib", "actions", "merge-contacts.ts");

/**
 * Columns that reference `contacts` but are deliberately NOT repointed, each
 * with the reason. Anything else must appear in the action.
 */
const EXEMPT: Record<string, string> = {
  // handled by its own dedicated update: contacts previously merged into the
  // duplicate follow it to the primary, and the duplicate's own pointer is set
  // when it is archived.
  "contacts.merged_into_id": "the merge pointer itself",
};

interface Fk {
  table: string;
  column: string;
}

/** Every `<col> uuid ... references contacts(...)` across the applied migrations. */
function foreignKeysToContacts(): Fk[] {
  const found = new Map<string, Fk>();
  const dropped = new Set<string>();
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");

    // columns declared inside a CREATE TABLE body
    for (const m of sql.matchAll(
      /create table (?:if not exists )?(?:public\.)?([a-z_]+)\s*\(([\s\S]*?)\n\);/gi,
    )) {
      const table = m[1];
      for (const c of m[2].matchAll(
        /^\s*([a-z_]+)\s+uuid\b[^,\n]*references\s+(?:public\.)?contacts\b/gim,
      )) {
        found.set(`${table}.${c[1]}`, { table, column: c[1] });
      }
    }

    // columns bolted on later
    for (const m of sql.matchAll(
      /alter table (?:only )?(?:public\.)?([a-z_]+)\s+add column (?:if not exists )?([a-z_]+)\s+uuid\b[^;]*references\s+(?:public\.)?contacts\b/gi,
    )) {
      found.set(`${m[1]}.${m[2]}`, { table: m[1], column: m[2] });
    }

    // ...and columns taken away again
    for (const m of sql.matchAll(
      /alter table (?:only )?(?:public\.)?([a-z_]+)\s+drop column (?:if exists )?([a-z_]+)/gi,
    )) {
      dropped.add(`${m[1]}.${m[2]}`);
    }
  }

  for (const key of dropped) found.delete(key);
  return [...found.entries()]
    .filter(([key]) => !(key in EXEMPT))
    .map(([, fk]) => fk)
    .sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}

describe("mergeContacts repoints every reference to a contact", () => {
  const action = readFileSync(ACTION, "utf8");
  const fks = foreignKeysToContacts();

  it("finds the schema's references at all — a silent zero would pass everything", () => {
    expect(fks.length).toBeGreaterThan(8);
    expect(fks.map((f) => `${f.table}.${f.column}`)).toContain("buyer_requirements.contact_id");
  });

  it.each(fks.map((f) => [`${f.table}.${f.column}`, f] as const))(
    "%s is moved onto the primary",
    (name, fk) => {
      // The action reads `.from("<table>").update({ <column>: primaryId }).eq("<column>", duplicateId)`,
      // which prettier may wrap across lines — so match on the pair, not the phrasing.
      const fromTable = new RegExp(`\\.from\\(\\s*"${fk.table}"\\s*\\)`);
      const movesColumn = new RegExp(`${fk.column}:\\s*primaryId`);
      expect(
        fromTable.test(action) && movesColumn.test(action),
        `${name} references contacts but mergeContacts never repoints it. A row left ` +
          `on the duplicate is not deleted — it is stranded on an archived contact where ` +
          `nothing shows it. Add it to the repoint list in lib/actions/merge-contacts.ts, ` +
          `or add it to EXEMPT here with the reason it must not move.`,
      ).toBe(true);
    },
  );
});
