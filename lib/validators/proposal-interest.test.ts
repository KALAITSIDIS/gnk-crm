import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PROPOSAL_INTEREST_ERROR_CODES,
  PROPOSAL_INTEREST_ERROR_TEXT,
  interestCompleteness,
  interestProblem,
  proposalInterestSchema,
} from "./proposal-interest";

/**
 * The proposal "I'm interested" door answers a rejected body with a STABLE
 * CODE and the FIELD it concerns (audit 2026-09-22, finding 2), not with a
 * sentence — the page speaks the visitor's language and picks the sentence
 * itself. This file pins the mapping from what zod reports to what the
 * page is told, for every way a visitor can get a form wrong, and that an
 * English sentence still exists for every code (the API's `error` field).
 */
const valid = () => ({
  token: randomBytes(32).toString("base64url"),
  property_reference: "PAF0007",
  name: "A Buyer",
  email: "buyer@example.invalid",
  phone: "",
  message: "",
  website: "",
  idempotency_key: "form-1234-abcd",
});

const problemFor = (over: Record<string, unknown>) => {
  const parsed = proposalInterestSchema.safeParse({ ...valid(), ...over });
  if (parsed.success) throw new Error("expected a rejection");
  return interestProblem(parsed.error.issues);
};

describe("what a rejected body is reported as", () => {
  it("a blank or missing name is name_required, on the name field", () => {
    expect(problemFor({ name: "   " })).toEqual({ code: "name_required", field: "name" });
    expect(problemFor({ name: undefined })).toEqual({ code: "name_required", field: "name" });
  });

  it("an over-long name is name_too_long", () => {
    expect(problemFor({ name: "x".repeat(201) })).toEqual({ code: "name_too_long", field: "name" });
  });

  it("a malformed e-mail is email_invalid, an over-long one email_too_long", () => {
    expect(problemFor({ email: "not-an-email" })).toEqual({ code: "email_invalid", field: "email" });
    expect(problemFor({ email: `${"a".repeat(310)}@example.invalid` })).toEqual({ code: "email_too_long", field: "email" });
  });

  it("an over-long phone or message names its field", () => {
    expect(problemFor({ phone: "9".repeat(41) })).toEqual({ code: "phone_too_long", field: "phone" });
    expect(problemFor({ message: "m".repeat(5001) })).toEqual({ code: "message_too_long", field: "message" });
  });

  it("what the page itself got wrong — token, reference, key — is reported without a visitor field", () => {
    expect(problemFor({ token: "../../etc" })).toEqual({ code: "invalid_token", field: null });
    expect(problemFor({ property_reference: "" })).toEqual({ code: "property_reference_invalid", field: null });
    expect(problemFor({ property_reference: "R".repeat(41) })).toEqual({ code: "property_reference_invalid", field: null });
    expect(problemFor({ idempotency_key: "bad key!" })).toEqual({ code: "idempotency_key_invalid", field: null });
  });

  it("the first issue wins, in the order a person reads the form", () => {
    // name before e-mail: the schema lists them in reading order
    expect(problemFor({ name: "", email: "nope" })).toEqual({ code: "name_required", field: "name" });
  });

  it("an issue the mapping does not know is invalid_request, never a throw", () => {
    expect(interestProblem([{ code: "unrecognized_keys", path: ["nowhere"] }])).toEqual({ code: "invalid_request", field: null });
    expect(interestProblem([])).toEqual({ code: "invalid_request", field: null });
  });
});

describe("a way to reply", () => {
  it("no e-mail and no phone is contact_required, on the contact pair", () => {
    const parsed = proposalInterestSchema.safeParse({ ...valid(), email: "", phone: "" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(interestCompleteness(parsed.data)).toEqual({ code: "contact_required", field: "contact" });
  });

  it("either one is enough", () => {
    const withPhone = proposalInterestSchema.safeParse({ ...valid(), email: "", phone: "+357 99 000000" });
    const withEmail = proposalInterestSchema.safeParse({ ...valid(), phone: "" });
    expect(withPhone.success && interestCompleteness(withPhone.data)).toBeNull();
    expect(withEmail.success && interestCompleteness(withEmail.data)).toBeNull();
  });
});

describe("every code has its English sentence", () => {
  it("so the API's `error` field is never empty and never zod's words", () => {
    for (const code of PROPOSAL_INTEREST_ERROR_CODES) {
      const text = PROPOSAL_INTEREST_ERROR_TEXT[code];
      expect(text, code).toBeTruthy();
      expect(text, code).not.toMatch(/expected|received|invalid_type|too_small|too_big/i);
    }
  });
});
