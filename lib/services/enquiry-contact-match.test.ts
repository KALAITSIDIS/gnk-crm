import { describe, expect, it } from "vitest";
import { LEAD_MESSAGE_REDACTED } from "./erasure";
import {
  SUGGESTION_CANDIDATE_LIMIT,
  SUGGESTION_HISTORY_LIMIT,
  ambiguityNote,
  buildSuggestions,
  enquiryMatchKeys,
  evidenceLines,
  historySummary,
  matchEvidence,
  matchedOn,
  normalizeEmailForMatch,
  reasonLabel,
  suggestionHeading,
  type CandidateRow,
  type SuggestionHistoryItem,
} from "./enquiry-contact-match";

/**
 * The deterministic half of "Possible existing contact" (T-enquiry-contact-
 * suggestions): what a website enquiry can be matched on, whether a contact
 * matches it and why, and how several candidates are ordered and explained.
 * No fuzzy names, no scores — an e-mail or a phone either is the same or is
 * not, after the normalisation every contact write already applies.
 */
const block = (lines: string[], body = "Hello") => ["Website enquiry", ...lines, "", body].join("\n");

const contact = (over: Partial<CandidateRow> & { id: string }): CandidateRow => ({
  display_name: `Contact ${over.id}`,
  email: null,
  phone_e164: null,
  additional_phones: [],
  history: [],
  ...over,
});

const lead = (id: string, receivedAt: string): SuggestionHistoryItem => ({
  id,
  received_at: receivedAt,
  status: "contacted",
  assigned_agent_id: null,
  property: null,
});

describe("normalizeEmailForMatch", () => {
  it("lower-cases and trims, like every contact write path", () => {
    expect(normalizeEmailForMatch("  Maria.Georgiou@Example.INVALID ")).toBe("maria.georgiou@example.invalid");
  });

  it("keeps the characters real addresses carry", () => {
    expect(normalizeEmailForMatch("first_last+tag@sub-domain.example.invalid")).toBe(
      "first_last+tag@sub-domain.example.invalid",
    );
  });

  it("refuses what cannot be a stored contact e-mail or would break the query filter", () => {
    for (const bad of ["", "   ", "no-at-sign", "a b@example.invalid", 'a"b@example.invalid', "a,b@example.invalid", "a(b)@example.invalid", "a\\b@example.invalid", "@example.invalid", "a@"]) {
      expect(normalizeEmailForMatch(bad), bad).toBeNull();
    }
    expect(normalizeEmailForMatch(null)).toBeNull();
    expect(normalizeEmailForMatch(undefined)).toBeNull();
  });

  it("refuses an address longer than any real one (254) — it would only lengthen the lookup URL", () => {
    const local = "a".repeat(64);
    const ok = `${local}@${"b".repeat(254 - 65 - ".invalid".length)}.invalid`;
    expect(ok).toHaveLength(254);
    expect(normalizeEmailForMatch(ok)).toBe(ok);
    expect(normalizeEmailForMatch(`x${ok}`)).toBeNull();
  });
});

describe("enquiryMatchKeys", () => {
  it("reads the e-mail and the phone as E.164 from the header the door writes", () => {
    expect(enquiryMatchKeys(block(["Name: Maria", "Email: Maria@Example.invalid", "Phone: +357 99 123456"]))).toEqual({
      kind: "keys",
      keys: { email: "maria@example.invalid", phoneE164: "+35799123456" },
    });
  });

  it("treats the formats a visitor types for one Cyprus number as one number", () => {
    for (const typed of ["+357 99 123456", "0035799123456", "99123456", "99 123 456", "(+357) 99-123-456"]) {
      const r = enquiryMatchKeys(block(["Name: Maria", `Phone: ${typed}`]));
      expect(r, typed).toEqual({ kind: "keys", keys: { email: null, phoneE164: "+35799123456" } });
    }
  });

  it("keeps a usable e-mail when the phone does not normalise, and the reverse", () => {
    expect(enquiryMatchKeys(block(["Name: A", "Email: a@example.invalid", "Phone: call me"]))).toEqual({
      kind: "keys",
      keys: { email: "a@example.invalid", phoneE164: null },
    });
    expect(enquiryMatchKeys(block(["Name: A", "Phone: 99123456"]))).toEqual({
      kind: "keys",
      keys: { email: null, phoneE164: "+35799123456" },
    });
  });

  it("says there is nothing to match on when neither identifier is usable", () => {
    expect(enquiryMatchKeys(block(["Name: A", "Phone: 12345"]))).toEqual({ kind: "no_identifiers" });
    expect(enquiryMatchKeys(block(["Name: A", "Email: not an address", "About: PAF0001"]))).toEqual({ kind: "no_identifiers" });
  });

  it("a header with NO e-mail or phone line is unreadable, not 'nothing to match' — the door never writes one", () => {
    // T-enquiry-identity-single-line: the door has refused an enquiry without a
    // way to reply since 0084, so such a header means the contact lines were
    // pushed below it (a blank line inside the name) — the desk decides
    expect(enquiryMatchKeys(block(["Name: A", "About: PAF0001"]))).toEqual({ kind: "unreadable" });
  });

  it("an ambiguous header is unreadable — the audit's case A no longer matches on the injected address", () => {
    const caseA = block(["Name: Example Buyer", "Email: buyer@example.invalid", "Phone: +35799123456", "Email: other@x.invalid"], "Please contact me.");
    expect(enquiryMatchKeys(caseA)).toEqual({ kind: "unreadable" });
    const caseB = block(["Name: Example", "extra", "extra", "extra", "extra", "Email: buyer@example.invalid", "Phone: +35799123456"]);
    expect(enquiryMatchKeys(caseB)).toEqual({ kind: "unreadable" });
  });

  it("matches on the header's own e-mail and phone when the visitor's words look like a header", () => {
    const stored = block(["Name: A", "Email: A@Example.invalid", "Phone: 99 123456"], "Email: decoy@example.invalid\nPhone: +44 20 7946 0958");
    expect(enquiryMatchKeys(stored)).toEqual({ kind: "keys", keys: { email: "a@example.invalid", phoneE164: "+35799123456" } });
  });

  it("reads nothing from a redacted, a desk-typed or an empty message — erased details are never rebuilt", () => {
    expect(enquiryMatchKeys(LEAD_MESSAGE_REDACTED)).toEqual({ kind: "unreadable" });
    expect(enquiryMatchKeys("Called about the villa, email m@example.invalid")).toEqual({ kind: "unreadable" });
    expect(enquiryMatchKeys(null)).toEqual({ kind: "unreadable" });
    expect(enquiryMatchKeys("")).toEqual({ kind: "unreadable" });
  });

  it("takes only what the header's line says — an injected line can mislead, never break the filter", () => {
    // a visitor controls every header value; a name carrying a line break
    // becomes an "Email:" line. The key is still a well-formed address, and
    // one with a quote or a comma is refused outright.
    expect(enquiryMatchKeys(block(["Name: A", 'Email: x"),id.not.is.null,email.in.("y@example.invalid']))).toEqual({
      kind: "no_identifiers",
    });
  });

  it("never takes an identifier from the visitor's own words below the header", () => {
    // no contact line in the header: unreadable (see above) — and still
    // nothing is taken from the words
    expect(enquiryMatchKeys(block(["Name: A"], "Email: someone-else@example.invalid\nPhone: 99123456"))).toEqual({
      kind: "unreadable",
    });
  });
});

describe("matchEvidence / matchedOn", () => {
  const keys = { email: "m@example.invalid", phoneE164: "+35799123456" };

  it("matches the e-mail exactly after normalisation", () => {
    const e = matchEvidence(keys, contact({ id: "a", email: "m@example.invalid" }));
    expect(e).toEqual({ email: true, phone: null });
    expect(matchedOn(e)).toBe("email");
  });

  it("matches the primary phone", () => {
    const e = matchEvidence(keys, contact({ id: "a", phone_e164: "+35799123456" }));
    expect(e).toEqual({ email: false, phone: "primary" });
    expect(matchedOn(e)).toBe("phone");
  });

  it("matches a number parked in additional_phones and says so", () => {
    const e = matchEvidence(keys, contact({ id: "a", phone_e164: "+35799000000", additional_phones: ["+35799123456"] }));
    expect(e).toEqual({ email: false, phone: "additional" });
    expect(matchedOn(e)).toBe("phone");
  });

  it("reports both when both are the same", () => {
    const e = matchEvidence(keys, contact({ id: "a", email: "m@example.invalid", phone_e164: "+35799123456" }));
    expect(matchedOn(e)).toBe("email_and_phone");
  });

  it("does not match a different e-mail, a near-identical one, or an absent key", () => {
    expect(matchedOn(matchEvidence(keys, contact({ id: "a", email: "m2@example.invalid" })))).toBeNull();
    expect(matchedOn(matchEvidence(keys, contact({ id: "a", email: "m@example.invalid.cy" })))).toBeNull();
    expect(
      matchedOn(matchEvidence({ email: null, phoneE164: null }, contact({ id: "a", email: null, phone_e164: null }))),
    ).toBeNull();
  });

  it("compares the stored address exactly, as the lookup does — every contact write stores it lower-cased", () => {
    // the lookup's `email in (…)` would not return this row either; the two must agree
    expect(matchedOn(matchEvidence(keys, contact({ id: "a", email: "M@Example.Invalid" })))).toBeNull();
  });
});

describe("buildSuggestions", () => {
  const keys = { email: "m@example.invalid", phoneE164: "+35799123456" };

  it("keeps only the rows that match THIS enquiry — the page query ORs every enquiry's keys", () => {
    const set = buildSuggestions(keys, [
      contact({ id: "a", email: "m@example.invalid" }),
      contact({ id: "other", email: "someone@example.invalid" }),
    ]);
    expect(set.candidates.map((c) => c.contact.id)).toEqual(["a"]);
    expect(set.split).toBeNull();
  });

  it("returns an empty set when nothing matches", () => {
    expect(buildSuggestions(keys, [contact({ id: "x", email: "x@example.invalid" })]).candidates).toEqual([]);
  });

  it("shows BOTH contacts when the phone matches one and the e-mail another, and names the split", () => {
    const set = buildSuggestions(keys, [
      contact({ id: "b", display_name: "Maria Papa", email: "m@example.invalid" }),
      contact({ id: "a", display_name: "Maria Georgiou", phone_e164: "+35799123456" }),
    ]);
    expect(set.candidates.map((c) => [c.contact.name, c.matchedOn])).toEqual([
      ["Maria Papa", "email"],
      ["Maria Georgiou", "phone"],
    ]);
    expect(set.split).toEqual({ emailMatches: ["Maria Papa"], phoneMatches: ["Maria Georgiou"] });
    expect(ambiguityNote(set)).toBe(
      "The e-mail matches Maria Papa, but the phone matches Maria Georgiou. They may be different people — check before linking.",
    );
  });

  it("is not a split when one contact carries both — but several candidates are still flagged", () => {
    const set = buildSuggestions(keys, [
      contact({ id: "b", display_name: "Second", additional_phones: ["+35799123456"] }),
      contact({ id: "a", display_name: "First", email: "m@example.invalid", phone_e164: "+35799123456" }),
    ]);
    expect(set.candidates.map((c) => c.contact.id)).toEqual(["a", "b"]);
    expect(set.split).toBeNull();
    expect(ambiguityNote(set)).toMatch(/more than one contact/i);
  });

  it("says nothing extra for a single candidate", () => {
    const set = buildSuggestions(keys, [contact({ id: "a", email: "m@example.invalid" })]);
    expect(ambiguityNote(set)).toBeNull();
  });

  it("orders deterministically: both, e-mail, phone, another number; then name; then id", () => {
    const set = buildSuggestions(keys, [
      contact({ id: "p2", display_name: "Beta", phone_e164: "+35799123456" }),
      contact({ id: "add", display_name: "Aardvark", additional_phones: ["+35799123456"] }),
      contact({ id: "p1", display_name: "alpha", additional_phones: [], phone_e164: null, email: "m@example.invalid" }),
      contact({ id: "both", display_name: "Zed", email: "m@example.invalid", phone_e164: "+35799123456" }),
      contact({ id: "p0", display_name: "Beta", phone_e164: null, additional_phones: [], email: null }),
    ]);
    expect(set.candidates.map((c) => c.contact.id)).toEqual(["both", "p1", "p2", "add"]);
  });

  it("breaks a tie in rank by name, ignoring case, then by id", () => {
    // the only key that realistically repeats across contacts is another number
    // name order, id order and arrival order all disagree, so dropping either
    // comparator — or comparing case-sensitively — changes the answer
    const set = buildSuggestions(keys, [
      contact({ id: "a", display_name: "beta", additional_phones: ["+35799123456"] }),
      contact({ id: "c", display_name: "alpha", additional_phones: ["+35799123456"] }),
      contact({ id: "b", display_name: "Alpha", additional_phones: ["+35799123456"] }),
    ]);
    expect(set.candidates.map((c) => c.contact.id)).toEqual(["b", "c", "a"]);
  });

  it("bounds the candidates it shows, keeps the SAME first ones whatever the order they arrive in, and says there are more", () => {
    const names = ["C4", "C6", "C0", "C3", "C5", "C1", "C2"];
    const many = names.map((n) => contact({ id: n.toLowerCase(), display_name: n, additional_phones: ["+35799123456"] }));
    expect(many).toHaveLength(SUGGESTION_CANDIDATE_LIMIT + 2);
    const set = buildSuggestions(keys, many);
    expect(set.candidates.map((c) => c.contact.id)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(set.moreCandidates).toBe(true);
  });

  it("keeps at most the recent history and says when older enquiries exist", () => {
    const history = [
      lead("l1", "2026-09-20T10:00:00Z"),
      lead("l2", "2026-09-10T10:00:00Z"),
      lead("l3", "2026-08-10T10:00:00Z"),
      lead("l4", "2026-07-10T10:00:00Z"),
    ];
    const set = buildSuggestions(keys, [contact({ id: "a", email: "m@example.invalid", history })]);
    expect(set.candidates[0]!.history.map((h) => h.id)).toEqual(["l1", "l2", "l3"]);
    expect(set.candidates[0]!.history).toHaveLength(SUGGESTION_HISTORY_LIMIT);
    expect(set.candidates[0]!.moreHistory).toBe(true);

    const short = buildSuggestions(keys, [contact({ id: "a", email: "m@example.invalid", history: history.slice(0, 2) })]);
    expect(short.candidates[0]!.moreHistory).toBe(false);
  });

  it("names an unnamed contact rather than printing null", () => {
    const set = buildSuggestions(keys, [contact({ id: "a", display_name: null, email: "m@example.invalid" })]);
    expect(set.candidates[0]!.contact.name).toBe("Unnamed contact");
  });
});

describe("wording", () => {
  it("labels each reason without implying proof", () => {
    expect(reasonLabel({ email: true, phone: "primary" })).toBe("Same e-mail and phone");
    expect(reasonLabel({ email: true, phone: "additional" })).toBe("Same e-mail and phone (another number on the contact)");
    expect(reasonLabel({ email: true, phone: null })).toBe("Same e-mail");
    expect(reasonLabel({ email: false, phone: "primary" })).toBe("Same phone");
    expect(reasonLabel({ email: false, phone: "additional" })).toBe("Same phone (another number on the contact)");
  });

  it("lays the evidence out line by line, including what does NOT match", () => {
    const keys = { email: "m@example.invalid", phoneE164: "+35799123456" };
    expect(evidenceLines(keys, { email: true, phone: "primary" })).toEqual([
      "E-mail m@example.invalid — the same as this contact's e-mail.",
      "Phone +357 99 123456 — the same as this contact's phone.",
    ]);
    expect(evidenceLines(keys, { email: false, phone: "additional" })).toEqual([
      "E-mail m@example.invalid — not this contact's e-mail.",
      "Phone +357 99 123456 — one of this contact's other numbers.",
    ]);
    expect(evidenceLines({ email: "m@example.invalid", phoneE164: null }, { email: true, phone: null })).toEqual([
      "E-mail m@example.invalid — the same as this contact's e-mail.",
    ]);
    expect(evidenceLines({ email: null, phoneE164: "+35799123456" }, { email: false, phone: null })).toEqual([
      "Phone +357 99 123456 — not one of this contact's numbers.",
    ]);
  });

  it("counts candidates in the heading", () => {
    expect(suggestionHeading(1)).toBe("Possible existing contact");
    expect(suggestionHeading(2)).toBe("2 possible existing contacts");
  });

  it("summarises the recent enquiries in one line, saying when there are more", () => {
    expect(historySummary(0, false, null)).toBe("No enquiries are linked to this contact yet.");
    expect(historySummary(1, false, "20 Sept 2026")).toBe("1 recent enquiry · latest 20 Sept 2026");
    expect(historySummary(3, false, "20 Sept 2026")).toBe("3 recent enquiries · latest 20 Sept 2026");
    expect(historySummary(3, true, "20 Sept 2026")).toBe("3+ recent enquiries · latest 20 Sept 2026");
  });
});
