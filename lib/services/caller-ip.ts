import { headers } from "next/headers";
import { hashIp } from "@/lib/services/ip-hash";

/**
 * A visitor's IP is never stored — only a salted hash, for the rate-limit
 * counters (`note_share_link_miss`, `note_public_listing_hit`).
 *
 * Hoisted out of `app/p/[token]/page.tsx` when C3 added a second public
 * surface. Two copies of a hash would be two copies that could disagree, and a
 * rate limiter keyed on a hash that changed shape silently stops limiting
 * anything — the counters would just never match an existing row.
 *
 * The salt is NOT described here. It was — "the project URL rather than a
 * secret" — and on 2026-09-06 `IP_HASH_SALT` made that false while this
 * paragraph went on asserting it: one fact in two places, one of them wrong,
 * which is this project's recurring failure. ip-hash.ts is where the hash and
 * its salt are defined and explained; there is nothing to repeat here.
 */
export { hashIp };

export async function callerIpHash(): Promise<string> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  return hashIp(ip);
}
