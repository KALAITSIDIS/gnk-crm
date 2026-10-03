import {
  buildErasureEventPayload,
  hasAmlRelationship,
  planContactErasure,
  type ErasurePatch,
} from "./erasure";

/**
 * The ORDER of a contact erasure, and what each failure means — as a pure
 * function over injected steps, so every failure point can be exercised in a
 * unit test without a database.
 *
 * What was wrong before (2026-09-06 audit, A04): the action was fire-and-forget
 * after its first write. The contacts patch — which carries `erased_at` — went
 * FIRST and was the only checked write; lead redaction, requirement deletion,
 * document deletion and storage removal all discarded their errors, so a fault
 * after step one produced a green "erased" toast, a compliance event that could
 * say documents were retained when their delete had failed, and a contact the
 * action then refused to touch again. Worse, the AML-basis reads discarded
 * their errors too, so a failed read computed "no relationship" and DESTROYED
 * documents that Cyprus AML requires the firm to keep.
 *
 * Now:
 *   1. the basis is established or nothing happens — a failed read is an error,
 *      never "no basis";
 *   2. every write runs in an order where a failure leaves a state the next
 *      run can finish: leads → notes → requirements → storage objects → document rows
 *      → the contact patch (with erased_at) LAST → the event;
 *   3. every step is idempotent, so a re-run is safe, and a contact with
 *      `erased_at` set but no `erased` event is exactly the half-finished case
 *      a re-run exists for — refused when the event already exists, and (since
 *      T-erasure-lifecycle-guard) when the row does not hold what the patch
 *      writes: the re-run skips the patch on the marker's word, so a marker
 *      without the redaction must never be recorded as an erasure. Since 0134
 *      no session can write the marker or the event; the check covers rows
 *      from before it. The re-run takes the first run's AML decision from the
 *      row (a stored retention date kept the files, none destroyed them),
 *      refuses when today's basis reads otherwise, and records the stored
 *      date;
 *   4. an error names the step that failed and says what is and is not done.
 *
 * Not a state machine: this is a rare, admin-only, five-write action, and
 * ordering plus propagation plus a re-runnable path is what its failures need.
 */
export interface ErasureBasis {
  dealCount: number;
  viewingSlipCount: number;
  mandateCount: number;
  relationshipEndCandidates: (string | null)[];
}

export interface ErasureSteps {
  /** Throws on any read error — never returns a basis it could not establish. */
  readBasis(): Promise<ErasureBasis>;
  hasErasedEvent(): Promise<boolean>;
  /** Rewrites messages not already redacted; returns how many. */
  redactLeads(): Promise<number>;
  /** 0094: blanks the notes on the contact and on its leads; returns how many. */
  redactNotes(): Promise<number>;
  deleteRequirements(): Promise<number>;
  listDocuments(): Promise<{ id: string; storage_path: string | null }[]>;
  /** Must throw unless every path is absent afterwards. */
  removeObjects(paths: string[]): Promise<void>;
  /** Deletes exactly the listed rows — the ones whose files were just removed. */
  deleteDocumentRows(ids: string[]): Promise<number>;
  /**
   * Returns false when no row matched. Since 0134 the patch runs as the
   * system, bounded by the organisation, the contact and `erased_at is null`,
   * so no row means the contact was erased (or removed) meanwhile.
   */
  patchContact(patch: ErasurePatch): Promise<boolean>;
  writeEvent(payload: Record<string, unknown>): Promise<void>;
}

export interface ErasureRunResult {
  error: string | null;
  erasedAt: string | null;
}

/** The erasure's own record on the row — never a field it redacts. */
const RECORD_COLUMNS = new Set(["erased_at", "erased_by", "retention_until", "gdpr_notes"]);

/** Order-insensitive for object keys; `undefined` and `null` are the same absence. */
function canonical(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * The columns of `patch` the stored row does not hold as the patch writes
 * them — what a contact marked erased still carries that the erasure clears.
 * No stored row at all is every column (fail closed).
 */
export function unredactedColumns(patch: ErasurePatch, stored: Record<string, unknown> | null): string[] {
  return Object.entries(patch)
    .filter(([column]) => !RECORD_COLUMNS.has(column))
    .filter(([column, value]) => !stored || JSON.stringify(canonical(stored[column])) !== JSON.stringify(canonical(value)))
    .map(([column]) => column)
    .sort();
}

async function attempt<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`${label}: ${why}`);
  }
}

export async function runContactErasure(input: {
  alreadyErasedAt: string | null;
  /**
   * The contact as the action read it, before any write. Consulted only on a
   * re-run (`alreadyErasedAt` set): the patch is skipped there because the
   * marker says it ran, so the row must show that it did, and its stored
   * retention date is the record's (T-erasure-lifecycle-guard).
   */
  stored: Record<string, unknown> | null;
  actorId: string;
  now: string;
  steps: ErasureSteps;
}): Promise<ErasureRunResult> {
  const { steps, now } = input;

  // A previous run that got as far as the patch but not the event is the one
  // case a re-run must accept; a run that wrote its event is complete.
  if (input.alreadyErasedAt) {
    const recorded = await attempt("checking the erasure record", () => steps.hasErasedEvent());
    if (recorded) {
      return { error: "This contact's personal data has already been erased.", erasedAt: null };
    }
  }

  // 1. The basis — or nothing. A failed read must never become "no relationship".
  let basis: ErasureBasis;
  try {
    basis = await steps.readBasis();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      error: `Could not establish the retention basis — nothing was erased: ${why}`,
      erasedAt: null,
    };
  }
  // On a re-run the row already says what the first run decided — a stored
  // retention date means files were KEPT under an AML duty, none means they
  // were destroyed — and the re-run takes THAT decision, never today's: a
  // basis read differently now (a record linked to the erased contact since,
  // say) must neither destroy what was kept nor record what was not decided.
  // When the two disagree an administrator decides; nothing is written.
  const storedRetention = input.alreadyErasedAt ? ((input.stored?.retention_until as string | null | undefined) ?? null) : null;
  if (input.alreadyErasedAt && hasAmlRelationship(basis) !== (storedRetention !== null)) {
    return {
      error: `This contact was erased ${storedRetention ? "with its records retained" : "with nothing retained"}, but its retention basis reads differently now, so the erasure will not be recorded as done. Nothing was changed — an administrator must resolve it first (DECISIONS T-erasure-lifecycle-guard).`,
      erasedAt: null,
    };
  }
  const amlBasis = input.alreadyErasedAt ? storedRetention !== null : hasAmlRelationship(basis);
  const plan = planContactErasure({
    amlBasis,
    actorId: input.actorId,
    now,
    relationshipEndCandidates: basis.relationshipEndCandidates,
  });

  // A re-run writes the record without the patch, on the marker's word —
  // so the row must hold what the patch writes. A marker without the
  // redaction (a session could set `erased_at` before 0134) is not an
  // erasure this run may record as done: refuse before any write.
  if (input.alreadyErasedAt) {
    const left = unredactedColumns(plan.patch, input.stored);
    if (left.length > 0) {
      return {
        error: `This contact is marked erased, but it still holds what the erasure clears (${left.join(", ")}), so the erasure will not be recorded as done. Nothing was changed — an administrator must resolve it first (DECISIONS T-erasure-lifecycle-guard).`,
        erasedAt: null,
      };
    }
  }

  // 2. The writes, each propagating, in an order a re-run can finish.
  let leadsRedacted = 0;
  let notesRedacted = 0;
  let requirementsDeleted = 0;
  let documentsDeleted = 0;
  let documentsRetained = 0;
  try {
    leadsRedacted = await attempt("redacting lead messages", () => steps.redactLeads());
    notesRedacted = await attempt("redacting notes", () => steps.redactNotes());
    requirementsDeleted = await attempt("deleting saved searches", () => steps.deleteRequirements());
    const docs = await attempt("listing documents", () => steps.listDocuments());
    if (plan.deleteDocuments && docs.length > 0) {
      // Objects BEFORE rows: a storage failure leaves the rows, and the rows
      // are what the next run uses to find the objects again.
      const paths = docs.map((d) => d.storage_path).filter((p): p is string => Boolean(p));
      await attempt("removing document files", () => steps.removeObjects(paths));
      documentsDeleted = await attempt("deleting document rows", () => steps.deleteDocumentRows(docs.map((d) => d.id)));
      documentsRetained = docs.length - documentsDeleted;
    } else {
      documentsRetained = docs.length;
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      error: `Erasure stopped while ${why}. Nothing already done is lost — run it again to finish.`,
      erasedAt: null,
    };
  }

  // 3. The contact itself, LAST — so erased_at is only ever set on a contact
  //    whose dependants are already gone. Skipped on a re-run that got here.
  if (!input.alreadyErasedAt) {
    let patched: boolean;
    try {
      patched = await steps.patchContact(plan.patch);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return {
        error: `Erasure stopped while redacting the contact: ${why}. Run it again to finish.`,
        erasedAt: null,
      };
    }
    if (!patched) {
      // another run got there first: its event is the record, not this one
      return { error: "This contact was erased meanwhile — reload the page to see its record.", erasedAt: null };
    }
  }

  // 4. The record. If this fails the data is gone and only the record is
  //    missing — which the re-run path above exists to write.
  const payload = buildErasureEventPayload({
    amlBasis,
    retentionUntil: input.alreadyErasedAt ? storedRetention : plan.retentionUntil,
    leadsRedacted,
    notesRedacted,
    requirementsDeleted,
    documentsDeleted,
    documentsRetained,
  });
  try {
    await steps.writeEvent(JSON.parse(JSON.stringify(payload)));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      error: `Erased, but the record of it failed to write: ${why}. Run it again — the data is already gone and only the record will be written.`,
      erasedAt: input.alreadyErasedAt ?? now,
    };
  }

  return { error: null, erasedAt: input.alreadyErasedAt ?? now };
}
