import { describe, expect, it } from "vitest";
import { base32Decode, hotp, totp } from "./totp";

/**
 * Pinned against the published RFC vectors. A hand-rolled TOTP that is subtly
 * wrong would make the 2FA end-to-end test fail for the wrong reason — or, far
 * worse, pass while the app was broken.
 */

// RFC 4226 §D uses the ASCII secret "12345678901234567890".
const RFC_SECRET_ASCII = "12345678901234567890";
// the same twenty bytes in base32
const RFC_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("base32Decode", () => {
  it("decodes the RFC secret to the expected twenty bytes", () => {
    expect(base32Decode(RFC_SECRET_B32).toString("ascii")).toBe(RFC_SECRET_ASCII);
  });

  it("tolerates padding, whitespace and lower case", () => {
    expect(base32Decode("gezdgnbv gy3tqojq gezdgnbvgy3tqojq===").toString("ascii")).toBe(
      RFC_SECRET_ASCII,
    );
  });

  it("rejects a character outside the alphabet", () => {
    expect(() => base32Decode("GEZD1NBV")).toThrow(/invalid base32/i);
  });
});

describe("hotp — RFC 4226 §D test vectors", () => {
  const expected = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];
  it.each(expected.map((code, counter) => ({ counter, code })))(
    "counter $counter → $code",
    ({ counter, code }) => {
      expect(hotp(Buffer.from(RFC_SECRET_ASCII, "ascii"), counter)).toBe(code);
    },
  );
});

describe("totp — RFC 6238 timing", () => {
  it("at T=59s uses counter 1, matching the HOTP vector", () => {
    expect(totp(RFC_SECRET_B32, 59_000)).toBe("287082");
  });

  it("rolls to the next code at the 30-second boundary", () => {
    expect(totp(RFC_SECRET_B32, 29_999)).toBe("755224"); // counter 0
    expect(totp(RFC_SECRET_B32, 30_000)).toBe("287082"); // counter 1
  });

  it("produces an 8-digit code when asked (RFC 6238 §B)", () => {
    expect(totp(RFC_SECRET_B32, 59_000, 30, 8)).toBe("94287082");
  });
});
