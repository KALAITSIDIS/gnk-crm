/**
 * What the price-list actions and their forms say (T-price-uplift-atomic,
 * migration 0141). Here, not in the "use server" actions file, because the
 * forms say the same thing when a request never comes back at all — one
 * text, so the two cannot drift (the unconfirmedCloseText precedent).
 */

/** Said when the outcome is UNKNOWN: the request may have committed and its answer been lost. */
export const PRICES_UNCONFIRMED =
  "Could not confirm whether this was saved. Press the button again to check — the same submission is never applied twice — or reload the page to see the current prices.";

/** A form older than 0141 posted without an operation id or the reviewed prices. */
export const PRICES_OUT_OF_DATE = "This form is out of date — reload the page and try again.";

/** The database refused the request before it changed anything. */
export const PRICES_NOTHING_CHANGED = "Could not record the price change — nothing was changed. Try again.";

/**
 * lock_timeout (55P03) or a deadlock PostgreSQL broke by aborting this side
 * (40P01): another change to the same project's units held its locks; nothing
 * was written.
 */
export const PRICES_BUSY =
  "Another change to this project was being saved at the same moment — nothing was changed. Try again in a moment.";

/** The reviewed prices are no longer the prices: nothing was written, and the page was refreshed. */
export const PRICES_STALE =
  "Prices in this scope have changed since you reviewed them — nothing was changed. The preview now shows the current prices: check it and submit again.";

/** The toast for a retry the database answered with the original commit. */
export function replayedText(version: number | null | undefined): string {
  return version
    ? `Already saved — this submission recorded price list v${version}. Nothing was applied twice.`
    : "Already saved — nothing was applied twice.";
}
