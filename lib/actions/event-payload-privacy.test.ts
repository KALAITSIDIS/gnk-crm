import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
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
 * This reads every `payload` under lib/actions with the TypeScript parser. The
 * first version was a regex over `payload: { … }` literals and missed the
 * `merged` event for two reasons (DECISIONS T-merged-event-ids-only): its key,
 * `merged_contact_name`, only ENDS in a listed word, and the dropped e-mail
 * arrived through a spread — `...(… ? { dropped } : {})`, a shorthand with no
 * colon for the regex to find. It also only saw a payload that closed its
 * call. So now:
 *
 * - every key at any depth is read, shorthand and inside spreads included, and
 *   a key fails when a listed word is one of its `_`-separated parts —
 *   `merged_contact_name`, `buyer_email`, `phone_e164` — unless the key names
 *   SHAPE (`has_email`, `note_id`, `dropped_fields`), which is what the rule
 *   asks events to carry;
 * - a spread of anything but an inline object, a payload that is not one, and
 *   a computed key all fail: their keys cannot be read here, so each one is
 *   either rewritten as a literal or reviewed below with what it holds.
 *
 * What no key scan can read is the VALUE behind an identifier — `{ dropped }`
 * held the address as `{ email: "…" }`. The backfill now returns field names
 * by type, and merge-contacts-event-payload.test.ts drives the action and
 * searches what it logged for the fixture's own values.
 *
 * Staff are not clients: settings.ts (invites, agent names on assignment) is
 * out of scope, and names of agents in `to_name` are allowed.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = join(root, "lib", "actions");
const FORBIDDEN = [
  "note",
  "notes",
  "phone",
  "email",
  "message",
  "contact_name",
  "display_name",
  "first_name",
  "last_name",
  // a buyer's viewing feedback (T-viewing-feedback-shape). Whole `_` parts are
  // matched, so `liked` does not cover `disliked`: both are listed.
  "comment",
  "liked",
  "disliked",
];
/** A key that says a thing exists, points at it or proves it — never what it is. */
const SHAPE_PREFIXES = ["has_"];
const SHAPE_SUFFIXES = ["_id", "_ids", "_sha256", "_digest", "_count", "_fields"];
const OUT_OF_SCOPE = new Set(["settings.ts"]);

/**
 * The payload parts this scan cannot read, each reviewed for what it holds.
 * An entry that stops matching fails the last test, so this list cannot rot
 * into a set of permissions nobody remembers granting.
 */
const REVIEWED: Record<string, Record<string, string>> = {
  "contact-erasure.ts": {
    "payload: payload":
      "planContactErasure's event payload (lib/services/erasure.ts): counts and categories; erasure.test.ts asserts it carries no personal data",
  },
  "properties.ts": {
    "payload: overrideToLog": "declared `{ score: number; threshold: number } | null`",
  },
  "tasks.ts": {
    "...link": "declared `{ property_id?; contact_id?; deal_id? }` — ids only",
  },
  "unit-inheritance.ts": {
    "[column]": "the name of the unit column whose inheritance changed, never a client's field",
  },
};

interface Finding {
  line: number;
  text: string;
  why: string;
}

function namesAPerson(key: string): boolean {
  if (SHAPE_PREFIXES.some((p) => key.startsWith(p))) return false;
  if (SHAPE_SUFFIXES.some((s) => key.endsWith(s))) return false;
  const parts = key.split("_");
  return FORBIDDEN.some((word) => {
    const w = word.split("_");
    return parts.some((_, i) => w.every((seg, j) => parts[i + j] === seg));
  });
}

/** Every finding in one source file: keys that name a person, and parts it cannot read. */
function scanPayloads(source: string, fileName = "snippet.ts"): Finding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const at = (n: ts.Node, text: string, why: string) =>
    findings.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text, why });

  const unwrap = (e: ts.Expression): ts.Expression => {
    while (
      ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e)
    ) {
      e = e.expression;
    }
    // JSON.parse(JSON.stringify(x)) is a Json cast, not a transformation
    if (ts.isCallExpression(e) && e.expression.getText(sf) === "JSON.parse" && e.arguments[0]) {
      const inner = unwrap(e.arguments[0]);
      if (
        ts.isCallExpression(inner) &&
        inner.expression.getText(sf) === "JSON.stringify" &&
        inner.arguments[0]
      ) {
        return unwrap(inner.arguments[0]);
      }
    }
    return e;
  };

  /** the objects a spread may contribute: both arms of `?:`, the right of `&&` */
  const spreadBranches = (e: ts.Expression): ts.Expression[] => {
    e = unwrap(e);
    if (ts.isConditionalExpression(e)) {
      return [...spreadBranches(e.whenTrue), ...spreadBranches(e.whenFalse)];
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return spreadBranches(e.right);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        return [...spreadBranches(e.left), ...spreadBranches(e.right)];
      }
    }
    return [e];
  };

  const readValue = (v: ts.Expression) => {
    v = unwrap(v);
    if (ts.isObjectLiteralExpression(v)) readObject(v);
    else if (ts.isArrayLiteralExpression(v)) {
      for (const el of v.elements) if (ts.isObjectLiteralExpression(el)) readObject(el);
    }
  };

  const readObject = (obj: ts.ObjectLiteralExpression) => {
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
        if (ts.isComputedPropertyName(p.name) && !ts.isStringLiteralLike(p.name.expression)) {
          at(p, p.name.getText(sf), "a computed key — this scan cannot read it");
          continue;
        }
        const key = ts.isComputedPropertyName(p.name)
          ? (p.name.expression as ts.StringLiteralLike).text
          : ts.isStringLiteralLike(p.name)
            ? p.name.text
            : p.name.getText(sf);
        if (namesAPerson(key)) at(p, `${key}: …`, "names a person's data");
        if (ts.isPropertyAssignment(p)) readValue(p.initializer);
      } else if (ts.isSpreadAssignment(p)) {
        for (const b of spreadBranches(p.expression)) {
          if (ts.isObjectLiteralExpression(b)) readObject(b);
          else at(p, `...${b.getText(sf)}`, "spreads an object whose keys this scan cannot read");
        }
      } else {
        at(p, p.getText(sf).slice(0, 40), "not a plain property — this scan cannot read it");
      }
    }
  };

  const visit = (n: ts.Node) => {
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      n.name.getText(sf) === "payload" &&
      ts.isObjectLiteralExpression(n.parent)
    ) {
      const value = ts.isPropertyAssignment(n) ? unwrap(n.initializer) : n.name;
      if (ts.isObjectLiteralExpression(value)) readObject(value);
      else at(n, `payload: ${value.getText(sf)}`, "the payload is not an object this scan can read");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return findings;
}

const files = readdirSync(dir).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !OUT_OF_SCOPE.has(f),
);
const source = (file: string) => readFileSync(join(dir, file), "utf-8");

describe("the payload scan can see what it exists to catch", () => {
  const texts = (src: string) => scanPayloads(src).map((f) => f.text);

  it("catches the merged event as it was written until 2026-09-23", () => {
    const before = `
      await logEvent(supabase, {
        eventType: "merged",
        payload: {
          merged_contact_id: duplicateId,
          merged_contact_name: duplicate.display_name,
          ...(Object.keys(dropped).length > 0 ? { dropped } : {}),
        },
      });`;
    expect(texts(before)).toContain("merged_contact_name: …");
  });

  it("catches a person's data however the key is written", () => {
    expect(texts(`x({ payload: { email } })`), "shorthand").toEqual(["email: …"]);
    expect(texts(`x({ payload: { buyer_email: e } })`), "a suffix").toEqual(["buyer_email: …"]);
    expect(texts(`x({ payload: { phone_e164: p } })`), "a prefix").toEqual(["phone_e164: …"]);
    expect(texts(`x({ payload: { "notes": n } })`), "a quoted key").toEqual(["notes: …"]);
    expect(texts(`x({ payload: { a: { b: { display_name: n } } } })`), "nested").toEqual([
      "display_name: …",
    ]);
    expect(texts(`x({ payload: { ...(c ? { phone } : {}) } })`), "inside a spread").toEqual([
      "phone: …",
    ]);
    expect(texts(`x({ payload: { first_name: f }, eventType: "t" })`), "not last").toEqual([
      "first_name: …",
    ]);
    expect(
      texts(`x({ payload: JSON.parse(JSON.stringify({ message: m })) })`),
      "through the Json cast",
    ).toEqual(["message: …"]);
  });

  // T-viewing-feedback-shape: the spread was replaced by explicit keys, which a
  // spread-only rule would have let straight back in as literal keys
  it("catches a buyer's feedback words as literal keys — `liked` does not cover `disliked`", () => {
    expect(texts(`x({ payload: { viewing_id: v, liked: l, disliked: d, comment: c } })`)).toEqual([
      "liked: …",
      "disliked: …",
      "comment: …",
    ]);
    expect(texts(`x({ payload: { buyer_comment: c } })`), "a prefix").toEqual(["buyer_comment: …"]);
    expect(texts(`x({ payload: { viewing_id: v, reference: r, rating: 4 } })`), "the new shape").toEqual([]);
  });

  it("refuses what it cannot read rather than passing it", () => {
    expect(texts(`x({ payload: { id, ...dropped } })`)).toEqual(["...dropped"]);
    expect(texts(`x({ payload: { ...(c ? extra : {}) } })`)).toEqual(["...extra"]);
    expect(texts(`x({ payload: built })`)).toEqual(["payload: built"]);
    expect(texts(`x({ payload })`)).toEqual(["payload: payload"]);
    expect(texts(`x({ payload: { [field]: v } })`)).toEqual(["[field]"]);
  });

  it("lets shape through — flags, ids, digests, field names", () => {
    expect(
      texts(`x({ payload: {
        has_email: true, has_phone: false, note_id: n, note_sha256: d,
        merged_contact_id: id, dropped_fields: ["email"], to_name: agent, contact_id: c,
      } })`),
    ).toEqual([]);
  });
});

describe("event payloads written by actions", () => {
  it("scans the files that write events", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    it(`${file} carries no client identifier or free text by value`, () => {
      const reviewed = REVIEWED[file] ?? {};
      const offenders = scanPayloads(source(file), file)
        .filter((f) => !(f.text in reviewed))
        .map((f) => `${file}:${f.line} ${f.text} — ${f.why}`);
      expect(offenders, `${file} writes a client's data into the chain`).toEqual([]);
    });
  }

  it("every reviewed exception still exists — a stale one is removed, not kept", () => {
    const stale = Object.entries(REVIEWED).flatMap(([file, entries]) => {
      const found = new Set(scanPayloads(source(file), file).map((f) => f.text));
      return Object.keys(entries)
        .filter((text) => !found.has(text))
        .map((text) => `${file}: ${text}`);
    });
    expect(stale).toEqual([]);
  });
});
