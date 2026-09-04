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
 * The subtle part, and the reason this is pure and tested rather than inline in
 * the route: when NO header is present the caller IS the visitor, and the two
 * hashes are the same value. Returning both budgets there would spend the same
 * counter twice per request and silently halve the real limit to two and a
 * half. One budget is returned in that case, and the test says so.
 */

/** Submissions per VISITOR per 15 minutes. The feed's budget is 120; this writes. */
export const RATE_LIMIT = 5;

/** Submissions per 15 minutes from one CALLER speaking for many visitors. */
export const ORIGIN_RATE_LIMIT = 60;

export interface Budget {
  hash: string;
  limit: number;
}

export function budgetsFor(transportHash: string, forwardedIp: string | null | undefined): Budget[] {
  const claimed = forwardedIp?.split(",")[0]?.trim();
  if (!claimed) return [{ hash: transportHash, limit: RATE_LIMIT }];
  // Visitor first: the tighter budget should be the one that refuses, so the
  // origin ceiling is only ever reached by genuine volume through the site.
  return [
    { hash: hashIp(claimed), limit: RATE_LIMIT },
    { hash: transportHash, limit: ORIGIN_RATE_LIMIT },
  ];
}
