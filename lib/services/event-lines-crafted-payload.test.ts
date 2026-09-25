import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import el from "@/messages/el.json";
import ru from "@/messages/ru.json";
import { ENTITY_TYPES, describeEvent, type EventTranslator } from "./events";

/**
 * No registered timeline line may throw on a crafted payload
 * (T-rescheduled-line-crash).
 *
 * Any active org member may insert any event with any payload (events_insert,
 * 0071), and `describeEvent` renders the property Activity tab, the admin
 * dashboard feed and the commission evidence report. A line that throws takes
 * the whole page down for everyone: `"★".repeat(1e9)` did it for
 * viewing_feedback (T-viewing-feedback-shape), `formatDateTime("x")` for
 * rescheduled.
 *
 * The payload here is a Proxy that answers EVERY key with one crafted value,
 * so each line is exercised on exactly the fields it reads, without this file
 * knowing what they are. The values are the ones a jsonb payload can actually
 * hold — strings, finite numbers, booleans, null, objects, arrays — so no
 * NaN or Infinity as numbers, but "NaN" and "Infinity" as strings. Every
 * registered event type × every entity type × every locale, through the real
 * translators.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(join(root, "lib", "services", "events.ts"), "utf-8");

/** The EVENT_LINES keys, read from the source so a new line joins the sweep by itself. */
function registeredTypes(): string[] {
  const start = source.indexOf("const EVENT_LINES");
  const end = source.indexOf("\n};\n", start);
  if (start < 0 || end < 0) throw new Error("EVENT_LINES block not found — update this test's reader");
  const block = source.slice(start, end);
  return [...new Set([...block.matchAll(/^ {2}([a-z][a-z0-9_]*):/gm)].map((m) => m[1]))];
}

const CRAFTED: ReadonlyArray<readonly [string, unknown]> = [
  ["a word", "x"],
  ["an empty string", ""],
  ["whitespace", "   "],
  ["an impossible date", "2026-13-45T99:99:00Z"],
  ['"NaN"', "NaN"],
  ['"Infinity"', "Infinity"],
  ['"-1"', "-1"],
  ["a 100k-character string", "x".repeat(100_000)],
  ["the largest double", 1.7976931348623157e308],
  ["the most negative double", -1.7976931348623157e308],
  ["a billion", 1e9],
  ["minus one", -1],
  ["zero", 0],
  ["a fraction", 2.5],
  ["a tiny number", 1e-300],
  ["true", true],
  ["false", false],
  ["null", null],
  ["an empty object", {}],
  ["a nested object", { from: "x", to: { a: [1] } }],
  ["an empty array", []],
  ["an array", ["x", 1, null]],
  // found by the review: JSON.parse makes these OWN data properties, and
  // Number() / String() / a template literal on them throw TypeError
  ["an object with its own toString", JSON.parse('{"toString":0}')],
  ["an object with toString and valueOf", JSON.parse('{"toString":0,"valueOf":0}')],
  // String([[[…]]]) recurses once per level: a deep enough array overflows the stack
  ["a deeply nested array", JSON.parse("[".repeat(5000) + "]".repeat(5000))],
  // a key that is absent reads as undefined
  ["an absent value", undefined],
  // a string used to look something up in a map reaches Object.prototype
  ['"constructor"', "constructor"],
  ['"__proto__"', "__proto__"],
  ['"toString"', "toString"],
  ['"hasOwnProperty"', "hasOwnProperty"],
];

/**
 * The payload keys a line compares with a string literal before it decides
 * what to read next — `reason`, `kind`, `action` … — and every literal they
 * are compared with, both read from the source. A uniform crafted value never
 * equals "availability", so without these the branches behind a discriminator
 * (and the fields only they read) were never reached.
 */
function discriminators(): { keys: Set<string>; literals: string[] } {
  const keys = new Set<string>();
  for (const m of source.matchAll(/\bp\.([a-z_]+)\s*(?:===|!==)\s*"/g)) keys.add(m[1]);
  for (const m of source.matchAll(/asText\(p\.([a-z_]+)\)\s*(?:===|!==)\s*"/g)) keys.add(m[1]);
  for (const m of source.matchAll(/const ([a-zA-Z]+) = asText\(p\.([a-z_]+)\)/g)) {
    if (new RegExp(`\\b${m[1]}\\s*(?:===|!==)\\s*"`).test(source)) keys.add(m[2]);
  }
  const literals = [...new Set([...source.matchAll(/(?:===|!==)\s*"([^"]+)"/g)].map((m) => m[1]))];
  return { keys, literals };
}

/** A payload whose every key reads as `value`. */
const everyKey = (value: unknown) =>
  new Proxy({} as Record<string, unknown>, {
    get: (_t, key) => (typeof key === "string" ? value : undefined),
    has: () => true,
  });

const translators = Object.entries({ en, el, ru }).map(([locale, messages]) => {
  const tr = createTranslator({
    locale,
    messages,
    namespace: "events",
    // next-intl's default onError logs every missing value; the assertion here
    // is only that nothing THROWS out of describeEvent
    onError: () => {},
  });
  return [locale, ((key, values) => tr(key as never, values as never)) as EventTranslator] as const;
});

/**
 * A payload whose keys each read as a DIFFERENT crafted value, rotated by
 * `shift` — so a line that only breaks on a mix (one real date and one word)
 * is reached too, not just one value in every field.
 */
const mixedKeys = (shift: number) =>
  new Proxy({} as Record<string, unknown>, {
    get: (_t, key) => {
      if (typeof key !== "string") return undefined;
      let h = shift;
      for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return CRAFTED[h % CRAFTED.length][1];
    },
    has: () => true,
  });

/**
 * describeEvent's last-resort guard (T-rescheduled-line-crash) turns a throwing
 * line into the bare event type and logs "timeline line failed:". That keeps
 * a page up, but it must never be how THIS sweep passes: every call below
 * that reached the guard is a finding.
 */
let guardHits: string[] = [];
beforeEach(() => {
  guardHits = [];
  vi.spyOn(console, "error").mockImplementation((msg: unknown, detail?: unknown) => {
    if (msg === "timeline line failed:") guardHits.push(JSON.stringify(detail));
  });
});
afterEach(() => vi.restoreAllMocks());

function sweep(
  payloadFor: () => unknown,
  opts: {
    types?: readonly string[];
    entities?: readonly string[];
    translators?: ReadonlyArray<readonly [string, EventTranslator]>;
  } = {},
): string[] {
  const found: string[] = [];
  for (const event_type of opts.types ?? registeredTypes()) {
    for (const entity_type of opts.entities ?? ENTITY_TYPES) {
      for (const [locale, t] of opts.translators ?? translators) {
        guardHits = [];
        try {
          const line = describeEvent({ entity_type, event_type, payload: payloadFor() as never }, t);
          if (typeof line !== "string") found.push(`${event_type}/${entity_type}/${locale}: returned ${typeof line}`);
          if (guardHits.length) found.push(`${event_type}/${entity_type}/${locale}: fell into the guard ${guardHits[0]}`);
        } catch (err) {
          found.push(`${event_type}/${entity_type}/${locale}: ${(err as Error).name}: ${(err as Error).message}`);
        }
      }
    }
  }
  // one line per type is enough to name the offender
  return [...new Set(found.map((s) => s.split("/")[0]))].map((ty) => found.find((s) => s.startsWith(`${ty}/`))!);
}

describe("no timeline line throws on a crafted payload", () => {
  const types = registeredTypes();

  it("reads the registry (a broken reader must not pass as an empty sweep)", () => {
    expect(types.length).toBeGreaterThan(60);
    expect(types).toEqual(expect.arrayContaining(["rescheduled", "viewing_feedback", "stage_changed", "imported"]));
  });

  it.each(CRAFTED)("every registered line survives %s in every field", (_name, value) => {
    expect(sweep(() => everyKey(value))).toEqual([]);
  });

  it.each(CRAFTED.map((_, i) => [i] as const))("every registered line survives mixed crafted fields (rotation %i)", (shift) => {
    expect(sweep(() => mixedKeys(shift))).toEqual([]);
  });

  it.each([
    ["an empty object", {}],
    ["null", null],
    ["an array", []],
    ["a string", "payload"],
  ] as const)("every registered line survives %s as the whole payload", (_name, payload: unknown) => {
    expect(sweep(() => payload)).toEqual([]);
  });

  describe("behind a discriminator", () => {
    const { keys, literals } = discriminators();

    it("reads the discriminators (a broken reader must not pass as an empty sweep)", () => {
      expect([...keys]).toEqual(expect.arrayContaining(["kind", "reason", "action"]));
      expect(literals).toEqual(expect.arrayContaining(["availability", "installment_due"]));
      expect(literals.length).toBeGreaterThan(15);
    });

    // the discriminator keys answer the literal, every other key a crafted
    // value; English and the entities lines branch on, to keep this fast (the
    // uniform sweeps above cover every entity and locale)
    const ENTITIES = ["property", "contact", "deal", "offer", "task", "lead", "share_link", "viewing"];
    it.each(literals.map((l) => [l] as const))("every line survives %s with crafted fields beside it", (literal) => {
      const found: string[] = [];
      for (const [, value] of CRAFTED) {
        const payload = () =>
          new Proxy({} as Record<string, unknown>, {
            get: (_t, key) => (typeof key !== "string" ? undefined : keys.has(key) ? literal : value),
            has: () => true,
          });
        found.push(...sweep(payload, { entities: ENTITIES, translators: [translators[0]] }));
      }
      expect([...new Set(found)]).toEqual([]);
    });
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "prototype"])(
    "an event_type or entity_type named %s reads as a string, never an object, and never reaches the guard",
    (name) => {
      for (const [, t] of translators) {
        for (const e of [
          { entity_type: "property", event_type: name, payload: { from: "x" } },
          { entity_type: name, event_type: "stage_changed", payload: { from: "a", to: "b" } },
          { entity_type: name, event_type: name, payload: {} },
        ]) {
          guardHits = [];
          const line = describeEvent(e as never, t);
          expect(typeof line, `${e.entity_type}/${e.event_type}`).toBe("string");
          expect(guardHits, `${e.entity_type}/${e.event_type}`).toEqual([]);
          // nothing of Object.prototype leaks into the text either (a prefix
          // looked up by name would print a function's source)
          expect(line, `${e.entity_type}/${e.event_type}`).not.toMatch(/function|native code|\[object|=>/);
        }
      }
    },
  );

  it("a real date beside a word — the mix that uniform values cannot reach — reads bare", () => {
    const [, t] = translators[0];
    expect(describeEvent({ entity_type: "viewing", event_type: "rescheduled", payload: { from: "2026-09-25T10:00:00Z", to: "x" } }, t)).toBe(
      "Viewing rescheduled",
    );
    expect(guardHits).toEqual([]);
  });

  it("an unregistered type and a non-object payload fall back without throwing", () => {
    const [, t] = translators[0];
    for (const payload of [null, "text", 7, [], { a: 1 }]) {
      expect(() => describeEvent({ entity_type: "property", event_type: "never_registered", payload: payload as never }, t)).not.toThrow();
    }
  });
});
