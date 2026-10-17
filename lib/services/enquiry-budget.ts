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
 *
 * THE CEILING IS THE SITE'S OWN ROW (P3B1-1, six-phase audit 2026-10-17). It
 * was metered on the transport hash — the row EVERY caller at the site's
 * egress address spends, proven or not — so strangers there (on a shared
 * platform, that is anyone) could fill it, and then every buyer on the site
 * was refused with 429 while nothing paged. The proven forwarder's ceiling is
 * now keyed on `callerIpHash("site")`, which only a caller holding the
 * forward key ever reaches (caller-ip.ts's scope rule); the route hands that
 * hash in, so this function stays pure.
 *
 * THE VISITOR'S BUDGET IS ALWAYS FIRST, and the route answers a honeypot hit
 * after it and before any ceiling: a bot filling the site's form spends its
 * own budget and never the one every genuine buyer shares.
 */

/** Submissions per VISITOR per 15 minutes. The feed's budget is 120; this writes. */
export const RATE_LIMIT = 5;

/** Submissions per 15 minutes from one CALLER speaking for many visitors. */
export const ORIGIN_RATE_LIMIT = 60;

export interface Budget {
  /**
   * `visitor`: the person's own budget (the caller itself when nothing is
   * proven). `origin`: the proven site's ceiling — its refusal is not the
   * visitor's doing, so the route answers it differently and pages.
   */
  kind: "visitor" | "origin";
  hash: string;
  limit: number;
}

/**
 * @param transportHash the hash of the address the packets came from
 * @param forwardedIp   the `x-gnk-visitor-ip` header, if any
 * @param trusted       whether the caller proved it is our site (forwarder.ts)
 * @param siteHash      the proven site's own counter key: `callerIpHash("site")`
 */
export function budgetsFor(
  transportHash: string,
  forwardedIp: string | null | undefined,
  trusted: boolean,
  siteHash: string,
): Budget[] {
  const claimed = trusted ? forwardedIp?.split(",")[0]?.trim() : undefined;
  if (!claimed) return [{ kind: "visitor", hash: transportHash, limit: RATE_LIMIT }];
  const visitor = hashIp(claimed);
  // Proven, and naming the caller's own address (the site posting for itself,
  // or a proxy that folds the two): one budget, or the counter is spent twice.
  if (visitor === transportHash) return [{ kind: "visitor", hash: transportHash, limit: RATE_LIMIT }];
  // Visitor first: the tighter budget should be the one that refuses, so the
  // origin ceiling is only ever reached by genuine volume through the site.
  return [
    { kind: "visitor", hash: visitor, limit: RATE_LIMIT },
    { kind: "origin", hash: siteHash, limit: ORIGIN_RATE_LIMIT },
  ];
}
