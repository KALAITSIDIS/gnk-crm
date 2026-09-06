/**
 * The optimistic predicate behind a section save (the audit's A06).
 *
 * A property's tabs are edited by two people at a desk of two. Until
 * 2026-09-06 a save wrote whatever the form held over whatever the row held,
 * so the second of two overlapping edits silently undid the first — and the
 * event log recorded both as ordinary updates, which is a record that says
 * the wrong thing happened on purpose.
 *
 * The form now carries the row's own `updated_at` as it was when the page
 * rendered — the trigger-maintained column, never a client clock — and the
 * save refuses when the row has moved since. Two checks, because they close
 * two windows: the action compares the expectation with the row it reads
 * first (the seconds or hours between render and submit), and the UPDATE
 * itself is predicated on the same value (the milliseconds between that read
 * and the write). Both are string comparisons of the timestamptz exactly as
 * PostgREST serialises it, so nothing rounds to a millisecond on the way.
 *
 * A form rendered before this shipped carries no expectation, and a save
 * from it is not refused: the predicate is only ever as strong as what the
 * page sent.
 */

export const EXPECTED_UPDATED_AT = "expected_updated_at";

export function expectedUpdatedAt(formData: {
  get(name: string): FormDataEntryValue | null;
}): string | null {
  const v = formData.get(EXPECTED_UPDATED_AT);
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export const STALE_MESSAGE =
  "This property changed since you opened it — your save was not applied. Reload to see the latest, then make your change again.";

/** The refusal, or null when the row is where the page left it (or the page sent no expectation). */
export function staleMessage(
  expected: string | null,
  currentUpdatedAt: string | null | undefined,
): string | null {
  if (!expected) return null;
  return expected === currentUpdatedAt ? null : STALE_MESSAGE;
}

/**
 * "Saved but not recorded": the UPDATE committed and the event insert that
 * describes it failed. The change is real and stays; the timeline has a
 * hole, and the person who made the change is the one who can tell an admin.
 * DECISIONS T-event-integrity counts this action as the fifteenth accepted
 * instance of that shape — accepted because, unlike the other fourteen, it
 * now says so.
 */
export const NOT_RECORDED_NOTICE =
  "Saved — but the change could not be recorded in the timeline. Tell an admin so the record can be completed.";
