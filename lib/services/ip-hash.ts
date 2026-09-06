import { createHash } from "node:crypto";

/**
 * A visitor's IP is never stored — only a salted hash, for the rate-limit
 * counters.
 *
 * Lives apart from caller-ip.ts so it can be reached without importing
 * `next/headers`: the enquiry door's budget arithmetic is pure, and pure code
 * that drags a request-scoped Next API in behind it cannot be unit tested.
 * There is still exactly ONE definition of the hash — two copies would be two
 * copies that could disagree, and a rate limiter keyed on a hash that changed
 * shape silently stops limiting anything, because the counters would simply
 * never match an existing row.
 *
 * THE SALT IS A SECRET, `IP_HASH_SALT`, since 2026-09-06. Until then it was
 * the project URL, which is public: anyone holding a fingerprint and the URL
 * could enumerate IPv4 in minutes and name the address, so the legal page's
 * "it identifies nobody" was true only of people who could not be bothered
 * (the audit's A02). With the secret set, a fingerprint names nobody outside
 * this deployment. It only has to be unguessable and stable within a
 * deployment; rotating it resets 15-minute counters and nothing else.
 *
 * When unset (local, CI) it falls back to the project URL so the counters keep
 * working — and a PRODUCTION build says so once, at error level, because a
 * deployment on the fallback is the weaker system wearing the stronger one's
 * promise. Truncated to 32 chars because that is what the counter tables were
 * built for (0023).
 */
let warnedAboutFallback = false;

function salt(): string {
  const configured = process.env.IP_HASH_SALT;
  if (configured) return configured;
  if (!warnedAboutFallback && process.env.NODE_ENV === "production") {
    warnedAboutFallback = true;
    console.error(
      "[ip-hash] IP_HASH_SALT is not set; fingerprints are salted with the public project URL",
    );
  }
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
}

export function hashIp(ip: string): string {
  return createHash("sha256").update(`${ip}:${salt()}`).digest("hex").slice(0, 32);
}
