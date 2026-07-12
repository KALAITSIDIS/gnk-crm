import { createHash } from "node:crypto";

/**
 * Lowercase hex SHA-256 of a buffer. Used to fingerprint signed viewing slips
 * (T4.2) so the stored hash can be recomputed from the file and verified.
 */
export function sha256Hex(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
