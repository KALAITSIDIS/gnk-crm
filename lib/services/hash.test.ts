import { describe, expect, it } from "vitest";
import { extractSha256Hex, sha256Hex } from "./hash";

describe("sha256Hex", () => {
  it("matches the known vector for 'abc'", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes empty input to the SHA-256 empty digest", () => {
    expect(sha256Hex(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is stable across Buffer and Uint8Array of the same bytes", () => {
    const bytes = [1, 2, 3, 4, 5];
    expect(sha256Hex(Buffer.from(bytes))).toBe(sha256Hex(Uint8Array.from(bytes)));
  });
});

describe("extractSha256Hex", () => {
  const hex = "ab".repeat(32);

  it("accepts a bare digest and lowercases it", () => {
    expect(extractSha256Hex(hex)).toBe(hex);
    expect(extractSha256Hex(hex.toUpperCase())).toBe(hex);
  });

  it("finds the digest inside pasted text (PDF footer, event payload, email)", () => {
    expect(extractSha256Hex(`SHA-256: ${hex}`)).toBe(hex);
    expect(extractSha256Hex(`  report hash:\n${hex}\n`)).toBe(hex);
  });

  it("rejects input without a 64-char hex run", () => {
    expect(extractSha256Hex("")).toBeNull();
    expect(extractSha256Hex("ab".repeat(31))).toBeNull();
    expect(extractSha256Hex("z".repeat(64))).toBeNull();
  });

  it("does not mistake a longer hex run for a digest", () => {
    expect(extractSha256Hex("ab".repeat(40))).toBeNull();
  });
});
