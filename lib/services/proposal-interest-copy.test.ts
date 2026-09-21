import { describe, expect, it } from "vitest";
import { PROPOSAL_INTEREST_ERROR_CODES } from "@/lib/validators/proposal-interest";
import {
  INTEREST_COPY,
  INTEREST_LOCALES,
  VISITOR_PROBLEM_CODES,
  interestProblemText,
} from "./proposal-interest-copy";

/**
 * The proposal page's own words (0106; audit 2026-09-22, finding 2). Before
 * this the page showed whatever English sentence the route's validator
 * produced — a Greek or Russian buyer who left the name blank, or mistyped
 * an address, read "A name is required." in a page that was otherwise in
 * their language. Now the route answers with a code and the page picks the
 * sentence. This file pins that every code a VISITOR can cause has a
 * sentence in every locale, that no locale falls back to English for one,
 * and that a code the page does not know lands on the generic sentence
 * rather than on a blank or a crash.
 */
describe("every visitor-caused code speaks every locale", () => {
  it.each(INTEREST_LOCALES)("%s", (locale) => {
    for (const code of VISITOR_PROBLEM_CODES) {
      const text = interestProblemText(locale, code);
      expect(text, `${locale}/${code}`).toBeTruthy();
      if (locale !== "en") {
        expect(text, `${locale}/${code} must not be the English sentence`).not.toBe(interestProblemText("en", code));
      }
    }
  });

  it("the three locales carry the same keys, so a new sentence cannot be added to one and forgotten in the others", () => {
    const keys = (l: (typeof INTEREST_LOCALES)[number]) => Object.keys(INTEREST_COPY[l]).sort();
    expect(keys("el")).toEqual(keys("en"));
    expect(keys("ru")).toEqual(keys("en"));
    const problems = (l: (typeof INTEREST_LOCALES)[number]) => Object.keys(INTEREST_COPY[l].problems).sort();
    expect(problems("el")).toEqual(problems("en"));
    expect(problems("ru")).toEqual(problems("en"));
  });
});

describe("a code the page does not know", () => {
  it("is the generic sentence in that locale — never English, never empty, never a throw", () => {
    for (const locale of INTEREST_LOCALES) {
      expect(interestProblemText(locale, "invalid_token")).toBe(INTEREST_COPY[locale].error);
      expect(interestProblemText(locale, "something_new_from_a_later_deploy")).toBe(INTEREST_COPY[locale].error);
      expect(interestProblemText(locale, undefined)).toBe(INTEREST_COPY[locale].error);
    }
  });

  it("every code the validator can emit is either a visitor sentence or deliberately generic", () => {
    // a code that reaches the page from the route must be one of these two;
    // this fails the day a new validator code is added without a decision here
    const visitor = new Set<string>(VISITOR_PROBLEM_CODES);
    const generic = new Set<string>(["invalid_token", "property_reference_invalid", "idempotency_key_invalid", "invalid_request"]);
    for (const code of PROPOSAL_INTEREST_ERROR_CODES) {
      expect(visitor.has(code) || generic.has(code), `${code} needs a decision: visitor sentence or generic`).toBe(true);
    }
  });
});
