import { describe, expect, it } from "vitest";
import { LINE_BREAK_CODE_POINTS, hasLineBreak } from "./single-line";

/**
 * A value the door writes onto ONE line of the enquiry header (name, e-mail,
 * phone, reference) must not carry a line break of its own: a break there
 * writes a second header line — another label, or a blank that ends the
 * header early — and the parser reads it back as something the visitor did
 * not type into that field (T-enquiry-identity-single-line).
 *
 * "A line break" is Unicode's mandatory breaks (UAX #14 classes BK, CR, LF,
 * NL), not only the two a keyboard makes: a LINE SEPARATOR renders as a new
 * line in the inbox and the desk e-mail just as surely as a newline does.
 * The database functions refuse the same set (0114) — see
 * supabase/tests/enquiry-single-line.test.ts, which sends every one of these
 * code points to both functions.
 */
const ch = (cp: number) => String.fromCodePoint(cp);

describe("hasLineBreak", () => {
  it("is exactly Unicode's mandatory line breaks", () => {
    expect([...LINE_BREAK_CODE_POINTS]).toEqual([0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029]);
  });

  it("finds each of them inside a value", () => {
    for (const cp of LINE_BREAK_CODE_POINTS) {
      expect(hasLineBreak(`Ann${ch(cp)}Email: other@example.invalid`), `U+${cp.toString(16)}`).toBe(true);
    }
  });

  it("finds LF, CR and CRLF wherever they sit", () => {
    expect(hasLineBreak("+35799123456\nEmail: other@x.invalid")).toBe(true);
    expect(hasLineBreak("+35799123456\rEmail: other@x.invalid")).toBe(true);
    expect(hasLineBreak("+35799123456\r\nEmail: other@x.invalid")).toBe(true);
    expect(hasLineBreak("\nAnn")).toBe(true);
    expect(hasLineBreak("Ann\n")).toBe(true);
    expect(hasLineBreak("Example\n\nextra")).toBe(true);
  });

  it("passes real names in English, Greek and Russian, with apostrophes and hyphens", () => {
    for (const name of [
      "Maria Georgiou",
      "Seán O'Brien",
      "Jean-Luc Picard-Smith",
      "Γιώργος Παπαδόπουλος",
      "Ελένη Κωνσταντίνου-Χριστοδούλου",
      "Анна-Мария Иванова",
      "Пётр Ильич Чайковский",
      "Nguyễn Văn An",
    ]) {
      expect(hasLineBreak(name), name).toBe(false);
    }
  });

  it("passes international phone formats", () => {
    for (const phone of ["+357 99 123456", "+35799123456", "(+44) 20 7946 0958", "+1-202-555-0143", "00357 99 123456 ext. 12", "99 123 456"]) {
      expect(hasLineBreak(phone), phone).toBe(false);
    }
  });

  it("does not treat other whitespace as a break — a tab or a no-break space stays on the line", () => {
    expect(hasLineBreak("Ann\tSmith")).toBe(false);
    expect(hasLineBreak(`Ann${ch(0xa0)}Smith`)).toBe(false);
    expect(hasLineBreak("")).toBe(false);
  });
});
