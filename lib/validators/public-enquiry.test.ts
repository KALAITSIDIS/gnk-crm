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

  it("takes an idempotency key of the shape 0096 accepts, and treats blank as absent", () => {
    const keyed = publicEnquirySchema.safeParse({ ...base, idempotency_key: "3f2a9c1e-0b7d-4c6e-8a9f-0b1c2d3e4f50" });
    expect(keyed.success).toBe(true);
    expect(keyed.data!.idempotency_key).toBe("3f2a9c1e-0b7d-4c6e-8a9f-0b1c2d3e4f50");
    const blank = publicEnquirySchema.safeParse({ ...base, idempotency_key: "  " });
    expect(blank.success).toBe(true);
    expect(blank.data!.idempotency_key).toBeUndefined();
  });

  it("refuses a key the database would refuse, with a sentence that says why", () => {
    const r = publicEnquirySchema.safeParse({ ...base, idempotency_key: "no spaces allowed!" });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toContain("idempotency_key");
    expect(publicEnquirySchema.safeParse({ ...base, idempotency_key: "short" }).success).toBe(false);
  });

  it("takes a meta object and keeps only the allowlisted string keys, cleaned (0098)", () => {
    const r = publicEnquirySchema.safeParse({
      ...base,
      meta: { budget: " over_1m ", email: "x@y.invalid", utm_source: "instagram", bedrooms_min: 3 },
    });
    expect(r.success).toBe(true);
    expect(r.data!.meta).toEqual({ budget: "over_1m", utm_source: "instagram" });
  });

  it("treats a meta that is not an object as absent, and a body without one as fine", () => {
    expect(publicEnquirySchema.safeParse({ ...base, meta: "junk" }).data!.meta).toBeUndefined();
    expect(publicEnquirySchema.safeParse({ ...base, meta: [1] }).data!.meta).toBeUndefined();
    expect(publicEnquirySchema.safeParse(base).data!.meta).toBeUndefined();
  });
});

/**
 * T-enquiry-identity-single-line. The door writes name, e-mail, phone and the
 * typed reference onto ONE header line each (0101's block); a line break in
 * any of them wrote a second line the parser read back as another field. The
 * audit's two reproductions, from e980575:
 *   A — a phone of "+35799123456\nEmail: other@x.invalid" made the parsed
 *       e-mail other@x.invalid instead of the e-mail field;
 *   B — a name of "Example\nextra\nextra\nextra\nextra" pushed the real
 *       contact lines out of the parser's window.
 * Both were ACCEPTED here. The message stays multiline: it is the one field
 * written below the header, where a line is just a line.
 */
describe("single-line identity fields", () => {
  const firstIssue = (over: Record<string, unknown>) => {
    const r = publicEnquirySchema.safeParse({ ...base, ...over });
    return r.success ? null : r.error.issues[0]!;
  };

  it("refuses the audit's case A — a phone carrying an Email: line — naming the phone", () => {
    const issue = firstIssue({
      org: "audit",
      name: "Example Buyer",
      email: "buyer@example.invalid",
      phone: "+35799123456\nEmail: other@x.invalid",
      message: "Please contact me.",
    });
    expect(issue?.path).toEqual(["phone"]);
    expect(issue?.message).toMatch(/phone number must be on one line/i);
  });

  it("refuses the audit's case B — a name of five lines — naming the name, not 'required'", () => {
    const issue = firstIssue({
      org: "audit",
      name: "Example\nextra\nextra\nextra\nextra",
      email: "buyer@example.invalid",
      phone: "+35799123456",
      message: "Please contact me.",
    });
    expect(issue?.path).toEqual(["name"]);
    expect(issue?.message).toMatch(/name must be on one line/i);
    expect(issue?.message).not.toMatch(/required/i);
  });

  it("refuses CR, LF and CRLF alike, and a blank line inside a value", () => {
    for (const br of ["\n", "\r", "\r\n", "\n\n", "\n \n"]) {
      expect(firstIssue({ name: `Ann${br}Smith` })?.path, JSON.stringify(br)).toEqual(["name"]);
      expect(firstIssue({ phone: `99${br}123456` })?.path, JSON.stringify(br)).toEqual(["phone"]);
      expect(firstIssue({ property_reference: `PAF0001${br}Email: x@y.invalid` })?.path, JSON.stringify(br)).toEqual([
        "property_reference",
      ]);
    }
  });

  it("refuses an injected label in the reference, which the door writes as the About: line", () => {
    const issue = firstIssue({ property_reference: "PAF0001\nPhone: +44 20 7946 0958" });
    expect(issue?.path).toEqual(["property_reference"]);
    expect(issue?.message).toMatch(/property_reference.*one line/i);
  });

  it("refuses the other Unicode line breaks too", () => {
    for (const cp of [0x0b, 0x0c, 0x85, 0x2028, 0x2029]) {
      expect(firstIssue({ name: `Ann${String.fromCodePoint(cp)}Email: x@y.invalid` })?.path, `U+${cp.toString(16)}`).toEqual([
        "name",
      ]);
    }
  });

  it("refuses an e-mail with a line break — it is not an address", () => {
    expect(firstIssue({ email: "buyer@example.invalid\nPhone: 1" })?.path).toEqual(["email"]);
  });

  it("trims a break at either END, as it trims spaces — only an embedded break is refused", () => {
    const r = publicEnquirySchema.safeParse({ ...base, name: "\nAnn Smith\r\n", phone: " +357 99 123456\n" });
    expect(r.success).toBe(true);
    expect(r.data!.name).toBe("Ann Smith");
    expect(r.data!.phone).toBe("+357 99 123456");
  });

  it("keeps a blank-only name a missing name, not a line-break problem", () => {
    const issue = firstIssue({ name: "\n\n" });
    expect(issue?.path).toEqual(["name"]);
    expect(issue?.message).toMatch(/name is required/i);
  });

  it("accepts real names and international numbers as before", () => {
    for (const [name, phone] of [
      ["Γιώργος Παπαδόπουλος", "+357 99 123456"],
      ["Анна-Мария Иванова", "+7 (495) 123-45-67"],
      ["Seán O'Brien", "(+44) 20 7946 0958"],
      ["Jean-Luc Picard-Smith", "00357 99 123456 ext. 12"],
    ]) {
      const r = publicEnquirySchema.safeParse({ ...base, name, phone });
      expect(r.success, name).toBe(true);
      expect(r.data!.name).toBe(name);
      expect(r.data!.phone).toBe(phone);
    }
  });

  it("keeps the message multiline, header-shaped lines and all", () => {
    const message = "Hello,\nEmail: my old address bounced\nPhone: call after 6\r\n\r\nThanks";
    const r = publicEnquirySchema.safeParse({ ...base, message });
    expect(r.success).toBe(true);
    expect(r.data!.message).toBe(message);
  });

  it("keeps the existing caps and optional fields", () => {
    expect(publicEnquirySchema.safeParse({ ...base, name: "Ω".repeat(200) }).success).toBe(true);
    expect(publicEnquirySchema.safeParse({ ...base, name: "Ω".repeat(201) }).success).toBe(false);
    const r = publicEnquirySchema.safeParse({ ...base, phone: "", property_reference: "  " });
    expect(r.success).toBe(true);
    expect(r.data!.phone).toBeUndefined();
    expect(r.data!.property_reference).toBeUndefined();
  });
});
