import { describe, expect, it } from "vitest";
import { parseWebsiteEnquiry, readWebsiteEnquiry, websiteEnquiryBody } from "./lead-contact";
import { LEAD_MESSAGE_REDACTED } from "./erasure";

/**
 * A website lead carries the person's name, e-mail and phone in a fixed
 * block that migration 0084 writes and 0092/0096/0098/0101 kept (audit LR-08):
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
 * what "Create contact" reads instead — and, since 0101, what the desk-alert
 * worker rebuilds the e-mail from. It reads the HEADER lines only — anchored
 * at the start of a line, in the first six — so nothing the visitor wrote in
 * the message body ("Email: my old one was…") can be mistaken for the header.
 */
describe("parseWebsiteEnquiry", () => {
  it("reads name, e-mail, phone and the typed reference from the block 0084 writes", () => {
    expect(
      parseWebsiteEnquiry(
        "Website enquiry\nName: Maria Georgiou\nEmail: m@example.invalid\nPhone: +357 99 123456\nAbout: PAF0001\n\nHello",
      ),
    ).toEqual({ name: "Maria Georgiou", email: "m@example.invalid", phone: "+357 99 123456", about: "PAF0001" });
  });

  it("copes with a missing e-mail or phone line", () => {
    expect(parseWebsiteEnquiry("Website enquiry\nName: Igor\nPhone: 99 000000\n\nCall me")).toEqual({
      name: "Igor",
      email: null,
      phone: "99 000000",
      about: null,
    });
    expect(parseWebsiteEnquiry("Website enquiry\nName: Igor\nEmail: i@example.invalid\n")).toEqual({
      name: "Igor",
      email: "i@example.invalid",
      phone: null,
      about: null,
    });
  });

  it("strips the door's own note from a reference that matched no published listing (0101)", () => {
    expect(
      parseWebsiteEnquiry(
        "Website enquiry\nName: Sam\nEmail: s@example.invalid\nAbout: PAF0009 (no published listing with that reference)\n",
      )!.about,
    ).toBe("PAF0009");
  });

  it("ignores header-shaped lines inside the visitor's own words", () => {
    const parsed = parseWebsiteEnquiry(
      "Website enquiry\nName: Anna\nEmail: a@example.invalid\n\nEmail: this old one bounced\nPhone: 12345",
    );
    expect(parsed).toEqual({ name: "Anna", email: "a@example.invalid", phone: null, about: null });
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
      about: null,
    });
  });
});

/**
 * 0101's `v_body` expression (0106 writes the same header), in TypeScript:
 * each value written RAW onto its own line, the typed reference with the
 * door's note when it matched nothing, a blank line, then the visitor's
 * words. supabase/tests/enquiry-single-line.test.ts runs the real SQL.
 */
function doorBlock(v: { name: string; email?: string; phone?: string; about?: string; noMatch?: boolean; message?: string }) {
  return (
    "Website enquiry\n" +
    `Name: ${v.name}\n` +
    (v.email !== undefined ? `Email: ${v.email}\n` : "") +
    (v.phone !== undefined ? `Phone: ${v.phone}\n` : "") +
    (v.about !== undefined ? `About: ${v.about}${v.noMatch ? " (no published listing with that reference)" : ""}\n` : "") +
    (v.message !== undefined ? `\n${v.message}` : "")
  );
}

const ambiguous = (message: string) => {
  const read = readWebsiteEnquiry(message);
  return read.kind === "ambiguous" ? read.reason : `not ambiguous: ${read.kind}`;
};

/**
 * T-enquiry-identity-single-line. Until this change the reader took whichever
 * value came LAST for a label, skipped any line it did not recognise, and
 * stopped looking after five lines — so a line break in a value the door
 * wrote raw could replace the e-mail (case A) or hide it (case B), and the
 * desk alert's Reply-To, "Possible existing contact" and "Create contact"
 * all used the result. Now the header must be the door's grammar exactly —
 * Name, then Email / Phone / About at most once each and in that order, each
 * on one line with a value, and at least one way to reply (the door has
 * refused an enquiry without one since 0084) — or the reading is AMBIGUOUS,
 * and every consumer falls back to the desk's own judgement. Nothing is
 * guessed, and the message itself is never touched: the inbox shows it whole.
 */
describe("readWebsiteEnquiry — a header that cannot be trusted is ambiguous, never guessed", () => {
  it("case A: a phone carrying an Email: line is a duplicate label, not a new e-mail", () => {
    const stored = doorBlock({
      name: "Example Buyer",
      email: "buyer@example.invalid",
      phone: "+35799123456\nEmail: other@x.invalid",
      message: "Please contact me.",
    });
    expect(ambiguous(stored)).toBe("duplicate_label");
    // the old reader answered other@x.invalid here
    expect(parseWebsiteEnquiry(stored)).toBeNull();
  });

  it("case B: a five-line name is an unknown header line, not a missing e-mail", () => {
    const stored = doorBlock({
      name: "Example\nextra\nextra\nextra\nextra",
      email: "buyer@example.invalid",
      phone: "+35799123456",
      message: "Please contact me.",
    });
    expect(ambiguous(stored)).toBe("unknown_line");
    // the old reader answered { name: "Example", email: null, phone: null }
    expect(parseWebsiteEnquiry(stored)).toBeNull();
  });

  it("case A with CR or CRLF: a carriage return inside a value is a stray break", () => {
    for (const br of ["\r", "\r\n"]) {
      const stored = doorBlock({ name: "Example Buyer", email: "buyer@example.invalid", phone: `+35799123456${br}Email: other@x.invalid`, message: "Hi" });
      expect(ambiguous(stored), JSON.stringify(br)).toBe("stray_line_break");
      expect(parseWebsiteEnquiry(stored)).toBeNull();
    }
  });

  it("a Unicode line separator inside a value is a stray break", () => {
    const stored = doorBlock({ name: `Ann${String.fromCodePoint(0x2028)}Email: other@x.invalid`, phone: "99123456" });
    expect(ambiguous(stored)).toBe("stray_line_break");
  });

  it("an injected label in the reference comes after About — out of order, or a duplicate", () => {
    expect(ambiguous(doorBlock({ name: "Ann", phone: "99123456", about: "PAF0001\nEmail: other@x.invalid" }))).toBe("out_of_order");
    expect(ambiguous(doorBlock({ name: "Ann", email: "a@example.invalid", about: "PAF0001\nEmail: other@x.invalid" }))).toBe(
      "duplicate_label",
    );
    expect(ambiguous(doorBlock({ name: "Ann", email: "a@example.invalid", about: "PAF0001\nPhone: 999" }))).toBe("out_of_order");
  });

  it("a repeated label is refused whichever value came last", () => {
    expect(ambiguous("Website enquiry\nName: Ann\nName: Mallory\nEmail: a@example.invalid\n")).toBe("duplicate_label");
    expect(ambiguous("Website enquiry\nName: Ann\nEmail: a@example.invalid\nEmail: b@example.invalid\n")).toBe("duplicate_label");
    expect(ambiguous("Website enquiry\nName: Ann\nPhone: 1\nPhone: 2\n\nhi")).toBe("duplicate_label");
  });

  it("labels out of the door's order are refused", () => {
    expect(ambiguous("Website enquiry\nName: Ann\nPhone: 99123456\nEmail: a@example.invalid\n")).toBe("out_of_order");
    expect(readWebsiteEnquiry("Website enquiry\nEmail: a@example.invalid\nName: Ann\n").kind).toBe("ambiguous");
  });

  it("a blank line inside the name ends the header early — the contact lines it hid make it ambiguous", () => {
    // the door never wrote a header without an e-mail or a phone: what follows
    // the blank is the real header, now sitting where the visitor's words go
    const stored = doorBlock({ name: "Ann\n", email: "a@example.invalid", phone: "99123456", message: "Hi" });
    expect(ambiguous(stored)).toBe("no_contact");
    expect(parseWebsiteEnquiry(stored)).toBeNull();
  });

  it("a whitespace-only line inside the header is not a separator the door writes", () => {
    expect(ambiguous(doorBlock({ name: "Ann\n \nsomething", email: "a@example.invalid" }))).toBe("unknown_line");
  });

  it("a label with nothing after it, or no name at all, is refused", () => {
    expect(ambiguous("Website enquiry\nName: Ann\nEmail: \nPhone: 1\n")).toBe("empty_value");
    expect(ambiguous("Website enquiry\nName:  \nPhone: 1\n")).toBe("empty_value");
    expect(ambiguous("Website enquiry\n\nno name line")).toBe("missing_name");
    expect(ambiguous("Website enquiry")).toBe("missing_name");
  });

  it("LIMITATION, recorded: a break that forges a PERFECT header is indistinguishable from a real one", () => {
    // Why the input rule (0114 + the validators) is the fix and this reader is
    // only the backstop: these two stored messages are the same bytes.
    const injected = doorBlock({ name: "Ann\nEmail: other@x.invalid", phone: "99123456", message: "Hi" });
    const genuine = doorBlock({ name: "Ann", email: "other@x.invalid", phone: "99123456", message: "Hi" });
    expect(injected).toBe(genuine);
  });

  it("anything without the marker is not_website", () => {
    for (const m of [null, undefined, "", "Called about PAF0002", LEAD_MESSAGE_REDACTED, " Website enquiries\nName: A\nPhone: 1\n"]) {
      expect(readWebsiteEnquiry(m).kind, String(m)).toBe("not_website");
    }
  });
});

describe("readWebsiteEnquiry — every header the doors have written still reads", () => {
  const person = (p: Partial<{ name: string; email: string | null; phone: string | null; about: string | null }>) => ({
    kind: "parsed",
    person: { name: "Ann", email: null, phone: null, about: null, ...p },
  });

  it("each combination 0084–0101 can write, with and without the visitor's words", () => {
    expect(readWebsiteEnquiry(doorBlock({ name: "Ann", email: "a@example.invalid", message: "Hi" }))).toEqual(
      person({ email: "a@example.invalid" }),
    );
    expect(readWebsiteEnquiry(doorBlock({ name: "Ann", phone: "+357 99 123456", about: "PAF0001" }))).toEqual(
      person({ phone: "+357 99 123456", about: "PAF0001" }),
    );
    expect(
      readWebsiteEnquiry(doorBlock({ name: "Ann", email: "a@example.invalid", phone: "99123456", about: "PAF0009", noMatch: true, message: "x" })),
    ).toEqual(person({ email: "a@example.invalid", phone: "99123456", about: "PAF0009" }));
  });

  it("the proposal door's block (0106): About always, then the proposal sentence", () => {
    const stored =
      "Website enquiry\nName: Γιώργος Παπαδόπουλος\nPhone: +357 99 123456\nAbout: PAF0007\n\n" +
      'Interested in PAF0007 from the proposal "Sea views".\nEmail: not a header, the buyer\'s words';
    expect(readWebsiteEnquiry(stored)).toEqual(person({ name: "Γιώργος Παπαδόπουλος", phone: "+357 99 123456", about: "PAF0007" }));
    expect(websiteEnquiryBody(stored)).toBe('Interested in PAF0007 from the proposal "Sea views".\nEmail: not a header, the buyer\'s words');
  });

  it("header-shaped lines in the visitor's words stay words — the positive control", () => {
    const message = "Email: my old address bounced\nPhone: 000\nName: Mallory\n\nAbout: nothing";
    const stored = doorBlock({ name: "Анна-Мария Иванова", email: "anna@example.invalid", phone: "+7 (495) 123-45-67", message });
    expect(readWebsiteEnquiry(stored)).toEqual(
      person({ name: "Анна-Мария Иванова", email: "anna@example.invalid", phone: "+7 (495) 123-45-67" }),
    );
    expect(websiteEnquiryBody(stored)).toBe(message);
  });

  it("a block typed on Windows — CRLF throughout — still reads, as it always has", () => {
    expect(readWebsiteEnquiry("Website enquiry\r\nName: Nino\r\nEmail: n@example.invalid\r\n\r\nHello\r\nthere")).toEqual(
      person({ name: "Nino", email: "n@example.invalid" }),
    );
  });

  it("the door's LF header with CRLF in the visitor's words reads — only the header must be the door's", () => {
    const stored = doorBlock({ name: "Ann", phone: "99123456", message: "line one\r\nEmail: x@y.invalid\r\nline three" });
    expect(readWebsiteEnquiry(stored)).toEqual(person({ phone: "99123456" }));
  });

  it("round trip: every one-line value comes back exactly as it went in", () => {
    const names = ["Maria Georgiou", "Seán O'Brien", "Jean-Luc Picard-Smith", "Ελένη Κωνσταντίνου", "Пётр Ильич", "Dr: Who", "Name: Echo"];
    const emails = [undefined, "m@example.invalid", "o'brien+tag@example.co.uk"];
    const phones = [undefined, "+357 99 123456", "(+44) 20 7946 0958", "00357 99 123456 ext. 12"];
    const abouts = [undefined, "PAF0001", "Email: PAF0002"];
    const messages = [undefined, "Hi", "Email: decoy@example.invalid\nPhone: 000\n\nName: Mallory"];
    for (const name of names)
      for (const email of emails)
        for (const phone of phones) {
          if (!email && !phone) continue;
          for (const about of abouts)
            for (const message of messages) {
              const stored = doorBlock({ name, email, phone, about, message });
              expect(readWebsiteEnquiry(stored), stored).toEqual({
                kind: "parsed",
                person: { name, email: email ?? null, phone: phone ?? null, about: about ?? null },
              });
            }
        }
  });
});

describe("websiteEnquiryBody", () => {
  it("is the visitor's own words after the header, whole", () => {
    expect(
      websiteEnquiryBody("Website enquiry\nName: Anna\nEmail: a@example.invalid\n\nFirst line\n\nThird line"),
    ).toBe("First line\n\nThird line");
  });

  it("is null when they typed none, and for anything that is not the block", () => {
    expect(websiteEnquiryBody("Website enquiry\nName: Igor\nPhone: 1\nAbout: PAF0002\n")).toBeNull();
    expect(websiteEnquiryBody("Called about PAF0002")).toBeNull();
    expect(websiteEnquiryBody(LEAD_MESSAGE_REDACTED)).toBeNull();
    expect(websiteEnquiryBody(null)).toBeNull();
  });

  it("survives Windows line endings", () => {
    expect(websiteEnquiryBody("Website enquiry\r\nName: Nino\r\n\r\nHello\r\nthere")).toBe("Hello\nthere");
  });
});
