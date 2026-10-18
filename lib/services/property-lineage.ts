/**
 * Where a property sits in the hierarchy — project › phase › unit — told from
 * `parent_id` and `kind` ONLY (review 2026-10-18, A05).
 *
 * The model has been in the schema since 0001: `properties.parent_id` and
 * `kind` (standalone | project | phase | unit), with two CHECKs — a unit and a
 * phase each have a parent. Doc 01 says the rest: a phase's parent is a
 * project; a unit's parent is a phase or a project; a standalone, and a
 * project, have none. Nothing in the database binds the parent's KIND or the
 * depth (BACKLOG "Phase 1 — the constraint migration", the unshipped
 * `properties_parent_kind` trigger), and `parent_id` is still a single-column
 * key that accepts another organisation's row (BACKLOG, the composite-key
 * series). So a record can, in data, sit under the wrong kind of parent, under
 * a parent this reader cannot see, or deeper than the model allows.
 *
 * THE RULE HERE: what the rows say is shown, and an anomaly is SAID — never
 * guessed around. A reference such as PAF0002-P1-A101 looks like it names its
 * parents, but it is a naming convention written at creation, not a
 * relationship: nothing in this module (or its reader) reads a reference to
 * decide anything. A parent that cannot be read is "not visible" or "could not
 * be loaded", never "none" — "this unit has no project" and "the read failed"
 * are different facts.
 *
 * This file is the ONE place the rules live. Pure, so every case is a test;
 * the reader (lib/queries/property-lineage.ts) does at most two reads and asks
 * this module what they mean.
 */

/** What a record is, in words — the Overview's "Kind" and the breadcrumb's tags. */
const KIND_LABELS: Record<string, string> = {
  standalone: "Standalone",
  project: "Project",
  phase: "Phase",
  unit: "Unit",
};

/** "Unit" for `unit` — a kind the enum grows is shown as itself rather than dropped. */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** "a unit" / "an …": a kind in a sentence. */
function aKind(kind: string): string {
  const word = kindLabel(kind).toLowerCase();
  // "a unit", "a project": a vowel LETTER is not a vowel sound, and no kind starts with one
  return /^[aeio]/.test(word) ? `an ${word}` : `a ${word}`;
}

const capitalised = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** One ancestor, as the reader returns it. */
export interface LineageNode {
  id: string;
  reference: string;
  kind: string;
  /** the English title, when there is one */
  title: string | null;
  visibility: string;
  /**
   * The node's OWN parent. Read with it so that a further ancestor is KNOWN to
   * exist (too deep) without a third read.
   */
  parent_id: string | null;
}

/** The record whose lineage is asked for. */
export interface LineageRow {
  id: string;
  kind: string;
  parent_id: string | null;
}

/** What one ancestor read came back as. */
export type AncestorRead =
  | { state: "found"; node: LineageNode }
  /** no row came back: RLS hides it (another organisation's row) — a key cannot point at nothing */
  | { state: "absent" }
  /** the read itself failed: unknown, not absent */
  | { state: "failed" };

export type LineageIssueCode =
  /** a unit or a phase with no parent at all — the 0001 CHECKs forbid it, so it is said if it happens */
  | "missing_parent"
  /** the parent's id names no row this reader can see */
  | "parent_unreadable"
  /** the read failed: the trail is unknown, not empty */
  | "read_failed"
  /** a parent of a kind the model does not allow (a unit under a standalone, a phase under a phase, …) */
  | "unexpected_parent_kind"
  /** a further ancestor exists above the place the model ends */
  | "too_deep";

export interface LineageIssue {
  code: LineageIssueCode;
  /** the sentence the page shows, as it is — said, never softened into a guess */
  text: string;
}

export interface Lineage {
  /**
   * The ancestors that were read, ROOT FIRST — the trail as the rows have it,
   * including a parent of an unexpected kind (it IS the recorded parent; the
   * issue says why it is wrong). Never a node inferred from anything else.
   */
  chain: LineageNode[];
  issue: LineageIssue | null;
}

const TELL_AN_ADMIN = "Tell an admin.";

/** True when the reader should ask for the parent's parent: a unit whose parent is a phase. */
export function needsGrandparent(row: LineageRow, parent: LineageNode): boolean {
  return row.kind === "unit" && parent.kind === "phase" && parent.parent_id !== null;
}

/** The parent kinds the model allows for a kind; empty = must have no parent. */
function allowedParents(kind: string): readonly string[] {
  if (kind === "unit") return ["project", "phase"];
  if (kind === "phase") return ["project"];
  return [];
}

function unreadable(read: { state: "absent" } | { state: "failed" }, what: string): LineageIssue {
  return read.state === "failed"
    ? {
        code: "read_failed",
        text: `${what} could not be loaded — reload the page; if it stays, ${TELL_AN_ADMIN.toLowerCase()}`,
      }
    : {
        code: "parent_unreadable",
        text: `${what} is not visible to you — it may belong to another organisation. ${TELL_AN_ADMIN}`,
      };
}

/** A top-of-the-model node (a project) that itself has a parent. */
function tooDeep(top: LineageNode): LineageIssue {
  return {
    code: "too_deep",
    text: `${top.reference} itself has a parent — the hierarchy is deeper than project › phase › unit. ${TELL_AN_ADMIN}`,
  };
}

/**
 * What the reads mean. `parent` is the read of `row.parent_id`; `grandparent`
 * the read of the parent's parent, asked only when `needsGrandparent` says so.
 * Cannot loop: it looks at no more than the two reads it is handed.
 */
export function assessLineage(
  row: LineageRow,
  parent?: AncestorRead,
  grandparent?: AncestorRead,
): Lineage {
  const allowed = allowedParents(row.kind);

  if (row.parent_id === null) {
    if (allowed.length === 0) return { chain: [], issue: null };
    return {
      chain: [],
      issue: {
        code: "missing_parent",
        text: `This ${kindLabel(row.kind).toLowerCase()} has no parent recorded — ${aKind(row.kind)} belongs to ${
          row.kind === "unit" ? "a project or a phase" : "a project"
        }. ${TELL_AN_ADMIN}`,
      },
    };
  }

  if (!parent || parent.state !== "found") {
    return { chain: [], issue: unreadable(parent ?? { state: "failed" }, "Its parent record") };
  }
  const p = parent.node;

  if (p.id === row.id) {
    return {
      chain: [],
      issue: { code: "unexpected_parent_kind", text: `This record is recorded as its own parent. ${TELL_AN_ADMIN}` },
    };
  }

  if (allowed.length === 0) {
    return {
      chain: [p],
      issue: {
        code: "unexpected_parent_kind",
        text: `${capitalised(aKind(row.kind))} has no parent, but this one is recorded under ${p.reference}, ${aKind(p.kind)}. ${TELL_AN_ADMIN}`,
      },
    };
  }

  if (!allowed.includes(p.kind)) {
    return {
      chain: [p],
      issue: {
        code: "unexpected_parent_kind",
        text: `${capitalised(aKind(row.kind))} belongs to ${
          row.kind === "unit" ? "a project or a phase" : "a project"
        }, but this one is recorded under ${p.reference}, ${aKind(p.kind)}. ${TELL_AN_ADMIN}`,
      },
    };
  }

  // the parent is a project: the model ends there
  if (p.kind === "project") {
    return { chain: [p], issue: p.parent_id === null ? null : tooDeep(p) };
  }

  // a unit under a phase: the phase must be under a project, and the project nowhere
  if (p.parent_id === null) {
    return {
      chain: [p],
      issue: {
        code: "missing_parent",
        text: `Its phase ${p.reference} has no project recorded — a phase belongs to a project. ${TELL_AN_ADMIN}`,
      },
    };
  }
  if (!grandparent || grandparent.state !== "found") {
    return { chain: [p], issue: unreadable(grandparent ?? { state: "failed" }, `The project above ${p.reference}`) };
  }
  const g = grandparent.node;
  if (g.kind !== "project") {
    return {
      chain: [g, p],
      issue: {
        code: "unexpected_parent_kind",
        text: `Its phase ${p.reference} is recorded under ${g.reference}, ${aKind(g.kind)} — a phase belongs to a project. ${TELL_AN_ADMIN}`,
      },
    };
  }
  return { chain: [g, p], issue: g.parent_id === null ? null : tooDeep(g) };
}

/**
 * The node a "Units matrix" link should open on: the recorded parent, when it
 * is a container a unit can be listed under. Null for anything else — a matrix
 * link to a standalone would open a redirect, not the unit's row.
 */
export function matrixParent(row: LineageRow, lineage: Lineage): LineageNode | null {
  if (row.kind !== "unit" || row.parent_id === null) return null;
  const parent = lineage.chain[lineage.chain.length - 1];
  if (!parent || parent.id !== row.parent_id) return null;
  return parent.kind === "project" || parent.kind === "phase" ? parent : null;
}
