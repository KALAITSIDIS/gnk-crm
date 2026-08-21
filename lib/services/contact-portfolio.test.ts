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

  it("totals the top-level prices plus the rolled-up unit value", () => {
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
    });
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
