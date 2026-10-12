import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  ANON_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

/**
 * A Keys search longer than the search box allows (100 characters, after
 * trimming) is REFUSED in words — on the page and by the CSV export — never a
 * crash, never an unfiltered or truncated search — through the REAL page
 * server component and the REAL export route, against a REAL PostgREST, with a
 * real aal2 session (T-keys-search-length).
 *
 * At 20748fb `keyFiltersSchema.q` was `.max(100)` with no fallback and
 * `parseKeyFilters` used `.parse`: a 101-character `q` (a pasted or linked URL;
 * the box had no maxLength) THREW a ZodError — the page fell to the error
 * boundary ("Something went wrong") and `/keys/export` answered an uncaught 500
 * instead of its JSON refusal.
 *
 * The same rule covers a search of nothing but the characters a search leaves
 * out ("(,)"), which at 20748fb ran as the WHOLE register labelled "matching
 * keys" (exported in full, audited as a search), and a repeated `q`, which
 * the page read first and the export route last (a URL the page refused
 * exported another search).
 *
 * WHAT IT PINS (each case prints one `[evidence]` line):
 *   1. a search past 100 characters — plain, past 100 only after trimming is
 *      NOT counted, Greek letters, beside a status, on page 2, first of two —
 *      and a search with nothing to search render the page with the refusal in
 *      the register's place: no key list is requested (nothing searched, so no
 *      unfiltered list either), no Export is offered, the header still counts
 *      the whole register;
 *   2. exactly 100 characters (spaces around it trimmed), a valid first of two,
 *      and a bracketed term search as before and find the key they name;
 *   3. the export refuses the same searches with 400, reason `invalid` and the
 *      same words — no CSV, no key read, no `exported` audit line — and exports
 *      a search at the limit as exactly the keys it names, read and audited
 *      once (so the "no read" and "no audit" counters are shown able to move).
 *
 * A THROWAWAY ORGANISATION, deleted at the end as postgres, events included.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();

/** The refusals, word for word. */
const REFUSAL = "That search is too long — 100 characters at most. Nothing was searched.";
const NOTHING = "That search has nothing to search for — commas, brackets and backslashes are left out of a search. Nothing was searched.";

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>() };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound for this page");
    return c;
  },
}));

import KeysPage from "@/app/(app)/keys/page";
import { GET as keysExport } from "@/app/(app)/keys/export/route";
import { KeysRegister, type KeyRegisterRow } from "@/components/features/keys/keys-register";
import { ExportCsvButton } from "@/components/features/shared/export-csv-button";

// ---------------------------------------------------------------------------
// A real session, every REST request recorded with its method
// ---------------------------------------------------------------------------
let client: SupabaseClient;
const sent: { method: string; url: string }[] = [];

type Element = ReactElement<Record<string, unknown>>;
function* walk(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!isValidElement(node)) return;
  const el = node as Element;
  yield el;
  yield* walk(el.props.children);
}
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as Element).props.children);
  return "";
}

interface Screen {
  rows: KeyRegisterRow[];
  emptyText: string;
  header: string;
  exportHref: string | null;
  /** the paged key-list requests the page sent */
  listRequests: number;
  /** the register-wide HEAD counts it sent */
  headCounts: number;
}

/** The page's outcome: what it rendered, or what it threw. */
/** Search params as Next hands them to a page: a repeated key is an array, in URL order. */
type PageParams = Record<string, string | string[]>;

async function show(params: PageParams): Promise<{ screen: Screen | null; thrown: string | null }> {
  sent.length = 0;
  try {
    const root = (await ctx.als.run(client, () => KeysPage({ searchParams: Promise.resolve({ ...params }) }))) as ReactNode;
    const els = [...walk(root)];
    const register = els.find((e) => e.type === KeysRegister);
    if (!register) throw new Error("the keys page rendered no register");
    const header = els.find((e) => e.type === "p" && /registered ·/.test(textOf(e)));
    const exportButton = els.find((e) => e.type === ExportCsvButton);
    return {
      screen: {
        rows: register.props.keys as KeyRegisterRow[],
        emptyText: String(register.props.emptyText),
        header: header ? textOf(header) : "",
        exportHref: exportButton ? String(exportButton.props.href) : null,
        listRequests: sent.filter((r) => r.method === "GET" && /\/rest\/v1\/property_keys\?.*limit=/.test(r.url)).length,
        headCounts: sent.filter((r) => r.method === "HEAD" && /\/rest\/v1\/property_keys\?/.test(r.url)).length,
      },
      thrown: null,
    };
  } catch (e) {
    return { screen: null, thrown: e instanceof Error ? `${e.name}: ${e.message.slice(0, 160)}` : String(e) };
  }
}

/** The export, its key reads recorded: `keyReads` counts its REST requests to property_keys. */
async function exportKeys(params: Record<string, string> | [string, string][]) {
  const url = new URL("http://localhost/keys/export");
  for (const [k, v] of Array.isArray(params) ? params : Object.entries(params)) url.searchParams.append(k, v);
  sent.length = 0;
  const keyReads = () => sent.filter((r) => /\/rest\/v1\/property_keys/.test(r.url)).length;
  try {
    const res = await ctx.als.run(client, () => keysExport(new NextRequest(url)));
    const type = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const json = type.includes("json") ? (JSON.parse(body) as { error?: string; reason?: string }) : null;
    // the CSV's key codes (column 1), header and BOM left out
    const codes = type.includes("text/csv")
      ? body.replace(/^\uFEFF/, "").trim().split("\r\n").slice(1).map((l) => l.split(",")[0]!)
      : [];
    return { status: res.status, type, body, json, codes, keyReads: keyReads(), thrown: null };
  } catch (e) {
    return { status: 0, type: "", body: "", json: null, codes: [] as string[], keyReads: keyReads(), thrown: e instanceof Error ? `${e.name}: ${e.message.slice(0, 160)}` : String(e) };
  }
}

const exportedEvents = async () =>
  Number((await pg.query<{ n: string }>("select count(*) as n from events where org_id = $1 and event_type = 'exported'", [ORG])).rows[0]!.n);

// ---------------------------------------------------------------------------
// Fixtures: a few keys, one carrying a 100-character token in its description
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
/** exactly 100 characters, unique to this run */
const TOKEN_100 = `SL${TAG}`.padEnd(100, "x");
const GREEK_100 = "α".repeat(100);

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Keys search length ${RUN}`, `keys-search-length-${RUN}`);
  admin = await createTestUser(svc, `ksl-admin-${RUN}@test.local`, "admin", ORG);
  const s = (await admin.client.auth.getSession()).data.session!;
  client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/rest/v1/")) sent.push({ method: (init?.method ?? "GET").toUpperCase(), url });
        return fetch(input, init);
      },
    },
  });
  const { error } = await client.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession: ${error.message}`);

  const { rows } = await pg.query<{ id: string }>(
    "insert into properties (org_id, reference, property_type) values ($1, $2, 'apartment') returning id",
    [ORG, `SL${TAG}-HOME`],
  );
  const pid = rows[0]!.id;
  await pg.query(
    `insert into property_keys (org_id, property_id, key_code, description, status, current_holder_name) values
       ($1, $2, $3, $4, 'in_office', null),
       ($1, $2, $5, $6, 'in_office', null),
       ($1, $2, $7, null, 'checked_out', 'A holder')`,
    [ORG, pid, `SL${TAG}-LONG`, `spare: ${TOKEN_100}`, `SL${TAG}-GREEK`, `κλειδί ${GREEK_100}`, `SL${TAG}-OUT`],
  );
}, 300_000);

afterAll(async () => {
  await pg.query("delete from property_keys where org_id = $1", [ORG]);
  await pg.query("delete from properties where org_id = $1", [ORG]);
  await svc.auth.admin.deleteUser(admin.id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = $1`, [ORG]);
  }
  await pg.query("delete from organizations where id = $1", [ORG]);
  await pg.end();
}, 300_000);

// ---------------------------------------------------------------------------
describe("a Keys search longer than 100 characters is refused in words", () => {
  const REFUSED: [string, PageParams, string][] = [
    ["101 characters", { q: `${TOKEN_100}y` }, REFUSAL],
    ["101 characters inside spaces", { q: `  ${TOKEN_100}y  ` }, REFUSAL],
    ["101 Greek letters", { q: `${GREEK_100}α` }, REFUSAL],
    ["101 characters beside a status", { q: `${TOKEN_100}y`, status: "checked_out" }, REFUSAL],
    // the refusal, not "Nothing on this page."
    ["101 characters on page 2", { q: `${TOKEN_100}y`, page: "2" }, REFUSAL],
    // a repeated q reads its FIRST value — as the export now does
    ["101 characters, then a valid search", { q: [`${TOKEN_100}y`, TOKEN_100] }, REFUSAL],
    // nothing left to search: refused, never the whole register labelled a search
    ["only characters a search leaves out", { q: "(,)" }, NOTHING],
    ["only characters a search leaves out, beside a status", { q: " , ", status: "in_office" }, NOTHING],
  ];

  it.each(REFUSED)("the page, %s → the refusal in the register's place; nothing searched; no Export; the header still counts", async (label, params, words) => {
    const { screen, thrown } = await show(params);
    console.log(`[evidence] keys page, ${label}: ${thrown ? `THREW ${thrown}` : `"${screen!.emptyText}"; rows ${screen!.rows.length}; key-list requests ${screen!.listRequests}; head counts ${screen!.headCounts}; export ${screen!.exportHref}; header "${screen!.header}"`}`);
    expect(thrown).toBeNull();
    expect(screen!.emptyText).toBe(words);
    expect(screen!.rows).toEqual([]);
    expect(screen!.listRequests, "nothing searched — and no unfiltered list either").toBe(0);
    expect(screen!.exportHref, "no Export of a refused search").toBeNull();
    expect(screen!.header).toBe("3 registered · 1 out");
    expect(screen!.headCounts, "the register-wide counts still read").toBe(2);
  }, 60_000);

  it("the page, exactly 100 characters (spaces around it trimmed) → searched as before, the key found", async () => {
    for (const [label, q, code] of [
      ["100 characters", TOKEN_100, `SL${TAG}-LONG`],
      ["100 characters inside spaces", `   ${TOKEN_100}   `, `SL${TAG}-LONG`],
      ["100 Greek letters", GREEK_100, `SL${TAG}-GREEK`],
      ["a valid search, then 101 characters (the first is read)", [TOKEN_100, `${TOKEN_100}y`], `SL${TAG}-LONG`],
      ["brackets around a term (something left to search)", `(${TOKEN_100.slice(0, 20)})`, `SL${TAG}-LONG`],
    ] as [string, string | string[], string][]) {
      const { screen, thrown } = await show({ q });
      console.log(`[evidence] keys page, ${label}: ${thrown ? `THREW ${thrown}` : `rows ${screen!.rows.map((r) => r.keyCode).join(",")}; key-list requests ${screen!.listRequests}`}`);
      expect(thrown).toBeNull();
      expect(screen!.rows.map((r) => r.keyCode)).toEqual([code]);
      expect(screen!.listRequests).toBe(1);
      expect(screen!.exportHref).not.toBeNull();
    }
  }, 60_000);

  const EXPORT_REFUSED: [string, Record<string, string> | [string, string][], string][] = [
    ["101 characters", { q: `${TOKEN_100}y` }, REFUSAL],
    ["101 characters inside spaces", { q: `  ${TOKEN_100}y  ` }, REFUSAL],
    ["101 Greek letters", { q: `${GREEK_100}α` }, REFUSAL],
    ["101 characters beside a status", { q: `${TOKEN_100}y`, status: "checked_out" }, REFUSAL],
    // the FIRST of a repeated q, as the page reads it (the route used to keep the last)
    ["101 characters, then a valid search", [["q", `${TOKEN_100}y`], ["q", TOKEN_100]], REFUSAL],
    ["only characters a search leaves out", { q: "(,)" }, NOTHING],
  ];

  it.each(EXPORT_REFUSED)("the export, %s → 400, reason `invalid`, the words; no CSV, no key read, no audit line", async (label, params, words) => {
    const before = await exportedEvents();
    const refused = await exportKeys(params);
    const after = await exportedEvents();
    console.log(`[evidence] keys export, ${label}: ${refused.thrown ? `THREW ${refused.thrown}` : `${refused.status} ${refused.type} ${JSON.stringify(refused.json)}`}; key reads ${refused.keyReads}; exported events ${before} → ${after}`);
    expect(refused.thrown).toBeNull();
    expect(refused.status).toBe(400);
    expect(refused.json).toEqual({ error: words, reason: "invalid" });
    expect(refused.type).not.toContain("text/csv");
    expect(refused.keyReads, "refused before any key is read").toBe(0);
    expect(after, "a refused export is not audited").toBe(before);
  }, 60_000);

  it("the export at the limit → the CSV of exactly the keys the search names, read and audited once each", async () => {
    const cases: [string, Record<string, string> | [string, string][], string[]][] = [
      ["100 characters", { q: TOKEN_100 }, [`SL${TAG}-LONG`]],
      ["100 characters inside spaces", { q: `   ${TOKEN_100}   ` }, [`SL${TAG}-LONG`]],
      ["100 Greek letters", { q: GREEK_100 }, [`SL${TAG}-GREEK`]],
      ["a valid search, then 101 characters (the first is read)", [["q", TOKEN_100], ["q", `${TOKEN_100}y`]], [`SL${TAG}-LONG`]],
    ];
    for (const [label, params, codes] of cases) {
      const before = await exportedEvents();
      const ok = await exportKeys(params);
      const after = await exportedEvents();
      console.log(`[evidence] keys export, ${label}: ${ok.thrown ? `THREW ${ok.thrown}` : `${ok.status} ${ok.type}; codes ${ok.codes.join(",")}`}; key reads ${ok.keyReads}; exported events ${before} → ${after}`);
      expect(ok.thrown).toBeNull();
      expect(ok.status).toBe(200);
      expect(ok.type).toContain("text/csv");
      // the search's keys and no other — an unfiltered file would hold all three
      expect(ok.codes, label).toEqual(codes);
      // the counters the refusals rely on can move
      expect(ok.keyReads, "an export that runs reads the keys").toBeGreaterThan(0);
      expect(after, "an export that runs is audited, once").toBe(before + 1);
    }
  }, 60_000);
});
