import { createHash } from "node:crypto";
import { headers } from "next/headers";

/**
 * A visitor's IP is never stored — only a salted hash, for the rate-limit
 * counters (`note_share_link_miss`, `note_public_listing_hit`).
 *
 * Hoisted out of `app/p/[token]/page.tsx` when C3 added a second public
 * surface. Two copies of a hash would be two copies that could disagree, and a
 * rate limiter keyed on a hash that changed shape silently stops limiting
 * anything — the counters would just never match an existing row.
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

export async function callerIpHash(): Promise<string> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  return hashIp(ip);
}
