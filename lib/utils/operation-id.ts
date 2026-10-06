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
