import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import { EXPORT_FAILED_MESSAGE, EXPORT_TOO_MANY_MESSAGE } from "@/lib/constants/export";
import { DEAL_EXPORT_SELECT } from "@/lib/services/deal-export";
import { closedRangeFilter } from "@/lib/queries/deals-list";

/**
 * /deals/export (F05) — the register's CSV, run as the REAL route handler over
 * a scripted client. The database half (RLS, PostgREST, the real order) is
 * supabase/tests/deals-list.test.ts; this pins what the route asks for and
 * how it refuses:
 *   - every page is the list's own query — the same filters, ordered
 *     `created_at desc, id`, a fresh range each time;
 *   - past the 10,000 ceiling it refuses with the FILTERABLE message ("narrow
 *     the filters") — unlike /pipeline/export, which has no filters to narrow;
 *     nothing is downloaded and nothing audited;
 *   - a failed read of the agents' names fails the export before any deal is
 *     read, rather than shipping a file with every Agent cell blank.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
const logEvent = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "user-1", orgId: "org-1", role: "admin", fullName: "Admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));

const { GET } = await import("@/app/(app)/deals/export/route");

const CONTACT = "11111111-2222-4333-8444-555555555555";

const deal = (n: number) => ({
  title: `Deal ${n}`,
  deal_type: "sale",
  status: "lost",
  expected_value: 1000,
  final_value: null,
  commission_split_notes: null,
  won_at: null,
  lost_at: "2026-03-01T10:00:00Z",
  lost_reason: null,
  created_at: "2026-01-01T09:00:00Z",
  agent_id: null,
  deal_stages: { name: "Lost" },
  properties: null,
  buyer: null,
  seller: null,
});
const pageOf = (from: number, size: number): FakePage => ({
  data: Array.from({ length: size }, (_, i) => deal(from + i)),
  error: null,
});

async function run(query: string) {
  const res = await GET(new NextRequest(new URL(`http://localhost/deals/export${query}`)));
  return { res, body: await res.text() };
}

beforeEach(() => {
  logEvent.mockClear();
});

describe("/deals/export", () => {
  it("every page is the list's own query: its filters, its unique order, a fresh range", async () => {
    const fake = fakeClient({ deals: [pageOf(0, 1000), pageOf(1000, 2), { data: [], error: null }] });
    state.client = fake.client;

    const { res, body } = await run(`?status=lost&contact=${CONTACT}&closed_from=2026-01-01&q=Maria`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/filename="deals-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(body).toContain("Deal 1001");

    // three requests (two pages, then the empty one that ends the read), each built afresh
    expect(fake.argsOf("deals", "select")).toEqual([[DEAL_EXPORT_SELECT], [DEAL_EXPORT_SELECT], [DEAL_EXPORT_SELECT]]);
    expect(fake.argsOf("deals", "range")).toEqual([
      [0, 999],
      [1000, 1999],
      [1002, 2001],
    ]);
    // each of the three requests carries every filter and the unique order
    const contactOr = [`buyer_contact_id.eq.${CONTACT},seller_contact_id.eq.${CONTACT}`];
    const closedOr = [closedRangeFilter("2026-01-01", undefined)];
    expect(fake.argsOf("deals", "ilike")).toEqual(Array(3).fill(["title", "%Maria%"]));
    expect(fake.argsOf("deals", "eq")).toEqual(Array(3).fill(["status", "lost"]));
    expect(fake.argsOf("deals", "or")).toEqual([contactOr, closedOr, contactOr, closedOr, contactOr, closedOr]);
    expect(fake.argsOf("deals", "order")).toEqual(
      Array(3).fill([["created_at", { ascending: false }], ["id"]]).flat(),
    );

    // audited once, as a count of what the file holds
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]).toMatchObject([
      expect.anything(),
      { eventType: "exported", payload: { list: "deals", count: 1002 } },
    ]);
  });

  it("past the ceiling: refused with the 'narrow the filters' message — no file, no audit line", async () => {
    // ten full pages and one row more than the ceiling
    const pages = Array.from({ length: 10 }, (_, i) => pageOf(i * 1000, 1000));
    state.client = fakeClient({ deals: [...pages, pageOf(10_000, 1)] }).client;

    const { res, body } = await run("?status=closed");
    expect(res.status).toBe(422);
    expect(JSON.parse(body)).toEqual({ error: EXPORT_TOO_MANY_MESSAGE, reason: "too_many" });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a failed read of the agents' names fails the export before any deal is read", async () => {
    const fake = fakeClient({ profiles: [{ data: null, error: { message: "boom" }, status: 500 }] });
    state.client = fake.client;

    const { res, body } = await run("");
    expect(res.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: EXPORT_FAILED_MESSAGE, reason: "failed" });
    expect(fake.served.deals ?? 0).toBe(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a type names the file, as the board's export does", async () => {
    state.client = fakeClient({}).client;
    const { res } = await run("?type=rental");
    expect(res.headers.get("content-disposition")).toMatch(/filename="deals-rental-\d{4}-\d{2}-\d{2}\.csv"/);
  });
});
