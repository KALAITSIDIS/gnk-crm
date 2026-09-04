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
 * The salt is the project URL rather than a secret: the value only has to be
 * unguessable-in-aggregate and stable within a deployment. It is truncated to
 * 32 chars because that is what the counter tables were built for (0023).
 */
export function hashIp(ip: string): string {
  return createHash("sha256")
    .update(`${ip}:${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}
