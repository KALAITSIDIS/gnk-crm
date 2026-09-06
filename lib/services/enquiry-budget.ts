import { hashIp } from "@/lib/services/ip-hash";

/**
 * Who pays for an enquiry, and out of whose budget.
 *
 * WHY THIS IS ITS OWN FUNCTION. The marketing site posts server-to-server, so
 * every enquiry it forwards reaches the CRM from one egress address. Metering
 * that address alone made the per-address budget of five a budget for the
 * entire internet: the sixth genuine buyer in any quarter of an hour was
 * refused with "Too many enquiries from this address" — an address that was
 * not theirs — and a shell loop could hold the firm's only inbound channel
 * shut for free. Metering the forwarded address alone would be worse, because
 * anyone can send a header.
 *
 * So the forwarded address gets the tight per-person budget and the address the
 * packets actually came from keeps a ceiling. Forging the header buys a fresh
 * personal budget, never an escape from the origin one.
 *
 * AND SINCE 2026-09-06 THE HEADER IS HONOURED ONLY FROM OUR OWN SITE. A fresh
 * personal budget per forged value was still a way to turn one address into
 * as many as you like for the price of a header (the audit's A02), so the
 * route decides — with `isTrustedForwarder` — whether the caller has proved
 * itself, and passes that in. An unproven header is ignored, not refused: the
 * caller is then simply metered as the visitor it claims not to be. This
 * function never reads the key itself; it is pure, and the trust decision is
 * a boolean it is handed, so every branch below is a table the test can pin.
 *
 * The subtle part, and the reason this is pure and tested rather than inline in
 * the route: when the caller IS the visitor — no header, an unproven header,
 * or a proven header naming the caller's own address — the two hashes are the
 * same value. Returning both budgets there would spend the same counter twice
 * per request and silently halve the real limit to two and a half. One budget
 * is returned in every such case, and the test says so.
 */

/** Submissions per VISITOR per 15 minutes. The feed's budget is 120; this writes. */
export const RATE_LIMIT = 5;

/** Submissions per 15 minutes from one CALLER speaking for many visitors. */
export const ORIGIN_RATE_LIMIT = 60;

export interface Budget {
  hash: string;
  limit: number;
}

/**
 * @param transportHash the hash of the address the packets came from
 * @param forwardedIp   the `x-gnk-visitor-ip` header, if any
 * @param trusted       whether the caller proved it is our site (forwarder.ts)
 */
export function budgetsFor(
  transportHash: string,
  forwardedIp: string | null | undefined,
  trusted: boolean,
): Budget[] {
  const claimed = trusted ? forwardedIp?.split(",")[0]?.trim() : undefined;
  if (!claimed) return [{ hash: transportHash, limit: RATE_LIMIT }];
  const visitor = hashIp(claimed);
  // Proven, and naming the caller's own address (the site posting for itself,
  // or a proxy that folds the two): one budget, or the counter is spent twice.
  if (visitor === transportHash) return [{ hash: transportHash, limit: RATE_LIMIT }];
  // Visitor first: the tighter budget should be the one that refuses, so the
  // origin ceiling is only ever reached by genuine volume through the site.
  return [
    { hash: visitor, limit: RATE_LIMIT },
    { hash: transportHash, limit: ORIGIN_RATE_LIMIT },
  ];
}
