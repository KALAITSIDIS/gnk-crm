import { describe, expect, it } from "vitest";
import { internationalPhoneDigits } from "./phone";

/**
 * Kyero's contact nodes want digits only with the country code as 00##.
 * internationalPhoneDigits REWRITES what the desk typed and never guesses:
 * a number with no country code must answer null, not be given one.
 */
describe("internationalPhoneDigits", () => {
  it.each([
    ["+357 26 000000", "0035726000000"],
    ["00357 99-123456", "0035799123456"],
    ["(+44) 20 7946 0958", "00442079460958"],
    ["+1 (212) 555.0100", "0012125550100"],
    ["+357/26/000000", "0035726000000"],
    ["  +357 26 000000  ", "0035726000000"],
    ["0035726000000", "0035726000000"],
  ])("rewrites %j to %j", (raw, digits) => {
    expect(internationalPhoneDigits(raw)).toBe(digits);
  });

  it("refuses a number with no country code rather than inventing one", () => {
    expect(internationalPhoneDigits("26 000000")).toBeNull();
    expect(internationalPhoneDigits("99123456")).toBeNull();
    // a single leading 0 is a trunk prefix, not an international one
    expect(internationalPhoneDigits("026 000000")).toBeNull();
  });

  it("refuses a country code that starts with 0", () => {
    expect(internationalPhoneDigits("+0357 26 000000")).toBeNull();
    expect(internationalPhoneDigits("000357 26 000000")).toBeNull();
  });

  it("answers null for nothing at all", () => {
    expect(internationalPhoneDigits("")).toBeNull();
    expect(internationalPhoneDigits("   ")).toBeNull();
    expect(internationalPhoneDigits(null)).toBeNull();
    expect(internationalPhoneDigits(undefined)).toBeNull();
  });

  it("refuses letters, a misplaced or doubled plus, and other punctuation", () => {
    expect(internationalPhoneDigits("+357 26 ABCDEF")).toBeNull();
    expect(internationalPhoneDigits("+357 26 000000 ext 12")).toBeNull();
    expect(internationalPhoneDigits("++357 26 000000")).toBeNull();
    expect(internationalPhoneDigits("00+357 26 000000")).toBeNull();
    expect(internationalPhoneDigits("357+26000000")).toBeNull();
    expect(internationalPhoneDigits("+357_26_000000")).toBeNull();
  });

  it("takes 7 to 15 digits after the 00 (E.164's 15-digit maximum)", () => {
    expect(internationalPhoneDigits("+1234567")).toBe("001234567");
    expect(internationalPhoneDigits("+123456")).toBeNull();
    expect(internationalPhoneDigits("+123456789012345")).toBe("00123456789012345");
    expect(internationalPhoneDigits("+1234567890123456")).toBeNull();
  });
});
