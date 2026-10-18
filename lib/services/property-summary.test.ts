import { describe, expect, it } from "vitest";
import {
  agentLine,
  availabilityLine,
  isOnWebsite,
  mandateLine,
  nextAction,
  outstandingLine,
  partyLine,
  priceLine,
  type PartyContact,
} from "@/lib/services/property-summary";
import { Constants } from "@/lib/supabase/database.types";

/**
 * A08 PR 3 — the property page's summary strip, cell by cell. The page and the
 * DB test (supabase/tests/property-summary.test.ts) prove the reads; these pin
 * the words, including what is said when a value is missing or unreadable.
 */

const STATUSES = Constants.public.Enums.property_status;
const VISIBILITIES = Constants.public.Enums.visibility_level;

describe("priceLine — the one price expression (summary + Overview facts)", () => {
  const base = { kind: "standalone", transaction_type: "sale", asking_price: null, rent_price_month: null };

  it("a sale: the asking price; a rent: the monthly rent", () => {
    expect(priceLine({ ...base, asking_price: 265000 })).toEqual({ label: "Price", text: "€265.000" });
    expect(priceLine({ ...base, transaction_type: "rent", rent_price_month: 1400 })).toEqual({
      label: "Price",
      text: "€1.400/mo",
    });
  });

  it("a sale never shows the rent, a rent never the asking price", () => {
    expect(priceLine({ ...base, asking_price: 265000, rent_price_month: 1400 }).text).toBe("€265.000");
    expect(
      priceLine({ ...base, transaction_type: "rent", asking_price: 265000, rent_price_month: 1400 }).text,
    ).toBe("€1.400/mo");
  });

  it("sale or rent: both figures, or whichever is set", () => {
    const either = { ...base, transaction_type: "sale_or_rent" };
    expect(priceLine({ ...either, asking_price: 350000, rent_price_month: 1500 }).text).toBe("€350.000 · €1.500/mo");
    expect(priceLine({ ...either, rent_price_month: 1500 }).text).toBe("€1.500/mo");
    expect(priceLine({ ...either, asking_price: 350000 }).text).toBe("€350.000");
  });

  it("no figure is null — never €0 — and a zero that IS recorded is shown", () => {
    expect(priceLine(base).text).toBeNull();
    expect(priceLine({ ...base, transaction_type: "rent", asking_price: 1 }).text).toBeNull();
    expect(priceLine({ ...base, asking_price: Number.NaN }).text).toBeNull();
    expect(priceLine({ ...base, asking_price: 0 }).text).toBe("€0");
  });

  it("a project or phase quotes a FROM price; a unit and a standalone a price", () => {
    expect(priceLine({ ...base, kind: "project", asking_price: 180000 })).toEqual({
      label: "From price",
      text: "€180.000",
    });
    expect(priceLine({ ...base, kind: "phase" }).label).toBe("From price");
    expect(priceLine({ ...base, kind: "unit" }).label).toBe("Price");
  });

  it("cents are kept (formatMoney)", () => {
    expect(priceLine({ ...base, asking_price: 1234.5 }).text).toBe("€1.234,50");
  });
});

describe("availabilityLine — status and visibility as one statement", () => {
  it("Public and Available: on the website", () => {
    expect(availabilityLine("available", "public")).toEqual({
      tone: "success",
      text: "Available · on the website",
      note: null,
    });
    expect(isOnWebsite("available", "public")).toBe(true);
  });

  it("Public in any other status is said to be OFF the website, with the reason (2026-09-03)", () => {
    for (const status of STATUSES.filter((s) => s !== "available")) {
      const line = availabilityLine(status, "public");
      expect(line.tone, status).toBe("warning");
      expect(line.text, status).toMatch(/· Public, but not on the website$/);
      expect(line.note, status).toBe("The website only shows listings whose status is Available.");
      expect(isOnWebsite(status, "public"), status).toBe(false);
    }
    expect(availabilityLine("reserved", "public").text).toBe("Reserved · Public, but not on the website");
    expect(availabilityLine("under_offer", "public").text).toBe("Under offer · Public, but not on the website");
  });

  it("not Public: not on the website, naming the visibility", () => {
    expect(availabilityLine("available", "private")).toEqual({
      tone: "neutral",
      text: "Available · not on the website (Private)",
      note: null,
    });
    expect(availabilityLine("available", "vip").text).toBe("Available · not on the website (VIP)");
    expect(availabilityLine("sold", "off_market").text).toBe("Sold · not on the website (Off-market)");
    expect(availabilityLine("draft", "coming_soon").text).toBe("Draft · not on the website (Coming soon)");
    expect(availabilityLine("withdrawn", "archived")).toEqual({ tone: "neutral", text: "Withdrawn · archived", note: null });
  });

  it("every status × visibility pair: only Public + Available claims the website", () => {
    for (const status of STATUSES) {
      for (const visibility of VISIBILITIES) {
        const line = availabilityLine(status, visibility);
        const claims = line.text.includes("on the website") && !line.text.includes("not on the website");
        expect(claims, `${status} × ${visibility}`).toBe(status === "available" && visibility === "public");
        // every enum value has its words — no raw underscore reaches the page
        expect(line.text, `${status} × ${visibility}`).not.toContain("_");
      }
    }
  });

  it("an unknown value is spelled out rather than dropped", () => {
    expect(availabilityLine("let_agreed", "private").text).toBe("let agreed · not on the website (Private)");
  });
});

describe("partyLine — owner, or the developer for a project", () => {
  const contacts = new Map<string, PartyContact>([
    ["own", { id: "own", label: "Andreas Owner" }],
    ["dev", { id: "dev", label: "Coastline Developments" }],
  ]);

  it("a standalone: its owner, never the developer", () => {
    expect(partyLine("standalone", { owner_contact_id: "own", developer_contact_id: "dev" }, contacts)).toEqual({
      label: "Owner",
      contact: { id: "own", label: "Andreas Owner" },
      text: "Andreas Owner",
    });
    expect(partyLine("standalone", { owner_contact_id: null, developer_contact_id: "dev" }, contacts)).toEqual({
      label: "Owner",
      contact: null,
      text: "Not recorded",
    });
  });

  it("a project or phase: its developer, else its owner, else 'Developer: Not recorded'", () => {
    for (const kind of ["project", "phase"]) {
      expect(partyLine(kind, { owner_contact_id: "own", developer_contact_id: "dev" }, contacts).label).toBe("Developer");
      expect(partyLine(kind, { owner_contact_id: "own", developer_contact_id: "dev" }, contacts).contact?.id).toBe("dev");
      expect(partyLine(kind, { owner_contact_id: "own", developer_contact_id: null }, contacts)).toMatchObject({
        label: "Owner",
        text: "Andreas Owner",
      });
      expect(partyLine(kind, { owner_contact_id: null, developer_contact_id: null }, contacts)).toEqual({
        label: "Developer",
        contact: null,
        text: "Not recorded",
      });
    }
  });

  it("a unit: its owner, else the developer that still owns it", () => {
    expect(partyLine("unit", { owner_contact_id: "own", developer_contact_id: "dev" }, contacts).label).toBe("Owner");
    expect(partyLine("unit", { owner_contact_id: null, developer_contact_id: "dev" }, contacts)).toMatchObject({
      label: "Developer",
      contact: { id: "dev" },
    });
  });

  it("a recorded contact the reader cannot see is said so — never 'Not recorded'", () => {
    expect(partyLine("standalone", { owner_contact_id: "gone", developer_contact_id: null }, contacts)).toEqual({
      label: "Owner",
      contact: null,
      text: "Recorded, but not visible to you",
    });
  });
});

describe("agentLine — the responsible agent, inactive flagged", () => {
  it("active, inactive, unassigned, unreadable", () => {
    expect(agentLine("a1", { full_name: "Maria Agent", is_active: true })).toEqual({
      text: "Maria Agent",
      inactive: false,
      tone: "neutral",
    });
    expect(agentLine("a1", { full_name: "Former Agent", is_active: false })).toEqual({
      text: "Former Agent",
      inactive: true,
      tone: "warning",
    });
    expect(agentLine(null, null)).toEqual({ text: "Not assigned", inactive: false, tone: "neutral" });
    expect(agentLine("a1", null).text).toBe("Assigned, but not visible to you");
    expect(agentLine("a1", { full_name: "  ", is_active: true }).text).toBe("Unnamed user");
  });
});

describe("nextAction — the earlier of the next open task and the next viewing", () => {
  const now = new Date("2026-10-19T09:00:00Z");
  const task = (due_at: string | null) => ({ id: "t1", title: "Call the owner about the roof", due_at });
  const viewing = (scheduled_at: string) => ({ id: "v1", scheduled_at });

  it("a task due before the viewing is the next action — 'Next task' for an admin", () => {
    const n = nextAction({
      task: task("2026-10-21T20:59:00Z"),
      viewing: viewing("2026-10-23T11:00:00Z"),
      now,
      viewerIsAdmin: true,
    });
    expect(n).toMatchObject({
      kind: "task",
      label: "Next task",
      text: "Call the owner about the roof",
      detail: "due 21 Oct 2026",
      overdue: false,
    });
  });

  it("for anyone else it is 'Your next task' — tasks_select narrows what they can see", () => {
    const n = nextAction({ task: task("2026-10-21T20:59:00Z"), viewing: null, now, viewerIsAdmin: false });
    expect(n).toMatchObject({ kind: "task", label: "Your next task" });
  });

  it("a viewing before the task is the next action", () => {
    const n = nextAction({
      task: task("2026-10-25T21:59:00Z"),
      viewing: viewing("2026-10-23T11:00:00Z"),
      now,
      viewerIsAdmin: true,
    });
    expect(n).toMatchObject({ kind: "viewing", label: "Next viewing", text: "23 Oct 2026, 14:00" });
  });

  it("a tie goes to the task", () => {
    const at = "2026-10-23T11:00:00Z";
    expect(nextAction({ task: task(at), viewing: viewing(at), now, viewerIsAdmin: true }).kind).toBe("task");
  });

  it("an overdue task comes first and says it is overdue, with the Cyprus day it was due", () => {
    // 23:59 Cyprus on 18 Oct is 20:59Z: the day it was due is the 18th, not the UTC day
    const n = nextAction({
      task: task("2026-10-18T20:59:00Z"),
      viewing: viewing("2026-10-19T10:00:00Z"),
      now,
      viewerIsAdmin: false,
    });
    expect(n).toMatchObject({ kind: "task", overdue: true, detail: "overdue · was due 18 Oct 2026" });
  });

  it("an undated task yields to a booked viewing, and is shown when there is none", () => {
    expect(
      nextAction({ task: task(null), viewing: viewing("2026-11-30T10:00:00Z"), now, viewerIsAdmin: true }).kind,
    ).toBe("viewing");
    expect(nextAction({ task: task(null), viewing: null, now, viewerIsAdmin: true })).toMatchObject({
      kind: "task",
      detail: "no due date",
      overdue: false,
    });
  });

  it("an unparseable due date is treated as undated, never as overdue", () => {
    expect(nextAction({ task: task("not-a-date"), viewing: null, now, viewerIsAdmin: true })).toMatchObject({
      kind: "task",
      detail: "no due date",
      overdue: false,
    });
  });

  it("none: 'None' — and for a non-admin, 'your tasks only'", () => {
    expect(nextAction({ task: null, viewing: null, now, viewerIsAdmin: true })).toEqual({
      kind: "none",
      label: null,
      text: "None",
      detail: null,
    });
    expect(nextAction({ task: null, viewing: null, now, viewerIsAdmin: false }).kind === "none").toBe(true);
    expect(nextAction({ task: null, viewing: null, now, viewerIsAdmin: false })).toMatchObject({
      detail: "your tasks only",
    });
  });
});

describe("mandateLine — type and expiry, or why there is none", () => {
  const today = "2026-10-19";

  it("an active mandate: its type and expiry", () => {
    expect(mandateLine([{ type: "exclusive", status: "active", expiry_date: "2027-01-12" }], today)).toEqual({
      tone: "success",
      text: "Exclusive · expires 12 Jan 2027",
    });
    expect(mandateLine([{ type: "open", status: "active", expiry_date: null }], today)).toEqual({
      tone: "warning",
      text: "Open · no expiry date",
    });
  });

  it("expiring today is not yet passed; yesterday (Cyprus) has", () => {
    expect(mandateLine([{ type: "verbal", status: "active", expiry_date: today }], today).text).toBe(
      "Verbal · expires 19 Oct 2026",
    );
    expect(mandateLine([{ type: "exclusive", status: "active", expiry_date: "2026-10-18" }], today)).toEqual({
      tone: "danger",
      text: "Exclusive · expiry date 18 Oct 2026 has passed",
    });
  });

  it("the active one is read, whatever else is on the record", () => {
    expect(
      mandateLine(
        [
          { type: "open", status: "expired", expiry_date: "2026-01-01" },
          { type: "exclusive", status: "active", expiry_date: "2027-03-01" },
        ],
        today,
      ).text,
    ).toBe("Exclusive · expires 1 Mar 2027");
  });

  it("no active mandate: the latest expiry, or no mandate at all", () => {
    expect(
      mandateLine(
        [
          { type: "open", status: "expired", expiry_date: "2026-03-03" },
          { type: "exclusive", status: "expired", expiry_date: "2026-08-31" },
          { type: "open", status: "terminated", expiry_date: "2026-09-30" },
        ],
        today,
      ),
    ).toEqual({ tone: "danger", text: "No active mandate · expired 31 Aug 2026" });
    expect(mandateLine([{ type: "open", status: "expired", expiry_date: null }], today).text).toBe(
      "No active mandate · the last one expired",
    );
    expect(mandateLine([], today)).toEqual({ tone: "neutral", text: "No mandate" });
    expect(mandateLine([{ type: "open", status: "draft", expiry_date: "2027-01-01" }], today).text).toBe("No mandate");
  });

  it("a reader who cannot see every mandate (mandates_safe) is never told there is none", () => {
    const partial = { complete: false };
    expect(mandateLine([], today, partial)).toEqual({ tone: "neutral", text: "Not visible to you" });
    expect(mandateLine([{ type: "open", status: "expired", expiry_date: "2026-03-03" }], today, partial).text).toBe(
      "Not visible to you",
    );
    // an active one they can see is true whatever else is hidden
    expect(
      mandateLine([{ type: "exclusive", status: "active", expiry_date: "2027-01-12" }], today, partial).text,
    ).toBe("Exclusive · expires 12 Jan 2027");
  });
});

describe("outstandingLine — a count, the list stays in the readiness panel", () => {
  const item = (key: string) => ({ key });

  it("missing criteria plus data warnings; essentials are not counted twice", () => {
    const q = {
      missing: [item("cover"), item("photos"), item("title_en")],
      warnings: [item("shared_photo")],
      essentialsMissing: [item("cover"), item("title_en")],
    };
    expect(outstandingLine(q, false)).toEqual({
      count: 4,
      tone: "warning",
      text: "4 items",
      detail: "incl. website essentials",
    });
    expect(outstandingLine(q, true).tone).toBe("danger");
  });

  it("one item, and nothing outstanding", () => {
    expect(outstandingLine({ missing: [item("photos")], warnings: [], essentialsMissing: [] }, true)).toEqual({
      count: 1,
      tone: "warning",
      text: "1 item",
      detail: null,
    });
    expect(outstandingLine({ missing: [], warnings: [], essentialsMissing: [] }, true)).toEqual({
      count: 0,
      tone: "success",
      text: "None",
      detail: null,
    });
  });
});
