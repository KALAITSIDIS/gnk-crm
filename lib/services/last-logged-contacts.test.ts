import { describe, expect, it, vi } from "vitest";

/**
 * `readLastLoggedContacts` — the hot-buyers card's "no logged contact in 3+
 * days" (A06 step 7), the contact strip's "Last logged contact" asked of many
 * people at once. Pinned here, against a small in-memory PostgREST:
 *
 * 1. only LOGGED contact counts — a chat-link click and a profile edit never
 *    do — on the contact, a contact merged into it, its leads and its deals
 *    (buyer or seller), the newest wherever it sits;
 * 2. the person's other records are read on the VIEWER's client, so a deal
 *    the viewer cannot read is never asked about; the events on the
 *    system's, org-bound;
 * 3. every id list goes out in slices of IDS_PER_READ and every read is paged
 *    to an empty page;
 * 4. a read that did not answer is `{ ok: false }`, never an answer.
 *
 * The database half (RLS, the real card) is supabase/tests/hot-buyers-idle.test.ts.
 */

type Row = Record<string, unknown>;
type Call = { method: string; args: unknown[] };
type Asked = { table: string; calls: Call[] };

/**
 * A client whose awaited query is answered by EVALUATING its filters over
 * `tables` — `.eq`, `.in`, `.order("id")`, `.range` — so paging, slicing and
 * filtering are real, and a test can say what the database holds rather than
 * scripting pages in the order the reader happens to await them.
 */
function engine(tables: Record<string, Row[]>, fail?: (a: Asked) => boolean) {
  const asked: Asked[] = [];
  const answer = (a: Asked) => {
    asked.push(a);
    if (fail?.(a)) return { data: null, error: { message: "statement timeout" } };
    let rows = [...(tables[a.table] ?? [])];
    let from = 0;
    let to = Number.POSITIVE_INFINITY;
    for (const c of a.calls) {
      if (c.method === "eq") rows = rows.filter((r) => r[c.args[0] as string] === c.args[1]);
      if (c.method === "in") rows = rows.filter((r) => (c.args[1] as unknown[]).includes(r[c.args[0] as string]));
      if (c.method === "order") rows.sort((x, y) => String(x[c.args[0] as string]).localeCompare(String(y[c.args[0] as string])));
      if (c.method === "range") [from, to] = c.args as [number, number];
    }
    return { data: rows.slice(from, to + 1), error: null, status: 200 };
  };
  const chain = (table: string, calls: Call[]): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const page = answer({ table, calls });
            return (resolve: (v: unknown) => void) => resolve(page);
          }
          if (typeof prop !== "string") return undefined;
          return (...args: unknown[]) => chain(table, [...calls, { method: prop, args }]);
        },
      },
    );
  return { client: { from: (t: string) => chain(t, []) }, asked };
}

const argsOf = (asked: Asked[], table: string, method: string, key?: string) =>
  asked
    .filter((a) => a.table === table)
    .flatMap((a) => a.calls.filter((c) => c.method === method && (key === undefined || c.args[0] === key)).map((c) => c.args));

const admin = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin.client }));

const { readLastLoggedContacts } = await import("./contact-activity-summary");
const { IDS_PER_READ } = await import("./entity-timeline");

const ORG = "org-1";
let seq = 0;
const ev = (entity_type: string, entity_id: string, event_type: string, occurred_at: string, org_id = ORG): Row => ({
  id: String(++seq).padStart(6, "0"),
  org_id,
  entity_type,
  entity_id,
  event_type,
  occurred_at,
});

function run(viewerTables: Record<string, Row[]>, events: Row[], contactIds: string[], opts: { failViewer?: (a: Asked) => boolean; failSystem?: (a: Asked) => boolean; orgId?: string } = {}) {
  const viewer = engine(viewerTables, opts.failViewer);
  const system = engine({ events }, opts.failSystem);
  admin.client = system.client;
  return {
    viewer,
    system,
    result: readLastLoggedContacts({ orgId: opts.orgId ?? ORG, viewer: viewer.client as never, contactIds }),
  };
}

describe("what counts as a logged contact", () => {
  it("a chat-link click and a profile edit never do; a call, a logged conversation and a 'contacted' stamp do", async () => {
    const { result, system } = run(
      { contacts: [], leads: [{ id: "l-b", contact_id: "b" }], deals: [] },
      [
        ev("contact", "a", "chat_link_opened", "2026-10-18T08:00:00Z"),
        ev("lead", "l-b", "chat_link_opened", "2026-10-18T08:00:00Z"),
        ev("contact", "a", "updated", "2026-10-18T09:00:00Z"),
        ev("contact", "b", "called", "2026-10-10T09:00:00Z"),
        ev("lead", "l-b", "contacted", "2026-10-12T09:00:00Z"),
        ev("contact", "c", "conversation_logged", "2026-10-01T09:00:00Z"),
      ],
      ["a", "b", "c"],
    );
    const r = await result;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.last.has("a"), "a click and an edit leave a buyer with no logged contact").toBe(false);
    expect(r.last.get("b"), "the newest, on the lead").toBe("2026-10-12T09:00:00Z");
    expect(r.last.get("c")).toBe("2026-10-01T09:00:00Z");
    // asked in the query, not filtered after it
    for (const [, types] of argsOf(system.asked, "events", "in", "event_type")) {
      expect(types).toEqual(["conversation_logged", "called", "contacted"]);
    }
  });

  it("a call on the buyer's deal — as buyer or as seller — or on a merged duplicate counts for the person", async () => {
    const { result } = run(
      {
        contacts: [{ id: "dup", merged_into_id: "m" }],
        leads: [],
        deals: [
          { id: "d-buy", buyer_contact_id: "b", seller_contact_id: "dev" },
          { id: "d-sell", buyer_contact_id: "x", seller_contact_id: "s" },
        ],
      },
      [
        ev("deal", "d-buy", "called", "2026-10-17T10:00:00Z"),
        ev("deal", "d-sell", "conversation_logged", "2026-10-16T10:00:00Z"),
        ev("contact", "dup", "called", "2026-10-15T10:00:00Z"),
      ],
      ["b", "s", "m"],
    );
    const r = await result;
    expect(r.ok && Object.fromEntries(r.last)).toEqual({
      b: "2026-10-17T10:00:00Z",
      s: "2026-10-16T10:00:00Z",
      m: "2026-10-15T10:00:00Z",
    });
  });
});

describe("whose records, read on whose client", () => {
  it("leads, deals and duplicates come from the VIEWER; a deal the viewer cannot read is never asked about", async () => {
    // the viewer's deals read does not return d-colleague (deals_select)
    const { result, viewer, system } = run(
      { contacts: [], leads: [], deals: [{ id: "d-mine", buyer_contact_id: "b" }] },
      [
        ev("deal", "d-colleague", "called", "2026-10-18T10:00:00Z"),
        ev("deal", "d-mine", "called", "2026-09-01T10:00:00Z"),
        // another organisation's call naming the same contact id
        ev("contact", "b", "called", "2026-10-18T11:00:00Z", "org-x"),
      ],
      ["b"],
    );
    const r = await result;
    expect(r.ok && r.last.get("b")).toBe("2026-09-01T10:00:00Z");
    expect([...new Set(viewer.asked.map((a) => a.table))].sort()).toEqual(["contacts", "deals", "leads"]);
    expect(system.asked.every((a) => a.table === "events"), "the system reads events only").toBe(true);
    expect(viewer.asked.some((a) => a.table === "events"), "never events on the viewer's client").toBe(false);
    expect(argsOf(system.asked, "events", "in", "entity_id").flatMap(([, ids]) => ids as string[])).not.toContain("d-colleague");
    // every events read is org-bound — the admin client's only boundary
    expect(argsOf(system.asked, "events", "eq", "org_id")).toHaveLength(system.asked.length);
    expect(argsOf(system.asked, "events", "eq", "org_id").every(([, v]) => v === ORG)).toBe(true);
  });
});

describe("bounded reads", () => {
  it("150 people: every id list in slices of IDS_PER_READ, on both clients", async () => {
    const people = Array.from({ length: 150 }, (_, i) => `c${String(i).padStart(3, "0")}`);
    const { result, viewer, system } = run({ contacts: [], leads: [], deals: [] }, [], people);
    expect((await result).ok).toBe(true);
    expect(IDS_PER_READ).toBe(100);
    for (const [table, col] of [
      ["contacts", "merged_into_id"],
      ["leads", "contact_id"],
      ["deals", "buyer_contact_id"],
      ["deals", "seller_contact_id"],
    ] as const) {
      const lists = argsOf(viewer.asked, table, "in", col).map(([, ids]) => (ids as string[]).length);
      // one page each (an empty one ends it): a slice of 100, a slice of 50
      expect(lists, `${table}.${col}`).toEqual([100, 50]);
    }
    const contactSlices = argsOf(system.asked, "events", "in", "entity_id").map(([, ids]) => (ids as string[]).length);
    expect(contactSlices).toEqual([100, 50]);
  });

  it("pages every read to an empty page — the 1,001st lead is asked about", async () => {
    const leads = Array.from({ length: 1001 }, (_, i) => ({ id: `l${String(i).padStart(4, "0")}`, contact_id: "b" }));
    const { result, viewer } = run({ contacts: [], leads, deals: [] }, [ev("lead", "l1000", "called", "2026-10-18T10:00:00Z")], ["b"]);
    const r = await result;
    expect(r.ok && r.last.get("b"), "a call on the 1,001st lead").toBe("2026-10-18T10:00:00Z");
    expect(argsOf(viewer.asked, "leads", "range")).toEqual([
      [0, 999],
      [1000, 1999],
      [1001, 2000],
    ]);
    expect(argsOf(viewer.asked, "leads", "order")).toEqual([["id"], ["id"], ["id"]]);
  });
});

describe("nothing is a zero", () => {
  it("a failed viewer read or a failed events read is `{ ok: false }`", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failedDeals = run({ contacts: [], leads: [], deals: [] }, [], ["b"], { failViewer: (a) => a.table === "deals" });
    expect(await failedDeals.result).toEqual({ ok: false });
    const failedEvents = run({ contacts: [], leads: [{ id: "l1", contact_id: "b" }], deals: [] }, [], ["b"], {
      failSystem: (a) => a.calls.some((c) => c.method === "eq" && c.args[0] === "entity_type" && c.args[1] === "lead"),
    });
    expect(await failedEvents.result).toEqual({ ok: false });
    err.mockRestore();
  });

  it("no people asks nothing; no org asks nothing and is not an answer", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const none = run({}, [], []);
    expect(await none.result).toEqual({ ok: true, last: new Map() });
    expect(none.viewer.asked).toEqual([]);
    expect(none.system.asked).toEqual([]);
    const noOrg = run({}, [], ["b"], { orgId: "" });
    expect(await noOrg.result).toEqual({ ok: false });
    expect(noOrg.viewer.asked).toEqual([]);
    expect(noOrg.system.asked).toEqual([]);
    err.mockRestore();
  });
});
