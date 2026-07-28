import { createHmac } from "node:crypto";

/**
 * Minimal TOTP (RFC 6238) generator — TEST SUPPORT ONLY.
 *
 * The 2FA end-to-end test has to behave like a real authenticator app: enrol,
 * read the shared secret, and produce a valid code. Rather than trust a hand-
 * rolled implementation, this is pinned against the published RFC 4226/6238
 * test vectors in totp.test.ts.
 *
 * Not used by the application — Supabase Auth verifies codes server-side.
 */

/** Decode a base32 (RFC 4648, no padding required) secret to bytes. */
export function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) throw new Error(`invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) for a given counter. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  // counter is < 2^53, so split across the two 32-bit halves
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * TOTP for a base32 secret. `atMs` defaults to now; `stepSeconds` is the 30s
 * interval Supabase uses.
 */
export function totp(
  base32Secret: string,
  atMs: number = Date.now(),
  stepSeconds = 30,
  digits = 6,
): string {
  const counter = Math.floor(atMs / 1000 / stepSeconds);
  return hotp(base32Decode(base32Secret), counter, digits);
}
