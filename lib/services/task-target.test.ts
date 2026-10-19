import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import {
  TASK_KINDS,
  isTaskKind,
  leadTarget,
  taskTarget,
  type TaskLinks,
} from "./task-target";
import { isPropertyTab, PROPERTY_TABS } from "./property-tabs";

/**
 * taskTarget / leadTarget (A01): every reminder opens the page where the thing
 * it asks for is done, the same on the dashboard and on /tasks.
 *
 * The fixture rows carry exactly the link columns each minting site stamps
 * (cited per case), so "a reservation reminder also names the buyer" is
 * tested as the database writes it — the contact must not win.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const P = "11111111-1111-4111-8111-111111111111"; // property
const C = "22222222-2222-4222-8222-222222222222"; // contact
const D = "33333333-3333-4333-8333-333333333333"; // deal
const V = "44444444-4444-4444-8444-444444444444"; // viewing
const L = "55555555-5555-4555-8555-555555555555"; // lead
const R = "66666666-6666-4666-8666-666666666666"; // reservation
const I = "77777777-7777-4777-8777-777777777777"; // instalment
const M = "88888888-8888-4888-8888-888888888888"; // mandate

const none: TaskLinks = {
  kind: null,
  viewing_id: null,
  deal_id: null,
  contact_id: null,
  lead_id: null,
  property_id: null,
  reservation_id: null,
  installment_id: null,
  mandate_id: null,
};
const row = (over: Partial<TaskLinks>): TaskLinks => ({ ...none, ...over });

describe("taskTarget — each system kind opens the page that clears it", () => {
  // [kind, the columns its minting site stamps, expected type, expected href]
  const cases: [string, Partial<TaskLinks>, string, string][] = [
    // 0126:408 — viewing_id + property_id
    ["viewing_feedback", { viewing_id: V, property_id: P }, "viewing", `/viewings/${V}`],
    // 0126:460
    ["viewing_no_show", { viewing_id: V, property_id: P }, "viewing", `/viewings/${V}`],
    // 0126:355 — deal_id only
    ["deal_no_contact", { deal_id: D }, "deal", `/deals/${D}`],
    // 0126:502 — contact_id only
    ["retention_expired", { contact_id: C }, "contact", `/contacts/${C}`],
    // 0125:536 — lead_id + property_id: answered in the inbox, not on the listing
    ["lead_unanswered", { lead_id: L, property_id: P }, "leads", "/leads"],
    // 0122:364 — property_id + mandate_id
    ["mandate_renewal", { property_id: P, mandate_id: M }, "property", `/properties/${P}?tab=mandate`],
    // 0122:249
    ["key_recall", { property_id: P, mandate_id: M }, "property", `/properties/${P}?tab=mandate`],
    // 0126:698 — property + CONTACT + reservation: the hold is on the property
    [
      "reservation_expiring",
      { property_id: P, contact_id: C, reservation_id: R },
      "property",
      `/properties/${P}?tab=reservation`,
    ],
    // 0126:801 — property + contact + reservation + instalment
    [
      "installment_due",
      { property_id: P, contact_id: C, reservation_id: R, installment_id: I },
      "property",
      `/properties/${P}?tab=reservation`,
    ],
    // followup-tasks.ts — property + reservation + DEAL: the hold, not the deal
    [
      "reservation_still_live",
      { property_id: P, reservation_id: R, deal_id: D },
      "property",
      `/properties/${P}?tab=reservation`,
    ],
    // deals.ts — property + DEAL: the listing's status, not the won deal
    ["listing_status_check", { property_id: P, deal_id: D }, "property", `/properties/${P}`],
    // match-alerts.ts — property only
    ["price_drop_match", { property_id: P }, "property", `/properties/${P}?tab=buyers`],
    ["new_listing_match", { property_id: P }, "property", `/properties/${P}?tab=buyers`],
    ["bulk_price_drop_match", { property_id: P }, "property", `/properties/${P}?tab=buyers`],
  ];

  it.each(cases)("%s", (kind, cols, type, href) => {
    expect(taskTarget(row({ kind, ...cols }))).toEqual({ type, href });
  });

  it("covers every known kind exactly once", () => {
    expect(cases.map((c) => c[0]).sort()).toEqual([...TASK_KINDS].sort());
  });
});

describe("taskTarget — typed tasks and the fallback order", () => {
  it("links a typed task to the one record it was added on", () => {
    expect(taskTarget(row({ property_id: P }))).toEqual({ type: "property", href: `/properties/${P}` });
    expect(taskTarget(row({ contact_id: C }))).toEqual({ type: "contact", href: `/contacts/${C}` });
    expect(taskTarget(row({ deal_id: D }))).toEqual({ type: "deal", href: `/deals/${D}` });
  });

  it("orders viewing → deal → contact → lead → property", () => {
    const all = row({ viewing_id: V, deal_id: D, contact_id: C, lead_id: L, property_id: P });
    expect(taskTarget(all).type).toBe("viewing");
    expect(taskTarget({ ...all, viewing_id: null }).type).toBe("deal");
    expect(taskTarget({ ...all, viewing_id: null, deal_id: null }).type).toBe("contact");
    expect(taskTarget({ ...all, viewing_id: null, deal_id: null, contact_id: null }).type).toBe("leads");
    expect(
      taskTarget({ ...all, viewing_id: null, deal_id: null, contact_id: null, lead_id: null }),
    ).toEqual({ type: "property", href: `/properties/${P}` });
  });

  it("opens a property's own tab from the link column when the kind is unknown", () => {
    expect(taskTarget(row({ kind: "some_future_kind", property_id: P, mandate_id: M })).href).toBe(
      `/properties/${P}?tab=mandate`,
    );
    expect(taskTarget(row({ property_id: P, installment_id: I })).href).toBe(
      `/properties/${P}?tab=reservation`,
    );
  });

  it("falls back to the link columns when a kind's own subject id is missing", () => {
    // a viewing nudge whose viewing link is gone still opens its listing
    expect(taskTarget(row({ kind: "viewing_feedback", property_id: P }))).toEqual({
      type: "property",
      href: `/properties/${P}`,
    });
    // a match alert with no property left: nothing to open but the list
    expect(taskTarget(row({ kind: "price_drop_match" }))).toEqual({ type: "tasks", href: "/tasks" });
  });

  it("stays on /tasks when the row links nothing", () => {
    expect(taskTarget(none)).toEqual({ type: "tasks", href: "/tasks" });
  });

  it("knows a kind only by its exact name", () => {
    expect(isTaskKind("deal_no_contact")).toBe(true);
    expect(isTaskKind("DEAL_NO_CONTACT")).toBe(false);
    expect(isTaskKind("toString")).toBe(false);
    expect(isTaskKind(null)).toBe(false);
  });
});

describe("leadTarget", () => {
  it("sends an unanswered lead to the inbox, where its response is logged", () => {
    expect(leadTarget({ contact_id: C, first_response_at: null })).toEqual({ type: "leads", href: "/leads" });
  });
  it("sends an answered lead to its person", () => {
    expect(leadTarget({ contact_id: C, first_response_at: "2026-10-18T09:00:00Z" })).toEqual({
      type: "contact",
      href: `/contacts/${C}`,
    });
  });
  it("keeps a lead with no contact in the inbox", () => {
    expect(leadTarget({ contact_id: null, first_response_at: "2026-10-18T09:00:00Z" }).href).toBe("/leads");
  });
});

describe("TASK_KINDS stays in step with the database and the labels", () => {
  /** Every kind a migration seeds into task_kinds. */
  function seededKinds(): string[] {
    const dir = join(root, "supabase", "migrations");
    const kinds = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(join(dir, file), "utf-8");
      for (const block of sql.matchAll(/insert into public\.task_kinds[^;]*?values([\s\S]*?)on conflict/gi)) {
        for (const m of block[1].matchAll(/\(\s*'([a-z_]+)'\s*,/g)) kinds.add(m[1]);
      }
    }
    return [...kinds].sort();
  }

  it("lists exactly the kinds the migrations seed", () => {
    const seeded = seededKinds();
    // the reader must find something, or this would pass on a broken regex
    expect(seeded.length).toBeGreaterThanOrEqual(14);
    expect([...TASK_KINDS].sort()).toEqual(seeded);
  });

  it("gives every kind an English dashboard label (messages.test pins el/ru parity)", () => {
    const labels = (en as { dashboard: { myDay: { kind: Record<string, string> } } }).dashboard.myDay.kind;
    for (const kind of TASK_KINDS) expect(labels[kind], kind).toMatch(/\S/);
    expect(labels.other).toMatch(/\S/);
  });

  it("opens only tabs the property page knows", () => {
    // The one list of tabs is lib/services/property-tabs.ts (F03) — and the
    // page must render a trigger for each of them, or a link would name a tab
    // that opens nothing.
    const page = readFileSync(join(root, "app", "(app)", "properties", "[id]", "page.tsx"), "utf-8");
    const triggers = new Set([...page.matchAll(/data-property-tab="([a-z]+)"/g)].map((m) => m[1]));
    expect([...triggers].sort(), "the page renders a trigger for every tab").toEqual([...PROPERTY_TABS].sort());
    const used = new Set<string>();
    for (const kind of TASK_KINDS) {
      const href = taskTarget(
        row({ kind, viewing_id: V, deal_id: D, contact_id: C, lead_id: L, property_id: P, reservation_id: R, installment_id: I, mandate_id: M }),
      ).href;
      const tab = new URL(href, "http://x").searchParams.get("tab");
      if (tab) used.add(tab);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const tab of used) expect(isPropertyTab(tab), tab).toBe(true);
  });
});
