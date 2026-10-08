/**
 * What a unit's status change says (T-unit-status-atomic, migration 0143).
 * Here, not in the "use server" actions file, because the units grid says the
 * same thing when a request never comes back at all — one text, so the two
 * cannot drift (the unit-types.ts precedent).
 */

/**
 * Said when the outcome is UNKNOWN: the request may have committed and its
 * answer been lost. "Check" re-sends the SAME change (its id is held in
 * memory), and the database answers what it committed. A reload is safe too —
 * the change is decided from the unit as the database holds it, so it is never
 * made twice — but only the same change can finish a follow-up it left.
 */
export const UNIT_STATUS_UNCONFIRMED =
  "Could not confirm whether the status was changed. Press Check to find out — a change is never made twice.";

/** A page older than 0143 sent no operation id or expected status, or ids that are not ids. */
export const UNIT_STATUS_OUT_OF_DATE = "This page is out of date — reload it and try again.";

/** The database refused the request before it changed anything. */
export const UNIT_STATUS_NOTHING_CHANGED = "Could not change the status — nothing was changed. Try again.";

/**
 * lock_timeout (55P03) or a deadlock PostgreSQL broke by aborting this side
 * (40P01); nothing was written. Not "this unit": the function's 3 s bound also
 * covers the organisation's events-chain lock (0108), which a reprice, a stamp
 * or a sweep elsewhere in the organisation can be holding.
 */
export const UNIT_STATUS_BUSY =
  "Another change was being saved at the same moment — nothing was changed. Try again in a moment.";

/** A retry the database answered with the change it had already committed. */
export const UNIT_STATUS_REPLAYED = "Already saved — the change was made once.";

/**
 * The change committed with its timeline lines; closing the listing-status
 * task a won deal raised did not finish. Retry re-sends the same change: the
 * database answers it as already made, and the closure runs again.
 */
export const UNIT_STATUS_FOLLOW_UP_OPEN =
  "Status saved. The open listing-status task could not be confirmed closed — press Retry, or close it in Tasks.";

/** Closed, but a task's own `superseded` line was not written — a retry cannot write it later. */
export const UNIT_STATUS_FOLLOW_UP_UNRECORDED =
  "Status saved. The listing-status task was closed, but its timeline line could not be written.";

/** A unit already in the status asked for: nothing was written. */
export function unitStatusUnchangedText(status: string): string {
  return `Already ${status.replace(/_/g, " ")} — nothing to change.`;
}

/** What `updateUnitStatus` answers (lib/actions/units.ts). */
export type UnitStatusResult = {
  error: string | null;
  /** set when the unit holds the status asked for — changed now, earlier, or already */
  savedAt: number | null;
  /** the outcome is unknown — the change may have committed; send the same change again to find out */
  unconfirmed?: boolean;
  /** THIS request met the unit's lock (55P03) or lost a deadlock (40P01) and wrote nothing */
  busy?: boolean;
  /** this answer repeats a change the same submission already committed */
  replayed?: boolean;
  /** the unit already had that status; nothing was written */
  unchanged?: boolean;
  /** committed, but the follow-up after it did not finish (said, never reported as a failure) */
  notice?: string | null;
};

/**
 * What the units grid tells the person about one answer — and whether it
 * offers to send the SAME change again: `check` learns an unknown outcome,
 * `retry` finishes a follow-up that did not. A follow-up notice outranks a
 * replay: the replay that was meant to finish it may itself not have.
 */
export type UnitStatusOutcome = {
  tone: "success" | "info" | "warning" | "error";
  text: string;
  offer: "check" | "retry" | null;
};

export function describeUnitStatusOutcome(result: UnitStatusResult, to: string): UnitStatusOutcome {
  if (result.error) return { tone: "error", text: result.error, offer: result.unconfirmed ? "check" : null };
  if (result.notice) {
    return { tone: "warning", text: result.notice, offer: result.notice === UNIT_STATUS_FOLLOW_UP_OPEN ? "retry" : null };
  }
  if (result.unchanged) return { tone: "info", text: unitStatusUnchangedText(to), offer: null };
  if (result.replayed) return { tone: "info", text: UNIT_STATUS_REPLAYED, offer: null };
  return { tone: "success", text: "Saved", offer: null };
}
