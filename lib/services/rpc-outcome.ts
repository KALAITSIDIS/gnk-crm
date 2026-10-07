/**
 * What a failed RPC's error says about its transaction — shared by the
 * actions that call one transactional function and must tell the person
 * either "nothing was changed" or "could not confirm" (close_deal, 0117;
 * record_price_list_version, 0141). Here, not in a "use server" file, which
 * may export async functions only.
 */

/**
 * PostgREST codes raised before the request's transaction ran, or after
 * PostgREST itself condemned it (v14.5 local / hosted as recorded, v16.1 on
 * CI — read from their source, DECISIONS T-media-insert-outcome):
 * PGRST002/003 (no schema cache, no pool connection); 100–102, 105–108, 114,
 * 117, 118, 121–128 (parsing, planning; 115 / 124 condemn the transaction,
 * 121 is the database's own error); 200–205 (schema cache); 300–303 (JWT).
 * NOT listed, so unknown: 000/001 (connection — unknown by policy: the
 * evidence that 001 never follows a commit rests on hasql internals), 103 /
 * 111 / 112 (built AFTER the commit — 111 / 112 measured with the row
 * committed), 116 (postgrest-js synthesises it after a 2xx), 104 / 120 (no
 * raise site in either version), and every code nobody has classified yet.
 */
const PGRST_NOT_RUN = /^PGRST(00[23]|10[0-25-8]|11[4578]|12[1-8]|20[0-5]|30[0-3])$/;

/**
 * SQLSTATE classes PostgreSQL raises only while a statement runs or in the
 * pre-commit work (deferred constraints, the serialization check), before the
 * commit record: 0A, 21, 22, 23, 25, 2D, 40 (not 40003, "statement completion
 * unknown"), 42, 44, 54, 55, P0. NOT listed: 08 (a connection exception, which
 * a proxy or libpq reports after a COMMIT that went through), 53 / 57 / 58 / XX
 * (an out-of-memory, a cancel or a PANIC can be reported for a transaction
 * that committed), and every other class or string.
 */
const STATEMENT_LEVEL = /^(0A|2[1235D]|4[024]|54|55|P0)[0-9A-Z]{3}$/;

/**
 * Did this error come from a request whose transaction certainly did NOT
 * commit? An ALLOWLIST of understood codes: anything else — no code (a
 * network failure, a gateway `{}` or HTML body), a non-string code, a code
 * from a class that can follow a commit, a code nobody has classified — is
 * unknown, and the caller must not act as if nothing was written. A code is
 * not, by itself, an answer from the database. The type check matters: a
 * gateway's JSON body can carry a NUMBER (`42501` as a number is unknown).
 */
export function certainlyRolledBack(code: unknown): boolean {
  if (typeof code !== "string") return false;
  if (PGRST_NOT_RUN.test(code)) return true;
  return STATEMENT_LEVEL.test(code) && code !== "40003";
}
