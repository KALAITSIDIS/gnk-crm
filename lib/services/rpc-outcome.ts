/**
 * What a failed RPC's error says about its transaction — shared by the
 * actions that call one transactional function and must tell the person
 * either "nothing was changed" or "could not confirm" (close_deal, 0117;
 * record_price_list_version, 0141). Here, not in a "use server" file, which
 * may export async functions only.
 */

/**
 * Did this error come from a request whose transaction certainly did NOT
 * commit? A five-character SQLSTATE means PostgreSQL answered and the
 * statement failed — except class 08 (connection exceptions), which can mean
 * the connection dropped around the COMMIT. PGRST1xx-3xx are request-level
 * refusals made before or instead of running the function; PGRST002/003 mean
 * no connection was obtained. Everything else — no code (a network failure,
 * a gateway `{}` or HTML body), PGRST000/001, a status 0 — is unknown.
 */
export function certainlyRolledBack(code: string | undefined): boolean {
  if (!code) return false;
  if (/^PGRST[123]\d\d$/.test(code) || code === "PGRST002" || code === "PGRST003") return true;
  return /^[0-9A-Z]{5}$/.test(code) && !code.startsWith("08");
}
