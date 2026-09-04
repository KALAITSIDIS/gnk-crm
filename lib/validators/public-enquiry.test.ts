import { describe, expect, it } from "vitest";
import { enquiryCompleteness, publicEnquirySchema } from "./public-enquiry";

/**
 * The shape rules for the public enquiry door (0084).
 *
 * These exist to give a site developer a useful 400. The DATABASE function
 * enforces the same limits and is the actual boundary, so a gap here is a bad
 * error message, not a hole — which is exactly why the two must not drift:
 * the caps below are 0084's, to the character.
 */
const base = {
  org: "gnk",
  name: "A Buyer",
  email: "buyer@example.com",
  message: "Interested in the villa",
};

describe("public enquiry input", () => {
  it("accepts the ordinary case", () => {
    const r = publicEnquirySchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(enquiryCompleteness(r.data!)).toBeNull();
  });

  it("treats blank strings as absent, because a form posts empty inputs", () => {
    const r = publicEnquirySchema.safeParse({ ...base, phone: "   ", property_reference: "" });
    expect(r.success).toBe(true);
    expect(r.data!.phone).toBeUndefined();
    expect(r.data!.property_reference).toBeUndefined();
  });

  it("needs a way to reply", () => {
    const r = publicEnquirySchema.safeParse({ org: "gnk", name: "A Buyer", message: "hello" });
    expect(r.success).toBe(true);
    expect(enquiryCompleteness(r.data!)).toMatch(/email address or a phone number/i);
  });

  it("takes a phone alone — not everyone gives an email", () => {
    const r = publicEnquirySchema.safeParse({
      org: "gnk",
      name: "A Buyer",
      phone: "99 123456",
      message: "call me",
    });
    expect(enquiryCompleteness(r.data!)).toBeNull();
  });

  it("needs something to reply about", () => {
    const r = publicEnquirySchema.safeParse({ org: "gnk", name: "A Buyer", email: "a@b.com" });
    expect(enquiryCompleteness(r.data!)).toMatch(/message or a `property_reference`/i);
  });

  it("takes a bare listing reference as the subject — 'this one, please'", () => {
    const r = publicEnquirySchema.safeParse({
      org: "gnk",
      name: "A Buyer",
      email: "a@b.com",
      property_reference: "PAF0001",
    });
    expect(enquiryCompleteness(r.data!)).toBeNull();
  });

  it("refuses an address that is not one", () => {
    expect(publicEnquirySchema.safeParse({ ...base, email: "not-an-email" }).success).toBe(false);
  });

  it("holds 0084's caps to the character", () => {
    expect(publicEnquirySchema.safeParse({ ...base, name: "x".repeat(200) }).success).toBe(true);
    expect(publicEnquirySchema.safeParse({ ...base, name: "x".repeat(201) }).success).toBe(false);
    expect(
      publicEnquirySchema.safeParse({ ...base, message: "x".repeat(5000) }).success,
    ).toBe(true);
    expect(
      publicEnquirySchema.safeParse({ ...base, message: "x".repeat(5001) }).success,
    ).toBe(false);
    expect(
      publicEnquirySchema.safeParse({ ...base, property_reference: "x".repeat(41) }).success,
    ).toBe(false);
    expect(publicEnquirySchema.safeParse({ ...base, phone: "9".repeat(41) }).success).toBe(false);
  });

  it("requires an org, because the feed beside it is per-agency", () => {
    expect(publicEnquirySchema.safeParse({ ...base, org: "" }).success).toBe(false);
    expect(publicEnquirySchema.safeParse({ ...base, org: undefined }).success).toBe(false);
  });

  it("carries the honeypot through rather than rejecting it", () => {
    // the ROUTE drops a filled honeypot, and answers as though it accepted:
    // rejecting here would tell a bot which field gave it away
    const r = publicEnquirySchema.safeParse({ ...base, website: "http://spam.example" });
    expect(r.success).toBe(true);
    expect(r.data!.website).toBe("http://spam.example");
  });
});
