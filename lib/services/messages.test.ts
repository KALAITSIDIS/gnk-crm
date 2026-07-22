import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import el from "@/messages/el.json";
import ru from "@/messages/ru.json";

/**
 * Locale files are only exercised at render time, and Phase 1 ships English
 * (i18n/request.ts pins defaultLocale), so a malformed el/ru message would sit
 * undetected until the locale is switched on. These tests compile every
 * message in every locale and pin key parity against English.
 */

const locales = { en, el, ru } as const;

/** Dot-paths of every leaf string in a message tree. */
function leafPaths(node: unknown, prefix = ""): string[] {
  if (typeof node === "string") return [prefix];
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) =>
      leafPaths(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [];
}

/** Superset of every placeholder used across the message files. */
const SAMPLE_PARAMS = {
  count: 2,
  days: 3,
  status: "OK",
  when: "21 Jul 2026, 09:14",
  hash: "abc123",
  message: "detail",
  max: 500,
  // events namespace
  amount: "€100.000",
  section: "profile",
  from: "New",
  to: "Qualified",
  reason: "budget",
  name: "A. Name",
  channel: "phone",
  holder: "A. Agent",
  code: "K12",
  title: "Doc title",
  email: "a@b.com",
  role: "agent",
  stage: "Viewing",
  direction: "up",
  ok: "yes",
  date: "2026-07-20",
  stars: "★★★",
  note: "a note",
  retention: "2031-07-21",
  ref: "GNK-PAF-0001",
  file: "photo.jpg",
  score: 40,
  threshold: 60,
};

describe("locale message files", () => {
  const enPaths = leafPaths(en).sort();

  it("English defines the reports namespace", () => {
    expect(enPaths.some((p) => p.startsWith("reports."))).toBe(true);
  });

  for (const [name, messages] of Object.entries(locales)) {
    it(`${name}: has exactly the same keys as English`, () => {
      expect(leafPaths(messages).sort()).toEqual(enPaths);
    });

    it(`${name}: every message compiles and interpolates`, () => {
      // next-intl swallows compile/format errors and falls back to the key
      // path, so without this onError a malformed message passes silently.
      const t = createTranslator({
        locale: name,
        messages,
        onError: (error) => {
          throw error;
        },
      });
      for (const path of leafPaths(messages)) {
        const out = t(path as never, SAMPLE_PARAMS as never);
        expect(out, `${name}:${path} produced nothing`).toBeTruthy();
        // an unresolved placeholder leaves braces behind
        expect(String(out), `${name}:${path} left an unresolved placeholder`).not.toMatch(
          /[{}]/,
        );
      }
    });
  }
});
