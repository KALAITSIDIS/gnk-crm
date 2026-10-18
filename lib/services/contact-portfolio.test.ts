import { describe, expect, it } from "vitest";
import {
  buildPortfolio,
  PORTFOLIO_SELECT,
  type PortfolioRow,
} from "./contact-portfolio";

const DEV = "dev-1";

const row = (over: Partial<PortfolioRow> & { id: string; reference: string }): PortfolioRow => ({
  kind: "standalone",
  parent_id: null,
  property_type: "apartment",
  status: "available",
  visibility: "private",
  title: null,
  asking_price: null,
  owner_contact_id: null,
  developer_contact_id: null,
  ...over,
});

describe("buildPortfolio", () => {
  it("rolls a project's units up instead of listing them", () => {
    // the same reasoning as the list's kind filter: sixty unit rows bury the
    // three things the reader came for
    const rows = [
      row({ id: "p1", reference: "PAF0002", kind: "project", developer_contact_id: DEV }),
      ...Array.from({ length: 40 }, (_, i) =>
        row({
          id: `u${i}`,
          reference: `PAF0002-A${i}`,
          kind: "unit",
          parent_id: "p1",
          status: i < 12 ? "sold" : "available",
          asking_price: 250000,
          developer_contact_id: DEV,
        }),
      ),
    ];

    const portfolio = buildPortfolio(rows, DEV);
    expect(portfolio.entries).toHaveLength(1);
    expect(portfolio.propertyCount).toBe(1);
    expect(portfolio.unitCount).toBe(40);
    expect(portfolio.entries[0].units).toEqual({
      total: 40,
      byStatus: { sold: 12, available: 28 },
      value: 40 * 250000,
    });
  });

  it("names both roles when a contact owns AND built the same property", () => {
    // a developer still owns the units it has not sold — the two are not
    // exclusive and the tab must not have to pick one
    const portfolio = buildPortfolio(
      [row({ id: "p1", reference: "PAF0001", owner_contact_id: DEV, developer_contact_id: DEV })],
      DEV,
    );
    expect(portfolio.entries[0].roles).toEqual(["owner", "developer"]);
    expect(portfolio.propertyCount).toBe(1); // counted once, not twice
  });

  it("distinguishes owning from building", () => {
    const portfolio = buildPortfolio(
      [
        row({ id: "a", reference: "PAF0001", owner_contact_id: DEV }),
        row({ id: "b", reference: "PAF0002", kind: "project", developer_contact_id: DEV }),
      ],
      DEV,
    );
    expect(portfolio.entries.map((e) => e.roles)).toEqual([["owner"], ["developer"]]);
  });

  it("shows a unit on its own when its project is not in the portfolio", () => {
    // a sold-on unit whose owner changed: dropping it would under-report
    const portfolio = buildPortfolio(
      [
        row({
          id: "u1",
          reference: "PAF0002-A101",
          kind: "unit",
          parent_id: "not-in-this-portfolio",
          owner_contact_id: DEV,
          asking_price: 250000,
        }),
      ],
      DEV,
    );
    expect(portfolio.entries).toHaveLength(1);
    expect(portfolio.entries[0].reference).toBe("PAF0002-A101");
    expect(portfolio.unitCount).toBe(0); // it is a property here, not a rollup
    expect(portfolio.totalValue).toBe(250000);
  });

  it("totals the listing prices plus the rolled-up unit value", () => {
    const portfolio = buildPortfolio(
      [
        row({ id: "a", reference: "PAF0001", owner_contact_id: DEV, asking_price: 850000 }),
        row({ id: "p", reference: "PAF0002", kind: "project", developer_contact_id: DEV }),
        row({
          id: "u",
          reference: "PAF0002-A101",
          kind: "unit",
          parent_id: "p",
          developer_contact_id: DEV,
          asking_price: 250000,
        }),
      ],
      DEV,
    );
    expect(portfolio.totalValue).toBe(1100000);
    expect(portfolio.propertyCount).toBe(2);
    expect(portfolio.unitCount).toBe(1);
  });

  it("treats an unpriced property as zero rather than NaN", () => {
    const portfolio = buildPortfolio(
      [row({ id: "a", reference: "PAF0001", owner_contact_id: DEV, asking_price: null })],
      DEV,
    );
    expect(portfolio.totalValue).toBe(0);
    expect(portfolio.entries[0].asking_price).toBeNull();
    // …and SAYS the total is short of it: a missing price is not a zero
    expect(portfolio.unpricedCount).toBe(1);
  });

  it("copes with numeric strings, which is what postgres returns", () => {
    const portfolio = buildPortfolio(
      [row({ id: "a", reference: "PAF0001", owner_contact_id: DEV, asking_price: "850000.00" })],
      DEV,
    );
    expect(portfolio.totalValue).toBe(850000);
  });

  it("sorts by reference so the list is stable between renders", () => {
    const portfolio = buildPortfolio(
      [
        row({ id: "c", reference: "PAF0003", owner_contact_id: DEV }),
        row({ id: "a", reference: "PAF0001", owner_contact_id: DEV }),
        row({ id: "b", reference: "PAF0002", owner_contact_id: DEV }),
      ],
      DEV,
    );
    expect(portfolio.entries.map((e) => e.reference)).toEqual(["PAF0001", "PAF0002", "PAF0003"]);
  });

  it("is empty for a contact with nothing", () => {
    expect(buildPortfolio([], DEV)).toEqual({
      entries: [],
      propertyCount: 0,
      unitCount: 0,
      totalValue: 0,
      unpricedCount: 0,
      archived: [],
    });
  });
});

/**
 * F04: the asking total sums LISTINGS and UNITS. A project's (or a phase's)
 * own asking price is its "from" figure; the old total added it on top of the
 * very units it is priced from, and counted archived records as inventory.
 */
describe("buildPortfolio — the asking total (F04)", () => {
  it("never adds a project's own 'from' price on top of its units", () => {
    // 300,000 from + 2 × 250,000 used to total 800,000
    const portfolio = buildPortfolio(
      [
        row({ id: "p", reference: "PAF0002", kind: "project", developer_contact_id: DEV, asking_price: 300000 }),
        row({ id: "u1", reference: "PAF0002-A1", kind: "unit", parent_id: "p", developer_contact_id: DEV, asking_price: 250000 }),
        row({ id: "u2", reference: "PAF0002-A2", kind: "unit", parent_id: "p", developer_contact_id: DEV, asking_price: 250000 }),
      ],
      DEV,
    );
    expect(portfolio.totalValue).toBe(500000);
    expect(portfolio.entries[0].units?.value).toBe(500000);
    // the container's own price is still there for the row to show as "from"
    expect(portfolio.entries[0].asking_price).toBe(300000);
    expect(portfolio.unpricedCount).toBe(0);
  });

  it("a project with no units in the portfolio contributes nothing — its price is a 'from' figure", () => {
    const portfolio = buildPortfolio(
      [
        row({ id: "a", reference: "PAF0001", owner_contact_id: DEV, asking_price: 850000 }),
        row({ id: "p", reference: "PAF0002", kind: "project", developer_contact_id: DEV, asking_price: 300000 }),
      ],
      DEV,
    );
    expect(portfolio.totalValue).toBe(850000);
    // an unpriced container is not "a listing without a price": it is outside the total's scope
    expect(portfolio.unpricedCount).toBe(0);
  });

  it("units under a phase count once — not again through the phase or the project", () => {
    const portfolio = buildPortfolio(
      [
        row({ id: "p", reference: "PAF0003", kind: "project", developer_contact_id: DEV, asking_price: 400000 }),
        row({ id: "ph", reference: "PAF0003-B", kind: "phase", parent_id: "p", developer_contact_id: DEV, asking_price: 350000 }),
        row({ id: "u1", reference: "PAF0003-B1", kind: "unit", parent_id: "ph", developer_contact_id: DEV, asking_price: 200000 }),
        row({ id: "u2", reference: "PAF0003-B2", kind: "unit", parent_id: "ph", developer_contact_id: DEV, asking_price: 200000 }),
      ],
      DEV,
    );
    expect(portfolio.totalValue).toBe(400000);
    const byRef = Object.fromEntries(portfolio.entries.map((e) => [e.reference, e]));
    expect(byRef["PAF0003-B"].units).toEqual({ total: 2, byStatus: { available: 2 }, value: 400000 });
    expect(byRef.PAF0003.units).toBeNull();
    expect(portfolio.unitCount).toBe(2);
    expect(portfolio.propertyCount).toBe(2);
  });

  it("a standalone listing still counts its own price, and an orphan unit its own", () => {
    const portfolio = buildPortfolio(
      [
        row({ id: "a", reference: "PAF0001", owner_contact_id: DEV, asking_price: 850000 }),
        row({ id: "u", reference: "PAF0009-A1", kind: "unit", parent_id: "elsewhere", owner_contact_id: DEV, asking_price: 150000 }),
      ],
      DEV,
    );
    expect(portfolio.totalValue).toBe(1000000);
  });

  it("counts the listings and units with no asking price, never the containers", () => {
    const portfolio = buildPortfolio(
      [
        row({ id: "a", reference: "PAF0001", owner_contact_id: DEV, asking_price: null }),
        row({ id: "b", reference: "PAF0004", owner_contact_id: DEV, asking_price: 100000 }),
        row({ id: "p", reference: "PAF0002", kind: "project", developer_contact_id: DEV, asking_price: null }),
        row({ id: "u1", reference: "PAF0002-A1", kind: "unit", parent_id: "p", developer_contact_id: DEV, asking_price: null }),
        row({ id: "u2", reference: "PAF0002-A2", kind: "unit", parent_id: "p", developer_contact_id: DEV, asking_price: 250000 }),
      ],
      DEV,
    );
    expect(portfolio.totalValue).toBe(350000);
    expect(portfolio.unpricedCount).toBe(2);
  });
});

describe("buildPortfolio — archived records (F04)", () => {
  it("an archived unit leaves the rollup, the unit count and the total", () => {
    const portfolio = buildPortfolio(
      [
        row({ id: "p", reference: "PAF0002", kind: "project", developer_contact_id: DEV }),
        row({ id: "u1", reference: "PAF0002-A1", kind: "unit", parent_id: "p", developer_contact_id: DEV, asking_price: 250000 }),
        row({
          id: "u2",
          reference: "PAF0002-A2",
          kind: "unit",
          parent_id: "p",
          developer_contact_id: DEV,
          asking_price: 990000,
          visibility: "archived",
        }),
      ],
      DEV,
    );
    expect(portfolio.totalValue).toBe(250000);
    expect(portfolio.unitCount).toBe(1);
    expect(portfolio.entries[0].units).toEqual({ total: 1, byStatus: { available: 1 }, value: 250000 });
    // reached through its project's units page, not listed one by one
    expect(portfolio.archived).toEqual([]);
  });

  it("an archived listing is listed apart — never counted, never totalled", () => {
    const portfolio = buildPortfolio(
      [
        row({ id: "a", reference: "PAF0001", owner_contact_id: DEV, asking_price: 850000 }),
        row({
          id: "z",
          reference: "PAF0007",
          owner_contact_id: DEV,
          asking_price: 400000,
          visibility: "archived",
          title: { en: "Old villa" },
        }),
      ],
      DEV,
    );
    expect(portfolio.propertyCount).toBe(1);
    expect(portfolio.entries.map((e) => e.reference)).toEqual(["PAF0001"]);
    expect(portfolio.totalValue).toBe(850000);
    expect(portfolio.archived).toEqual([
      { id: "z", reference: "PAF0007", kind: "standalone", property_type: "apartment", title: "Old villa", roles: ["owner"] },
    ]);
  });

  it("an archived project is listed once, its archived units through it; a LIVE unit of it stands alone", () => {
    const portfolio = buildPortfolio(
      [
        row({ id: "p", reference: "PAF0005", kind: "project", developer_contact_id: DEV, visibility: "archived" }),
        row({ id: "u1", reference: "PAF0005-A1", kind: "unit", parent_id: "p", developer_contact_id: DEV, visibility: "archived", asking_price: 100000 }),
        row({ id: "u2", reference: "PAF0005-A2", kind: "unit", parent_id: "p", developer_contact_id: DEV, asking_price: 120000 }),
      ],
      DEV,
    );
    expect(portfolio.archived.map((a) => a.reference)).toEqual(["PAF0005"]);
    // still live — the properties list shows it, so the portfolio does too
    expect(portfolio.entries.map((e) => e.reference)).toEqual(["PAF0005-A2"]);
    expect(portfolio.totalValue).toBe(120000);
    expect(portfolio.unitCount).toBe(0);
  });

  it("an archived unit whose container is not in the portfolio is listed itself", () => {
    const portfolio = buildPortfolio(
      [
        row({
          id: "u",
          reference: "PAF0009-A1",
          kind: "unit",
          parent_id: "elsewhere",
          owner_contact_id: DEV,
          visibility: "archived",
          asking_price: 150000,
        }),
      ],
      DEV,
    );
    expect(portfolio.entries).toEqual([]);
    expect(portfolio.totalValue).toBe(0);
    expect(portfolio.archived.map((a) => a.reference)).toEqual(["PAF0009-A1"]);
  });
});

describe("PORTFOLIO_SELECT", () => {
  it("selects both party columns — the query filters on them", () => {
    const columns = PORTFOLIO_SELECT.split(",").map((c) => c.trim());
    expect(columns).toContain("owner_contact_id");
    expect(columns).toContain("developer_contact_id");
  });

  it("selects what the rollup needs: kind, parent and status", () => {
    const columns = PORTFOLIO_SELECT.split(",").map((c) => c.trim());
    for (const c of ["kind", "parent_id", "status", "asking_price"]) {
      expect(columns).toContain(c);
    }
  });
});
