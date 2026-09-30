import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every service-role query `mergeContacts` issues is bounded by the CALLER'S
 * organisation — each one individually (T-contact-merge-org-isolation).
 *
 * The service role bypasses RLS, so the query is the only boundary. Until this
 * change the fourteen repoints filtered on the duplicate's id alone, and a row
 * of another organisation naming that id was rewritten onto the merging org's
 * primary (reproduced against the real stack in
 * supabase/tests/contact-merge-org-isolation.test.ts). A file-wide "is there an
 * org_id filter somewhere" check would have passed with thirteen of them
 * missing, so this client records each `from()` chain SEPARATELY and every
 * assertion names the chain it is about.
 *
 * The org comes from the authenticated profile. The form below also carries an
 * `org_id` — a crafted request would — and no query may use it.
 */

const PROFILE_ORG = "org-1";
const FORGED_ORG = "org-evil";

interface Chain {
  table: string;
  ops: { method: string; args: unknown[] }[];
}

const rec = vi.hoisted(() => ({
  chains: [] as Chain[],
  respond: (() => ({ data: [], error: null })) as (c: Chain) => { data: unknown; error: unknown },
}));
const logEvent = vi.hoisted(() => vi.fn(async () => {}));

function recordingClient() {
  return {
    from(table: string) {
      const chain: Chain = { table, ops: [] };
      rec.chains.push(chain);
      const proxy: unknown = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              const page = rec.respond(chain);
              return (resolve: (v: unknown) => void) => resolve(page);
            }
            if (typeof prop !== "string") return undefined;
            return (...args: unknown[]) => {
              chain.ops.push({ method: prop, args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => recordingClient() }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "admin-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { mergeContacts } = await import("@/lib/actions/merge-contacts");

const contact = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  org_id: PROFILE_ORG,
  display_name: id,
  phone_e164: null,
  phone_raw: null,
  additional_phones: [],
  email: null,
  telegram_username: null,
  nationality: null,
  psychology: null,
  source: null,
  source_detail: null,
  preferred_channel: null,
  assigned_agent_id: null,
  contact_types: [],
  languages: [],
  kyc: {},
  banking_readiness: {},
  notes: null,
  is_archived: false,
  merged_into_id: null,
  ...extra,
});

const has = (c: Chain, method: string, ...args: unknown[]) =>
  c.ops.some((o) => o.method === method && JSON.stringify(o.args) === JSON.stringify(args));
const updateOf = (c: Chain) => c.ops.find((o) => o.method === "update")?.args[0] as
  | Record<string, unknown>
  | undefined;
const isRead = (c: Chain) => !updateOf(c) && c.ops.some((o) => o.method === "select");

/** A world where both contacts are the caller's and every write reports its row. */
function script(opts: { archiveRows?: number; backfillRows?: number; readable?: boolean } = {}) {
  const { archiveRows = 1, backfillRows = 1, readable = true } = opts;
  rec.respond = (c) => {
    if (c.table !== "contacts") return { data: [], error: null };
    const upd = updateOf(c);
    if (!upd) {
      if (!readable) return { data: null, error: null };
      if (has(c, "eq", "id", "pri-1")) return { data: contact("pri-1"), error: null };
      if (has(c, "eq", "id", "dup-1"))
        return { data: contact("dup-1", { email: "d@example.test", notes: "n" }), error: null };
    }
    if (upd && "is_archived" in upd)
      return { data: Array.from({ length: archiveRows }, () => ({ id: "dup-1" })), error: null };
    if (upd && has(c, "eq", "id", "pri-1"))
      return { data: Array.from({ length: backfillRows }, () => ({ id: "pri-1" })), error: null };
    return { data: [], error: null };
  };
}

async function run() {
  const fd = new FormData();
  fd.set("primary_id", "pri-1");
  fd.set("duplicate_id", "dup-1");
  fd.set("org_id", FORGED_ORG);
  return mergeContacts({ error: null, mergedAt: null }, fd);
}

/** The repoints the action must issue: table, column, and any extra predicate. */
const REPOINTS: [table: string, column: string, extra: [string, ...unknown[]][]][] = [
  ["leads", "contact_id", []],
  ["deals", "buyer_contact_id", []],
  ["deals", "seller_contact_id", []],
  ["viewings", "contact_id", []],
  ["buyer_requirements", "contact_id", []],
  ["reservations", "contact_id", []],
  ["share_links", "contact_id", []],
  ["offers", "contact_id", []],
  ["tasks", "contact_id", []],
  ["mandates", "owner_contact_id", []],
  ["properties", "owner_contact_id", []],
  ["properties", "developer_contact_id", []],
  ["documents", "entity_id", [["eq", "entity_type", "contact"]]],
  ["contacts", "merged_into_id", [["neq", "id", "dup-1"]]],
];

beforeEach(() => {
  rec.chains = [];
  logEvent.mockClear();
});

describe("mergeContacts bounds every service-role query by the caller's organisation", () => {
  it.each(REPOINTS)("%s.%s moves only the caller's rows off the duplicate", async (table, column, extra) => {
    script();
    expect((await run()).error).toBeNull();
    const chains = rec.chains.filter(
      (c) => c.table === table && updateOf(c) && JSON.stringify(updateOf(c)) === JSON.stringify({ [column]: "pri-1" }),
    );
    expect(chains, `exactly one repoint of ${table}.${column}`).toHaveLength(1);
    const [c] = chains;
    expect(has(c, "eq", "org_id", PROFILE_ORG), `${table}.${column} is not bounded by org_id`).toBe(true);
    expect(has(c, "eq", column, "dup-1"), `${table}.${column} lost its duplicate filter`).toBe(true);
    for (const [method, ...args] of extra) {
      expect(has(c, method, ...args), `${table}.${column} lost ${method}(${args.join(", ")})`).toBe(true);
    }
  });

  it("reads both contacts, archives the duplicate and backfills the primary inside the org", async () => {
    script();
    expect((await run()).error).toBeNull();
    const contacts = rec.chains.filter((c) => c.table === "contacts");
    const reads = contacts.filter(isRead);
    expect(reads.map((c) => [has(c, "eq", "id", "pri-1") || has(c, "eq", "id", "dup-1"), has(c, "eq", "org_id", PROFILE_ORG)]))
      .toEqual([[true, true], [true, true]]);
    const archive = contacts.find((c) => updateOf(c)?.is_archived === true)!;
    expect(updateOf(archive)).toEqual({ is_archived: true, merged_into_id: "pri-1" });
    expect(has(archive, "eq", "id", "dup-1") && has(archive, "eq", "org_id", PROFILE_ORG)).toBe(true);
    const backfill = contacts.find((c) => updateOf(c) && has(c, "eq", "id", "pri-1"))!;
    expect(updateOf(backfill)).toMatchObject({ email: "d@example.test" });
    expect(has(backfill, "eq", "org_id", PROFILE_ORG)).toBe(true);
  });

  it("issues NO service-role query without the profile's org — and never the form's", async () => {
    script();
    expect((await run()).error).toBeNull();
    expect(rec.chains).toHaveLength(2 + 1 + REPOINTS.length + 1);
    const unbounded = rec.chains.filter((c) => !has(c, "eq", "org_id", PROFILE_ORG));
    expect(unbounded.map((c) => `${c.table} ${JSON.stringify(c.ops)}`)).toEqual([]);
    expect(JSON.stringify(rec.chains)).not.toContain(FORGED_ORG);
  });

  it("logs both events in the profile's org, by the caller", async () => {
    script();
    await run();
    const events = logEvent.mock.calls.map((c) => (c as unknown[])[1] as Record<string, unknown>);
    expect(events.map((e) => [e.eventType, e.entityId, e.orgId, e.actorId])).toEqual([
      ["merged", "pri-1", PROFILE_ORG, "admin-1"],
      ["archived", "dup-1", PROFILE_ORG, "admin-1"],
    ]);
  });
});

describe("a write that touched nothing is not a merge", () => {
  it("contacts outside the org read as missing: refused, nothing written", async () => {
    script({ readable: false });
    expect((await run()).error).toBe("Contact not found");
    expect(rec.chains.filter((c) => updateOf(c))).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("an archive that matched no row stops before any repoint", async () => {
    script({ archiveRows: 0 });
    expect((await run()).error).toBe("Contact not found");
    expect(rec.chains.filter((c) => updateOf(c) && !("is_archived" in updateOf(c)!))).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a backfill that matched no row reports failure, not success, and logs nothing", async () => {
    script({ backfillRows: 0 });
    const res = await run();
    expect(res.mergedAt).toBeNull();
    expect(res.error).toMatch(/primary contact was not found.*run the merge again/);
    expect(logEvent).not.toHaveBeenCalled();
  });
});
