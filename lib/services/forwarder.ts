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

/** Whether a mismatch has already been reported by this instance. */
let reportedMismatch = false;

/**
 * The same decision, but a key that was PRESENTED and rejected says so once.
 *
 * `isTrustedForwarder` answers false identically for "nobody presented a key"
 * and "a key was presented and did not match", and the route logged neither —
 * so a trailing newline from a piped `vercel env add`, or a rotation applied
 * on one side only, would silently meter every visitor the site forwards on
 * the site's single egress address, refusing the sixth genuine buyer in any
 * quarter of an hour with a message about an address that is not theirs. That
 * is the failure the header was added to end, wearing no symptom at all
 * (2026-09-07 review).
 *
 * Once per instance, at error level, and NEVER the value — the point is that
 * somebody looking at the logs can see a misconfiguration that otherwise only
 * shows up as a buyer who could not reach the firm.
 */
export function isTrustedForwarderLoudly(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const trusted = isTrustedForwarder(presented, expected);
  if (!trusted && presented && expected && !reportedMismatch) {
    reportedMismatch = true;
    console.error(
      "[enquiry] a forward key was presented and did not match ENQUIRY_FORWARD_KEY — " +
        "forwarded visitors are being metered on the caller's own address",
    );
  }
  return trusted;
}

/** Test seam: the once-per-instance latch. */
export function resetForwarderMismatchLatch(): void {
  reportedMismatch = false;
}
