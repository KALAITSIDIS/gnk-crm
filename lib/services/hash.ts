import { createHash } from "node:crypto";

/**
 * Lowercase hex SHA-256 of a buffer. Used to fingerprint signed viewing slips
 * (T4.2) so the stored hash can be recomputed from the file and verified.
 */
export function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Pull a SHA-256 digest out of pasted text (a PDF footer line, an event
 * payload, an email) — the verify-a-report utility accepts loose paste.
 * Exactly one 64-hex run must be present; longer runs are not digests.
 */
export function extractSha256Hex(input: string): string | null {
  const m = input.match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i);
  return m ? m[0].toLowerCase() : null;
}
