/**
 * What a contact owns or built (BACKLOG audit finding 9).
 *
 * The contact page had six tabs and queried `properties` in none of them, so
 * opening a developer showed their phone number and not their inventory. That
 * was unavoidable while finding 2 stood — the two party columns were never
 * written. Now that they are, this is one query and one tab.
 *
 * Pure and tested because the shaping is where it goes wrong: a developer with
 * a 60-unit project must not produce a 60-row list, and a contact who is both
 * the owner of a villa and the developer of a project must appear as both
 * without the villa being counted twice.
 */

export const PORTFOLIO_SELECT =
  "id, reference, kind, parent_id, property_type, transaction_type, status, visibility, title, asking_price, owner_contact_id, developer_contact_id";

export interface PortfolioRow {
  id: string;
  reference: string;
  kind: string;
  parent_id: string | null;
  property_type: string;
  /** sale | rent | sale_or_rent — only a row FOR SALE has an asking price to count */
  transaction_type: string;
  status: string;
  visibility: string;
  /** multilingual jsonb ({en,el,ru}); typed loosely because the generated
   *  type is `Json`, and only `en` is read here — same as every other caller */
  title: unknown;
  asking_price: number | string | null;
  owner_contact_id: string | null;
  developer_contact_id: string | null;
}

export interface UnitRollup {
  total: number;
  /** counts keyed by status, e.g. { available: 40, sold: 12 } */
  byStatus: Record<string, number>;
  /** sum of asking prices across the units FOR SALE that carry one — the
   *  same rows, the same rule, as the portfolio's total */
  value: number;
}

export interface PortfolioEntry {
  id: string;
  reference: string;
  kind: string;
  property_type: string;
  status: string;
  title: string | null;
  asking_price: number | null;
  /** why this contact is attached: they own it, they built it, or both */
  roles: ("owner" | "developer")[];
  /** present for a project — its units are rolled up, never listed */
  units: UnitRollup | null;
}

/** An archived record of this contact's — listed, never counted or totalled. */
export interface ArchivedPortfolioEntry {
  id: string;
  reference: string;
  kind: string;
  property_type: string;
  title: string | null;
  roles: ("owner" | "developer")[];
}

/**
 * This contact's archived units under one container the portfolio also holds
 * (live or archived). Grouped, not listed one row each — a retired 60-unit
 * block must not become 60 rows — but every unit is named and linked: the
 * container's own pages list no archived unit (its units matrix reads
 * `visibility <> 'archived'`), so this is the one place they are reached from
 * here (F04 review).
 */
export interface ArchivedUnitGroup {
  containerId: string;
  containerReference: string;
  /** by reference */
  units: { id: string; reference: string }[];
}

export interface Portfolio {
  /** the live (not archived) records, units rolled into their container */
  entries: PortfolioEntry[];
  /** top-level properties, NOT counting units — the number a person means */
  propertyCount: number;
  unitCount: number;
  /**
   * The asking total, LISTINGS + UNITS (F04): every live standalone listing's
   * asking price and every live unit's — never a project's or a phase's own
   * price, which is a "from" figure its units already carry — and only for
   * what is FOR SALE (sale, sale_or_rent): a rent-only listing has no asking
   * price by design, so it is outside the total and outside `unpricedCount`
   * (`rentOnlyCount` says how many there were). A for-sale row with no asking
   * price adds nothing; `unpricedCount` says how many there were.
   */
  totalValue: number;
  /** live for-sale listings and units in the total's scope with no asking price */
  unpricedCount: number;
  /** live rent-only listings and units: the total does not cover them */
  rentOnlyCount: number;
  /**
   * Archived records, outside every count and the total, so the tab can still
   * say they exist: every archived record except a unit whose container is in
   * the portfolio — those are in `archivedUnits`, grouped under it.
   */
  archived: ArchivedPortfolioEntry[];
  /** archived units grouped under a container in the portfolio, by its reference */
  archivedUnits: ArchivedUnitGroup[];
  /** every archived record: `archived` plus every unit in `archivedUnits` */
  archivedCount: number;
}

const num = (v: number | string | null): number | null =>
  v === null || v === "" ? null : Number(v);

/** A project or a phase: a container, whose units carry the prices. */
const isContainer = (kind: string) => kind === "project" || kind === "phase";

/** Archiving is how a record is retired here (there is no hard delete). */
const isArchived = (row: PortfolioRow) => row.visibility === "archived";

/** What an asking price is for: sale, or sale-or-rent. A rental carries a monthly rent. */
const FOR_SALE: readonly string[] = ["sale", "sale_or_rent"];
const isForSale = (row: PortfolioRow) => FOR_SALE.includes(row.transaction_type);

/** A row's asking price as the total counts it: for sale and priced, else null. */
const saleAsk = (row: PortfolioRow): number | null => (isForSale(row) ? num(row.asking_price) : null);

function rolesFor(row: PortfolioRow, contactId: string): ("owner" | "developer")[] {
  const roles: ("owner" | "developer")[] = [];
  if (row.owner_contact_id === contactId) roles.push("owner");
  if (row.developer_contact_id === contactId) roles.push("developer");
  return roles;
}

const titleOf = (row: PortfolioRow) => (row.title as { en?: string } | null)?.en ?? null;

/**
 * Shape the rows into something a person can read.
 *
 * UNITS ARE ROLLED UP, never listed. The same reasoning as the list's kind
 * filter: a unit is inventory inside a project, and sixty rows of it buries the
 * three things the reader actually came for. "40 available · 12 sold" answers
 * the question the list would only bury.
 *
 * A unit is rolled into its parent when the parent is in the portfolio. A unit
 * whose parent is NOT — possible when the developer built the project but a
 * unit was sold on and its owner changed — stands on its own, because dropping
 * it would silently under-report.
 *
 * ARCHIVED RECORDS ARE NOT INVENTORY (F04). They are left out of the entries,
 * every count, the rollups and the total — the call the properties list makes
 * by default — and listed apart, so archiving a record never hides that it
 * existed. A LIVE unit whose container is archived stands on its own: it is
 * still live, and the properties list shows it.
 *
 * THE TOTAL SUMS LISTINGS AND UNITS, NEVER A CONTAINER'S OWN PRICE (F04). A
 * project's asking price is its "from" figure; adding it on top of the units it
 * is priced from counted the same flats twice (a 300,000 "from" project with
 * two 250,000 units totalled 800,000, where the stock asks 500,000).
 *
 * ONLY WHAT IS FOR SALE HAS AN ASKING PRICE (F04 review). A landlord's two
 * rentals read "2 without an asking price" beside the total — missing data,
 * where nothing was missing. Rent-only rows are outside the total and the
 * unpriced note, and counted apart so the tab can say the total leaves them out.
 *
 * AN ARCHIVED UNIT IS NEVER DROPPED (F04 review). One whose container is in
 * the portfolio used to be left out of the archived list "because the
 * container reaches it" — but the container's units page and record page list
 * no archived unit, so it appeared nowhere and the archived count was short.
 * It is grouped under its container instead, and counted.
 */
export function buildPortfolio(pageRows: PortfolioRow[], contactId: string): Portfolio {
  // Each row counts once. The contact page reads the portfolio in offset pages
  // (fetchAll), and a page is its own snapshot: a property inserted or
  // reassigned between two reads shifts the next page, which then repeats a row
  // already read — counted twice in the total, the unit count and the rollups
  // (integration review 2026-10-19; the sales-velocity and contact-history
  // readers dedupe for the same reason).
  const rows = [...new Map(pageRows.map((r) => [r.id, r])).values()];
  const live = rows.filter((r) => !isArchived(r));
  const liveById = new Map(live.map((r) => [r.id, r]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const units = live.filter((r) => r.kind === "unit");
  const nonUnits = live.filter((r) => r.kind !== "unit");

  let totalValue = 0;
  let unpricedCount = 0;
  let rentOnlyCount = 0;
  const addToTotal = (row: PortfolioRow) => {
    if (!isForSale(row)) {
      rentOnlyCount += 1;
      return;
    }
    const price = saleAsk(row);
    if (price === null) unpricedCount += 1;
    else totalValue += price;
  };

  // units that belong to a live container we are also showing
  const rolled = new Map<string, UnitRollup>();
  const orphanUnits: PortfolioRow[] = [];
  for (const u of units) {
    addToTotal(u);
    if (u.parent_id && liveById.has(u.parent_id)) {
      const roll = rolled.get(u.parent_id) ?? { total: 0, byStatus: {}, value: 0 };
      roll.total += 1;
      roll.byStatus[u.status] = (roll.byStatus[u.status] ?? 0) + 1;
      roll.value += saleAsk(u) ?? 0;
      rolled.set(u.parent_id, roll);
    } else {
      orphanUnits.push(u);
    }
  }
  // a standalone listing is priced on its own; a container is not — its units are
  for (const r of nonUnits) if (!isContainer(r.kind)) addToTotal(r);

  const shown = [...nonUnits, ...orphanUnits];

  const entries: PortfolioEntry[] = shown.map((r) => ({
    id: r.id,
    reference: r.reference,
    kind: r.kind,
    property_type: r.property_type,
    status: r.status,
    title: titleOf(r),
    asking_price: num(r.asking_price),
    roles: rolesFor(r, contactId),
    units: rolled.get(r.id) ?? null,
  }));

  entries.sort((a, b) => a.reference.localeCompare(b.reference));

  const archivedRows = rows.filter(isArchived);
  const underContainer = (r: PortfolioRow) =>
    r.kind === "unit" && r.parent_id !== null && byId.has(r.parent_id);

  const archived: ArchivedPortfolioEntry[] = archivedRows
    .filter((r) => !underContainer(r))
    .map((r) => ({
      id: r.id,
      reference: r.reference,
      kind: r.kind,
      property_type: r.property_type,
      title: titleOf(r),
      roles: rolesFor(r, contactId),
    }))
    .sort((a, b) => a.reference.localeCompare(b.reference));

  const groups = new Map<string, ArchivedUnitGroup>();
  for (const u of archivedRows.filter(underContainer)) {
    const container = byId.get(u.parent_id as string) as PortfolioRow;
    const group = groups.get(container.id) ?? {
      containerId: container.id,
      containerReference: container.reference,
      units: [],
    };
    group.units.push({ id: u.id, reference: u.reference });
    groups.set(container.id, group);
  }
  const archivedUnits = [...groups.values()]
    .map((g) => ({ ...g, units: g.units.sort((a, b) => a.reference.localeCompare(b.reference)) }))
    .sort((a, b) => a.containerReference.localeCompare(b.containerReference));

  return {
    entries,
    propertyCount: entries.length,
    unitCount: units.length - orphanUnits.length,
    totalValue,
    unpricedCount,
    rentOnlyCount,
    archived,
    archivedUnits,
    archivedCount: archived.length + archivedUnits.reduce((n, g) => n + g.units.length, 0),
  };
}
