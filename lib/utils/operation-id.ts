/**
 * One id per logical submission of a form (T-price-uplift-atomic, 0141).
 *
 * The id is minted when the form is SUBMITTED and kept for as long as the
 * person submits exactly the same thing: a retry after an error or a lost
 * answer sends the same id, so the database answers what it committed the
 * first time instead of applying it again. Change any field — or let the page
 * redraw with new prices, which changes the reviewed scope the form sends —
 * and the next submission is a new one with a new id.
 *
 * Minted at submit time in a ref, never rendered: an id drawn during render
 * would differ between the server's HTML and the client's hydration, and a
 * hidden input's defaultValue is not storage (React re-syncs it).
 *
 * AN UNCONFIRMED ANSWER PINS THE ID. When the outcome is unknown — the
 * request may have committed — the next press reuses the id WHATEVER the form
 * now holds, until an answer is definite: the database then answers what it
 * committed ("replayed"), applies it once if it never did, or refuses a
 * changed request under the same id. A redraw between the two presses (new
 * prices in the reviewed scope) would otherwise mint a new id, and a new id
 * over the committed prices applies the change a second time (review of
 * T-price-uplift-atomic, 2026-10-05).
 */

export type OperationRef = { current: { key: string; id: string; unresolved?: boolean } | null };

/** A version-4 UUID — `crypto.randomUUID` where the context is secure, else built from getRandomValues. */
export function newOperationId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Everything the form submits except the id itself, in a stable order. */
export function submissionKey(fd: FormData, idField = "operation_id"): string {
  return JSON.stringify(
    [...fd.entries()]
      .filter(([k]) => k !== idField)
      .map(([k, v]) => [k, typeof v === "string" ? v : v.name] as const)
      .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]))),
  );
}

/**
 * Stamp `fd` with this submission's id: the previous one if nothing changed —
 * or, after an unconfirmed answer, whatever changed — else a new one.
 */
export function stampOperationId(ref: OperationRef, fd: FormData, idField = "operation_id"): string {
  const key = submissionKey(fd, idField);
  if (!ref.current || (!ref.current.unresolved && ref.current.key !== key)) {
    ref.current = { key, id: newOperationId() };
  }
  fd.set(idField, ref.current.id);
  return ref.current.id;
}

/** After an answer: an unconfirmed one keeps the id pinned; a definite one releases it. */
export function settleOperation(ref: OperationRef, unconfirmed: boolean): void {
  if (ref.current) ref.current.unresolved = unconfirmed;
}

/** What `sendPinned` needs to read from an action's answer. */
export type PinnedAnswer = {
  error: string | null;
  savedAt: number | null;
  unconfirmed?: boolean;
  busy?: boolean;
};

/**
 * One press of a form whose submission the person may REPEAT ON PURPOSE once
 * it committed — a unit-type stamp (T-unit-type-apply-atomic, 0142). Unlike a
 * reviewed reprice, nothing a stamp sends changes when it commits (project,
 * type, block), so the key alone cannot tell "press again to check" from
 * "stamp it again":
 *
 * - a COMMITTED answer spends the id — the next press is a new submission
 *   (otherwise a deliberate re-stamp on the same page would be "replayed" and
 *   never applied);
 * - an UNKNOWN answer — or a throw, or a lock wait on a press that was itself
 *   re-sending an unknown submission (its original may still be running and
 *   commit) — keeps the id pinned and says `unknown`;
 * - a definite refusal releases the pin (the same fields keep the id; nothing
 *   was committed under it).
 *
 * The button is disabled while a press is pending, so a double click cannot
 * mint two ids for one submission.
 */
export async function sendPinned<S extends PinnedAnswer>(
  ref: OperationRef,
  fd: FormData,
  send: (fd: FormData) => Promise<S>,
  unknown: S,
): Promise<S> {
  const retrying = ref.current?.unresolved === true;
  stampOperationId(ref, fd);
  let result: S;
  try {
    result = await send(fd);
  } catch {
    // the request never came back: it may have committed
    result = unknown;
  }
  if (retrying && result.busy) result = unknown;
  if (result.savedAt !== null && !result.error) {
    ref.current = null;
  } else {
    settleOperation(ref, result.unconfirmed === true);
  }
  return result;
}
