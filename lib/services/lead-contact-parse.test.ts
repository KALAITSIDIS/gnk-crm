import { describe, expect, it } from "vitest";
import { parseWebsiteEnquiry } from "./lead-contact";
import { LEAD_MESSAGE_REDACTED } from "./erasure";

/**
 * A website lead carries the person's name, e-mail and phone in a fixed
 * block that migration 0084 writes and 0092/0096/0098 kept (audit LR-08):
 *
 *   Website enquiry
 *   Name: …
 *   Email: …          (when given)
 *   Phone: …          (when given)
 *   About: …          (when a reference was typed)
 *
 *   <the visitor's own words>
 *
 * The desk used to retype those lines into a new contact. This parser is
 * what "Create contact" reads instead. It reads the HEADER lines only —
 * anchored at the start of a line, in the first six — so nothing the visitor
 * wrote in the message body ("Email: my old one was…") can be mistaken for
 * the header.
 */
describe("parseWebsiteEnquiry", () => {
  it("reads name, e-mail and phone from the block 0084 writes", () => {
    expect(
      parseWebsiteEnquiry(
        "Website enquiry\nName: Maria Georgiou\nEmail: m@example.invalid\nPhone: +357 99 123456\nAbout: PAF0001\n\nHello",
      ),
    ).toEqual({ name: "Maria Georgiou", email: "m@example.invalid", phone: "+357 99 123456" });
  });

  it("copes with a missing e-mail or phone line", () => {
    expect(parseWebsiteEnquiry("Website enquiry\nName: Igor\nPhone: 99 000000\n\nCall me")).toEqual({
      name: "Igor",
      email: null,
      phone: "99 000000",
    });
    expect(parseWebsiteEnquiry("Website enquiry\nName: Igor\nEmail: i@example.invalid\n")).toEqual({
      name: "Igor",
      email: "i@example.invalid",
      phone: null,
    });
  });

  it("ignores header-shaped lines inside the visitor's own words", () => {
    const parsed = parseWebsiteEnquiry(
      "Website enquiry\nName: Anna\nEmail: a@example.invalid\n\nEmail: this old one bounced\nPhone: 12345",
    );
    expect(parsed).toEqual({ name: "Anna", email: "a@example.invalid", phone: null });
  });

  it("is null for anything that is not a website block", () => {
    expect(parseWebsiteEnquiry("Called about PAF0002, wants a viewing")).toBeNull();
    expect(parseWebsiteEnquiry("")).toBeNull();
    expect(parseWebsiteEnquiry(null)).toBeNull();
    expect(parseWebsiteEnquiry(LEAD_MESSAGE_REDACTED)).toBeNull();
    expect(parseWebsiteEnquiry("Website enquiry\n\nno name line")).toBeNull();
  });

  it("survives Windows line endings", () => {
    expect(parseWebsiteEnquiry("Website enquiry\r\nName: Nino\r\nEmail: n@example.invalid\r\n")).toEqual({
      name: "Nino",
      email: "n@example.invalid",
      phone: null,
    });
  });
});
