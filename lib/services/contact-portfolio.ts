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
  "id, reference, kind, parent_id, property_type, status, visibility, title, asking_price, owner_contact_id, developer_contact_id";

export interface PortfolioRow {
  id: string;
  reference: string;
  kind: string;
  parent_id: string | null;
  property_type: string;
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
  /** sum of asking prices across the units that carry one */
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

export interface Portfolio {
  entries: PortfolioEntry[];
  /** top-level properties, NOT counting units — the number a person means */
  propertyCount: number;
  unitCount: number;
  /** asking prices of top-level entries plus rolled-up unit value */
  totalValue: number;
}

const num = (v: number | string | null): number | null =>
  v === null || v === "" ? null : Number(v);

function rolesFor(row: PortfolioRow, contactId: string): ("owner" | "developer")[] {
  const roles: ("owner" | "developer")[] = [];
  if (row.owner_contact_id === contactId) roles.push("owner");
  if (row.developer_contact_id === contactId) roles.push("developer");
  return roles;
}

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
 */
export function buildPortfolio(rows: PortfolioRow[], contactId: string): Portfolio {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const units = rows.filter((r) => r.kind === "unit");
  const nonUnits = rows.filter((r) => r.kind !== "unit");

  // units that belong to a project we are also showing
  const rolled = new Map<string, UnitRollup>();
  const orphanUnits: PortfolioRow[] = [];
  for (const u of units) {
    if (u.parent_id && byId.has(u.parent_id)) {
      const roll = rolled.get(u.parent_id) ?? { total: 0, byStatus: {}, value: 0 };
      roll.total += 1;
      roll.byStatus[u.status] = (roll.byStatus[u.status] ?? 0) + 1;
      roll.value += num(u.asking_price) ?? 0;
      rolled.set(u.parent_id, roll);
    } else {
      orphanUnits.push(u);
    }
  }

  const shown = [...nonUnits, ...orphanUnits];

  const entries: PortfolioEntry[] = shown.map((r) => ({
    id: r.id,
    reference: r.reference,
    kind: r.kind,
    property_type: r.property_type,
    status: r.status,
    title: (r.title as { en?: string } | null)?.en ?? null,
    asking_price: num(r.asking_price),
    roles: rolesFor(r, contactId),
    units: rolled.get(r.id) ?? null,
  }));

  entries.sort((a, b) => a.reference.localeCompare(b.reference));

  const unitCount = units.length - orphanUnits.length;
  const totalValue = entries.reduce(
    (sum, e) => sum + (e.asking_price ?? 0) + (e.units?.value ?? 0),
    0,
  );

  return {
    entries,
    propertyCount: entries.length,
    unitCount,
    totalValue,
  };
}
