import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Does this request come from OUR marketing site?
 *
 * The enquiry door meters two budgets when the site posts on a visitor's
 * behalf: a tight one on the visitor's own address (forwarded as
 * `x-gnk-visitor-ip`) and a ceiling on the address the packets came from.
 * That only works if the visitor header can be believed — and until
 * 2026-09-06 anyone could send it (the audit's A02). Forging it never lifted
 * the transport ceiling, but it did hand each forged value a fresh personal
 * budget of five, which is a way of turning one address into as many as you
 * like for the price of a header.
 *
 * So the site now proves it is the forwarder with `x-gnk-forward-key`, a
 * static shared secret set in both Vercel projects and nowhere else. It is
 * not a signature over the body: the two deployments talk over TLS, there is
 * no capture point between them, and a webhook-style HMAC would be
 * ceremony that protects against nothing that can happen here (the audit
 * response, §2). What the key does is small and exact — it decides whether
 * the visitor header is honoured. It grants nothing else: the door is public
 * and stays public.
 *
 * Compared in constant time over fixed-length digests, so neither the length
 * of the presented value nor the position of a first mismatch leaks. With no
 * key configured on this side nothing is trusted, rather than everything:
 * that is the pre-2026-09-06 behaviour and it is the weaker of the two.
 */
export function isTrustedForwarder(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!expected || !presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
