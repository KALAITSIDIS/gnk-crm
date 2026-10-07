/**
 * What applying a unit type says (T-unit-type-apply-atomic, migration 0142).
 * Here, not in the "use server" actions file, because the form says the same
 * thing when a request never comes back at all — one text, so the two cannot
 * drift (the price-lists.ts precedent).
 */

/**
 * Said when the outcome is UNKNOWN: the request may have committed and its
 * answer been lost. It sends the person back to the BUTTON, not to a reload:
 * the form holds the submission's id in memory, so a press after a reload is
 * a new submission — it would apply the stamp again (review of
 * T-unit-type-apply-atomic). The answer to the press says what happened.
 */
export const UNIT_TYPE_UNCONFIRMED =
  "Could not confirm whether the layout was applied. Press the button again without changing anything to check — the same submission is never applied twice.";

/** A form older than 0142 posted without an operation id, or ids that are not ids. */
export const UNIT_TYPE_OUT_OF_DATE = "This form is out of date — reload the page and try again.";

/** The database refused the request before it changed anything. */
export const UNIT_TYPE_NOTHING_CHANGED = "Could not apply the layout — nothing was changed. Try again.";

/**
 * lock_timeout (55P03) or a deadlock PostgreSQL broke by aborting this side
 * (40P01): another change to the same units held its locks; nothing was written.
 */
export const UNIT_TYPE_BUSY =
  "Another change to these units was being saved at the same moment — nothing was changed. Try again in a moment.";

/** The toast for a retry the database answered with the original commit. */
export const UNIT_TYPE_REPLAYED = "Already applied — nothing was applied twice.";
