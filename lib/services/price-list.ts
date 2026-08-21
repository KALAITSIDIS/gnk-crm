/**
 * Reading a price list version, and diffing it against the one before
 * (BACKLOG audit finding 4).
 *
 * `createPriceListVersion` has always snapshotted every unit's price into
 * `price_list_items.list_price`. That column was never selected again — the UI
 * could say "version 3 covers 40 units" and could not show one price in it. A
 * snapshot nobody can read is storage, not a record, and "what did we quote in
 * March" is the entire point of versioning for a developer.
 *
 * Pure and tested because a price diff is exactly the kind of thing that is
 * plausible when wrong. A row that silently reports no change, or a total that
 * quietly drops the units added since the last version, is worse than no diff.
 */

export interface PriceListItem {
  unit_id: string;
  list_price: number | string;
  /** joined from properties; a unit deleted since the snapshot has none */
  reference?: string | null;
  unit_label?: string | null;
}

export interface PriceRow {
  unit_id: string;
  label: string;
  price: number;
  /** the same unit's price in the previous version, when it was in one */
  previousPrice: number | null;
  /** price − previousPrice; null when there is nothing to compare against */
  delta: number | null;
  /** delta as a fraction of the previous price; null when previous is 0 or absent */
  deltaPct: number | null;
  /** in this version but not the previous one */
  isNew: boolean;
}

export interface PriceListComparison {
  rows: PriceRow[];
  total: number;
  previousTotal: number | null;
  totalDelta: number | null;
  /** units present in the PREVIOUS version and missing from this one */
  droppedCount: number;
  changedCount: number;
  newCount: number;
}

const toNumber = (v: number | string): number => (typeof v === "number" ? v : Number(v));

function labelOf(item: PriceListItem): string {
  return item.unit_label || item.reference || item.unit_id;
}

/**
 * Compare one version against the one before it.
 *
 * `previous` may be null — the first version has nothing to diff against, and
 * every row is reported with a null delta rather than a fabricated zero. A zero
 * would read as "we held the price", which is a different statement from "there
 * was no previous price".
 *
 * DROPPED UNITS ARE COUNTED, not silently ignored. A unit in the old version and
 * not the new one means the block shrank, or somebody snapshotted before adding
 * it back — either way the reader needs to know the two versions do not cover
 * the same inventory, because otherwise the totals are not comparable.
 */
export function comparePriceLists(
  current: PriceListItem[],
  previous: PriceListItem[] | null,
): PriceListComparison {
  const prevByUnit = new Map<string, number>(
    (previous ?? []).map((i) => [i.unit_id, toNumber(i.list_price)]),
  );

  const rows: PriceRow[] = current.map((item) => {
    const price = toNumber(item.list_price);
    const previousPrice = prevByUnit.has(item.unit_id)
      ? (prevByUnit.get(item.unit_id) as number)
      : null;
    const delta = previousPrice === null ? null : price - previousPrice;
    const deltaPct =
      previousPrice === null || previousPrice === 0 ? null : (price - previousPrice) / previousPrice;
    return {
      unit_id: item.unit_id,
      label: labelOf(item),
      price,
      previousPrice,
      delta,
      deltaPct,
      isNew: previousPrice === null,
    };
  });

  rows.sort((a, b) => a.label.localeCompare(b.label));

  const total = rows.reduce((sum, r) => sum + r.price, 0);
  const previousTotal =
    previous === null ? null : previous.reduce((sum, i) => sum + toNumber(i.list_price), 0);

  const currentIds = new Set(current.map((i) => i.unit_id));
  const droppedCount = (previous ?? []).filter((i) => !currentIds.has(i.unit_id)).length;

  return {
    rows,
    total,
    previousTotal,
    totalDelta: previousTotal === null ? null : total - previousTotal,
    droppedCount,
    changedCount: rows.filter((r) => r.delta !== null && r.delta !== 0).length,
    newCount: rows.filter((r) => r.isNew).length,
  };
}

/**
 * A version's headline, for the collapsed row: what it is worth and how that
 * moved. Kept separate from the full comparison so the list can show a summary
 * per version without building every row for every version.
 */
export function summariseVersion(comparison: PriceListComparison): string {
  const parts: string[] = [`${comparison.rows.length} units`];
  if (comparison.changedCount > 0) parts.push(`${comparison.changedCount} repriced`);
  if (comparison.newCount > 0 && comparison.previousTotal !== null) {
    parts.push(`${comparison.newCount} new`);
  }
  if (comparison.droppedCount > 0) parts.push(`${comparison.droppedCount} dropped`);
  return parts.join(" · ");
}
