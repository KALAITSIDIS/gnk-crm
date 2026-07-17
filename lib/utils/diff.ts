/**
 * Loose cross-representation equality for update-event diffs: DB values arrive
 * as strings/numbers/booleans/jsonb while parsed form values are strings or
 * numbers — normalize both sides before comparing. Lives outside the "use
 * server" actions files (only async exports are allowed there).
 */

export function changedValue(oldVal: unknown, newVal: unknown): boolean {
  return normalize(oldVal) !== normalize(newVal);
}

function normalize(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "object") return stableStringify(v);
  return String(v);
}

/**
 * JSON.stringify with object keys sorted at every depth. Postgres jsonb
 * re-orders keys (e.g. {en,el} comes back as {el,en}), so a plain stringify
 * flags an unchanged multilang field as changed on every save.
 */
export function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeysDeep(v));
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, val]) => [key, sortKeysDeep(val)]),
    );
  }
  return v;
}
