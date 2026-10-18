import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/portals/[portal]/[token]/route";
import { kyero } from "@/lib/services/portals/dialects/kyero";

/**
 * The portal feed over faked Supabase clients — the sibling of
 * public-listings-route.test.ts, and faked at the same seam: only
 * `createPublicClient` (the readers), `createAdminClient` (the two
 * service-role writes, 0150) and `after()` are stand-ins. The path
 * parameters, the token check, the paging, the row parsers, the assembler,
 * the eligibility rules, the Kyero dialect, the ETag and the headers are the
 * real route.
 *
 * What the file is really pinning is the set of promises a pull portal relies
 * on, each of which fails silently in production if it breaks:
 *
 *  - a DISABLED portal gets a valid EMPTY document, never a 404 — absence is
 *    how a pull portal is told to remove our listings, and a 404 leaves them
 *    stale on the portal forever;
 *  - a FAILURE is a 503, never an empty document, for the same reason: an
 *    empty feed would delete a live book of listings off the portal. Since
 *    0150 that includes every HOLLOW or SKEWED answer — a connection row of
 *    the wrong shape, a supplement that is not rows, a supplement shorter
 *    than the connection's own count of the selection, a scan that found none
 *    of it — because postgrest-js hands several faults back as `[]`;
 *  - no Postgres text reaches the body, because that body lands in a third
 *    party's logs; and the token appears in no response and no log line;
 *  - every answer to a valid token is RECORDED (record_portal_pull, service
 *    role) — served, disabled AND failed, 304s included — because "last
 *    requested" on Settings → Portals means "when did the portal last ask",
 *    and a frozen timestamp reads the same as a portal that stopped asking;
 *  - the database is handed the PLAINTEXT token and hashes it itself (0150);
 *  - and the feed is NEVER metered (`note_public_listing_hit`) — a valid
 *    token is the proof, and the counter row is the shared-lock problem
 *    REL-03 removed from the site feed on 2026-09-13. Asserted after EVERY
 *    test, not in one of them, with the other standing checks below.
 */

const TOKEN = "a".repeat(64);
/** what 0097–0149 sent instead of the token; since 0150 it must appear in no call */
const TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");
const UA = "KyeroBot/1.0";
/** what sync_portal_export answers by default: the listing's export revision */
const SYNCED_AT = "2026-10-01T09:00:00+00:00";
const SUPABASE_URL = "https://example.supabase.co";

/** The only functions each client may be asked for. Anything else is a wrong-role call. */
const PUBLIC_READERS = ["portal_feed_connection", "portal_feed_supplement", "public_listings"];
const ADMIN_WRITES = ["record_portal_pull", "sync_portal_export"];

type Answer = { data: unknown; error: { message: string; code?: string } | null };

const state = vi.hoisted(() => ({
  /** the connection reader's `data`, verbatim — an array of rows, or a hollow/skewed answer */
  connection: [] as unknown,
  connectionError: null as { message: string } | null,
  supplements: [] as Array<Record<string, unknown>>,
  /** when set, every supplement page answers exactly this (a hollow or skewed body) */
  supplementAnswer: null as { data: unknown; error: { message: string } | null } | null,
  supplementError: null as { message: string } | null,
  /** pages starting at or after this row fail — "a page that fails after a full page" */
  supplementErrorFrom: null as number | null,
  /** a lowered max_rows: no page answers more than this many rows */
  supplementPageCap: null as number | null,
  /** every page full, no empty page ever — a selection larger than the scan budget */
  supplementInfinite: false,
  listings: [] as Array<Record<string, unknown>>,
  /** the connection rows a SECOND lookup answers (the route's recount); null = the same as the first */
  recount: null as Array<Record<string, unknown>> | null,
  connectionLookups: 0,
  /** when set, every public_listings page answers exactly this */
  listingsAnswer: null as { data: unknown; error: { message: string } | null } | null,
  listingsError: null as { message: string } | null,
  /** every page full of rows nobody selected — what a scan that cannot finish looks like */
  listingsInfinite: false,
  /** sync_portal_export's answer; null = date every reference it was given with SYNCED_AT */
  syncAnswer: null as { data: unknown; error: { message: string; code?: string } | null } | null,
  syncedAt: "",
  recordError: null as { message: string } | null,
  /** createAdminClient throws — a missing or legacy service key (key-health.ts) */
  adminThrows: false,
  calls: [] as string[],
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  adminCalls: [] as string[],
  adminRpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  adminBuilt: 0,
  ranges: [] as Array<[number, number]>,
  /** the column each supplement page was ordered by when `.range()` narrowed it */
  supplementOrders: [] as Array<string | null>,
  pulls: [] as Array<Record<string, unknown>>,
  syncs: [] as Array<Record<string, unknown>>,
  afters: [] as Promise<unknown>[],
  responses: [] as Array<{ status: number; text: string }>,
}));

vi.mock("@/lib/supabase/public", () => ({
  createPublicClient: () => ({
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      state.calls.push(name);
      state.rpcs.push({ name, args });
      if (name === "portal_feed_supplement") {
        // the real builder is not a promise until `.range()` narrows it, and
        // the route builds a FRESH one per page — so the order is per builder
        let order: string | null = null;
        const range = async (from: number, to: number): Promise<Answer> => {
          state.ranges.push([from, to]);
          state.supplementOrders.push(order);
          // portal_feed_supplement has no ORDER BY of its own, so paging it
          // unordered repeats and skips rows above one page. Dropping the
          // `.order()` has to break the suite, not the feed.
          if (order !== "reference") {
            throw new Error('portal_feed_supplement was paged without .order("reference")');
          }
          if (state.supplementAnswer) return state.supplementAnswer;
          if (state.supplementError) return { data: null, error: state.supplementError };
          if (state.supplementErrorFrom !== null && from >= state.supplementErrorFrom) {
            return { data: null, error: { message: "supplement page boom" } };
          }
          if (state.supplementInfinite) {
            const page = Array.from({ length: to - from + 1 }, (_, i) => supplement({ reference: `SEL${from + i}` }));
            return { data: page, error: null };
          }
          const end = Math.min(to + 1, from + (state.supplementPageCap ?? Infinity));
          return { data: state.supplements.slice(from, end), error: null };
        };
        const builder = {
          range,
          order: (col: string) => {
            order = col;
            return builder;
          },
        };
        return builder;
      }
      if (name === "portal_feed_connection") {
        state.connectionLookups++;
        const rows = state.connectionLookups > 1 && state.recount ? state.recount : state.connection;
        return Promise.resolve(
          state.connectionError ? { data: null, error: state.connectionError } : { data: rows, error: null },
        );
      }
      if (name === "public_listings") {
        if (state.listingsAnswer) return Promise.resolve(state.listingsAnswer);
        if (state.listingsError) return Promise.resolve({ data: null, error: state.listingsError });
        const offset = Number(args.p_offset ?? 0);
        const limit = Number(args.p_limit ?? 0);
        // the assembler's re-check of a reference the scan missed (feed.ts)
        if (typeof args.p_reference === "string") {
          return Promise.resolve({
            data: state.listings.filter((l) => l.reference === args.p_reference).slice(0, limit),
            error: null,
          });
        }
        if (state.listingsInfinite) {
          const page = Array.from({ length: limit }, (_, i) => listingRow({ reference: `UNR${offset + i}` }));
          return Promise.resolve({ data: page, error: null });
        }
        return Promise.resolve({ data: state.listings.slice(offset, offset + limit), error: null });
      }
      throw new Error("unexpected public rpc " + name);
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminBuilt++;
    if (state.adminThrows) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not a modern secret key");
    return {
      rpc: async (name: string, args: Record<string, unknown> = {}): Promise<Answer> => {
        state.adminCalls.push(name);
        state.adminRpcs.push({ name, args });
        if (name === "record_portal_pull") {
          state.pulls.push(args);
          return { data: null, error: state.recordError };
        }
        if (name === "sync_portal_export") {
          state.syncs.push(args);
          if (state.syncAnswer) return state.syncAnswer;
          const rows = args.p_rows as Array<{ reference: string }>;
          return { data: Object.fromEntries(rows.map((r) => [r.reference, state.syncedAt])), error: null };
        }
        throw new Error("unexpected admin rpc " + name);
      },
    };
  },
}));

// after() throws outside a request scope; the stand-in runs the callback after
// the handler returns (as the platform does) and keeps its promise, so a test
// asserts on a finished request rather than on how many hops it waited.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (fn: () => unknown) => {
      state.afters.push(Promise.resolve().then(fn));
    },
  };
});

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;

/** PAF0001: two JPEGs measured well above JamesEdition's 800×600, an exact point — the shape 0150's supplement returns. */
const supplement = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  reference: "PAF0001",
  lat: 34.8821,
  lng: 32.3789,
  location_approx: false,
  images: [
    { jpeg: "properties/p1/1_jpeg.jpg", alt: { en: "Front elevation" }, width: 4000, height: 3000 },
    { jpeg: "properties/p1/2_jpeg.jpg", alt: {}, width: 4000, height: 3000 },
  ],
  ...over,
});

/**
 * One `public_listings()` row of the shape production writes — built here
 * rather than borrowed from the dialect fixtures, which follow the renderer's
 * own input (FeedListing) and change with it.
 */
const listingRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  reference: "PAF0001",
  kind: "standalone",
  property_type: "villa",
  transaction_type: "sale",
  title: { en: "Sea-view villa in Peyia", el: "Βίλα με θέα", ru: "Вилла с видом на море" },
  short_description: { en: "Three-bed villa" },
  adviser_view: {},
  public_description: { en: "Detached villa near the coast, with a pool.", ru: "Отдельная вилла у моря." },
  district: { en: "Paphos", el: "Πάφος", ru: "Пафос" },
  area: { en: "Peyia", el: "Πέγεια", ru: "Пейя" },
  sea_distance_m: 200,
  currency: "EUR",
  asking_price: 650000,
  rent_price_month: null,
  vat_status: "resale_no_vat",
  covered_area_sqm: 210,
  plot_area_sqm: 780,
  veranda_sqm: 40,
  roof_garden_sqm: null,
  basement_sqm: null,
  bedrooms: 3,
  bathrooms: 2,
  wc: 1,
  parking_spaces: 2,
  has_storage: true,
  floor_number: null,
  total_floors: 2,
  year_built: 2016,
  energy_class: "B",
  features: ["private_pool", "sea_view"],
  title_deed_status: "separate",
  construction_status: null,
  delivery_date: null,
  published_at: "2026-09-01T10:00:00+00:00",
  updated_at: "2026-09-10T08:30:15+00:00",
  images: [],
  ...over,
});

const connectionRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  org_slug: "gnk",
  enabled: true,
  settings: { email: "sales@example.com" },
  selected_count: 1,
  ...over,
});

/** The record_portal_pull arguments the route should send — one per request. */
const pull = (over: Record<string, unknown>) => ({
  p_token: TOKEN,
  p_ua: UA,
  p_outcome: "served",
  p_served: null,
  p_selected: null,
  p_excluded: null,
  p_reason: null,
  p_detail: {},
  ...over,
});
const failedPull = (reason: string, over: Record<string, unknown> = {}) =>
  pull({ p_outcome: "failed", p_reason: reason, ...over });

const get = async (
  portal = "jamesedition",
  token = TOKEN,
  headers: Record<string, string> = { "user-agent": UA },
) => {
  const res = await GET(new NextRequest(`https://crm.example/api/portals/${portal}/${token}`, { headers }), {
    params: Promise.resolve({ portal, token }),
  });
  await Promise.all(state.afters.splice(0));
  // every response, headers and body, for the standing "never the token" check
  state.responses.push({ status: res.status, text: JSON.stringify([...res.headers]) + (await res.clone().text()) });
  return res;
};

const rpcArgs = (name: string) => state.rpcs.find((r) => r.name === name)?.args;
const logged = (fn: typeof console.error | typeof console.warn) =>
  vi
    .mocked(fn)
    .mock.calls.map((c: unknown[]) => c.map(String).join(" "))
    .join("\n");
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

beforeEach(() => {
  state.connection = [connectionRow()];
  state.recount = null;
  state.connectionLookups = 0;
  state.connectionError = null;
  state.supplements = [supplement()];
  state.supplementAnswer = null;
  state.supplementError = null;
  state.supplementErrorFrom = null;
  state.supplementPageCap = null;
  state.supplementInfinite = false;
  state.listings = [listingRow()];
  state.listingsAnswer = null;
  state.listingsError = null;
  state.listingsInfinite = false;
  state.syncAnswer = null;
  state.syncedAt = SYNCED_AT;
  state.recordError = null;
  state.adminThrows = false;
  state.calls = [];
  state.rpcs = [];
  state.adminCalls = [];
  state.adminRpcs = [];
  state.adminBuilt = 0;
  state.ranges = [];
  state.supplementOrders = [];
  state.pulls = [];
  state.syncs = [];
  state.afters = [];
  state.responses = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  try {
    // REL-03: a valid token is the proof; the feed never touches a counter row.
    expect(state.calls).not.toContain("note_public_listing_hit");
    // the ETag is the body's own digest now; the snapshot round trip is gone
    expect(state.calls).not.toContain("public_listings_etag");
    // Each role only where 0150 grants it. A write sent on the anon client is
    // refused by PostgREST and then swallowed (the record never fails the
    // feed), so it would vanish silently without this check — as would a
    // reader sent with the service role, which bypasses what anon may see.
    for (const name of state.calls) expect(PUBLIC_READERS, `public client asked for ${name}`).toContain(name);
    for (const name of state.adminCalls) expect(ADMIN_WRITES, `service role asked for ${name}`).toContain(name);
    // The token is a credential: it is in the request path by construction,
    // and must be in nothing we send back or write to a log.
    for (const r of state.responses) {
      expect(r.text).not.toContain(TOKEN);
      expect(r.text).not.toContain(TOKEN_SHA256);
    }
    for (const fn of [console.error, console.warn]) {
      expect(logged(fn)).not.toContain(TOKEN);
      expect(logged(fn)).not.toContain(TOKEN_SHA256);
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

describe("nothing knowable without the database costs a round trip", () => {
  it("404s an unknown portal id", async () => {
    const res = await get("not_a_portal");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.calls).toEqual([]);
    expect(state.adminBuilt).toBe(0);
  });

  it("404s a token that is not 64 lowercase hex", async () => {
    for (const token of ["short", "A".repeat(64), "z".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      const res = await get("jamesedition", token);
      expect(res.status, token).toBe(404);
      expect(res.headers.get("cache-control"), token).toBe("no-store");
    }
    expect(state.calls).toEqual([]);
    expect(state.adminBuilt).toBe(0);
  });

  it("404s a portal whose dialect has no renderer in this build, before any query", async () => {
    // rera is spec: "pending" — DIALECT_RENDERERS.rera is null, so there is
    // nothing to serialise and no reason to ask the database anything.
    const res = await get("rera");
    expect(res.status).toBe(404);
    expect(state.calls).toEqual([]);
    expect(state.adminBuilt).toBe(0);
  });
});

describe("the token is the whole of the proof", () => {
  it("404s a wrong token after exactly one lookup, and records nothing", async () => {
    state.connection = [];
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await res.text())).toEqual({ error: "Not found." });
    expect(state.calls).toEqual(["portal_feed_connection"]);
    // nothing proved the caller is the portal, so there is nobody to record
    expect(state.pulls).toEqual([]);
    expect(state.adminBuilt).toBe(0);
  });

  it("404s, not 503, when the lookup itself fails — a guesser learns nothing either way", async () => {
    state.connectionError = { message: "connection boom" };
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toContain("connection boom");
    expect(logged(console.error)).toContain("jamesedition");
    expect(logged(console.error)).toContain("connection boom");
    expect(state.calls).toEqual(["portal_feed_connection"]);
    expect(state.pulls).toEqual([]);
  });

  it.each([
    ["a hollow answer (data null)", null],
    ["an object instead of rows", { org_slug: "gnk", enabled: true }],
    ["a JSON string instead of rows", '[{"org_slug":"gnk","enabled":true}]'],
  ])("404s %s, never a document, and records nothing", async (_label, data) => {
    // postgrest-js reports an empty-bodied answer as `data: null, error: null`;
    // read as a row it would be a portal with no settings, enabled or not
    state.connection = data;
    const res = await get();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(await res.text())).toEqual({ error: "Not found." });
    expect(state.calls).toEqual(["portal_feed_connection"]);
    expect(state.pulls).toEqual([]);
  });
});

describe("the database is handed the token from the path, and hashes it itself (0150)", () => {
  it("every token-bearing call carries the plaintext token and never a digest", async () => {
    expect((await get()).status).toBe(200);
    expect(rpcArgs("portal_feed_connection")).toEqual({ p_portal: "jamesedition", p_token: TOKEN });
    expect(rpcArgs("portal_feed_supplement")).toEqual({ p_token: TOKEN });
    const bearing = [
      ...state.rpcs.filter((r) => r.name !== "public_listings"),
      ...state.adminRpcs,
    ];
    // the two readers and the two writes, every one of them
    expect(new Set(bearing.map((r) => r.name))).toEqual(
      new Set(["portal_feed_connection", "portal_feed_supplement", "record_portal_pull", "sync_portal_export"]),
    );
    for (const { name, args } of bearing) {
      expect(args.p_token, name).toBe(TOKEN);
      // a digest sent here would be hashed AGAIN and match no connection
      expect("p_token_sha256" in args, `${name} must not receive a digest`).toBe(false);
      expect(JSON.stringify(args), name).not.toContain(TOKEN_SHA256);
    }
    // the site feed is read by org, and holds no credential
    expect(JSON.stringify(rpcArgs("public_listings"))).not.toContain(TOKEN);
  });
});

describe("a connection row of the wrong shape is a fault, never a withdrawal", () => {
  it.each([
    ["enabled as the string 'false'", { enabled: "false" }],
    ["enabled null", { enabled: null }],
    ["enabled missing", { enabled: undefined }],
    ["enabled as 0", { enabled: 0 }],
    ["org_slug missing", { org_slug: undefined }],
    ["org_slug empty", { org_slug: "" }],
    ["selected_count missing", { selected_count: undefined }],
    ["selected_count as a string", { selected_count: "1" }],
    ["selected_count not an integer", { selected_count: 1.5 }],
    ["selected_count negative", { selected_count: -1 }],
    ["settings as an array", { settings: [] }],
  ])("503s %s and records connection_malformed", async (_label, over) => {
    // The token matched, so this IS the portal asking. `!row.enabled` on a
    // skewed row would serve the empty document — every listing withdrawn
    // from the portal for a reason that is nobody's decision.
    state.connection = [connectionRow(over)];
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "Feed unavailable." });
    expect(body).not.toBe(kyero.empty());
    expect(state.calls).toEqual(["portal_feed_connection"]);
    expect(state.pulls).toEqual([failedPull("connection_malformed")]);
    expect(logged(console.error)).toContain("jamesedition");
  });
});

describe("a disabled portal gets an empty document, never a 404", () => {
  it("answers 200 with the dialect's empty feed, nothing cached, and records the pull as disabled", async () => {
    // 0150 counts no selection for a disabled connection
    state.connection = [connectionRow({ enabled: false, settings: {}, selected_count: 0 })];
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(kyero.empty());
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // an empty feed is the whole answer: no supplement, no listings, no revisions
    expect(state.calls).toEqual(["portal_feed_connection"]);
    expect(state.syncs).toEqual([]);
    // recorded deliberately: a frozen "last requested" would read as "the
    // portal stopped calling", when in fact it is calling and getting nothing
    expect(state.pulls).toEqual([pull({ p_outcome: "disabled", p_served: 0 })]);
  });

  it("stays empty when a disabled row still carries settings and a count", async () => {
    // the switch decides, not the rest of the row
    state.connection = [connectionRow({ enabled: false, selected_count: 4 })];
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(kyero.empty());
    expect(state.calls).toEqual(["portal_feed_connection"]);
    expect(state.pulls).toEqual([pull({ p_outcome: "disabled", p_served: 0 })]);
  });
});

describe("an enabled portal gets the listings selected for it", () => {
  it("renders the feed, pages both reads the agreed way, dates by the export revision, and records the pull", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<ref>PAF0001</ref>");
    expect(body).toContain("<email>sales@example.com</email>");
    // the supplement's JPEG path, made absolute against the project URL
    expect(body).toContain(`<url>${SUPABASE_URL}/storage/v1/object/public/media/properties/p1/1_jpeg.jpg</url>`);
    // the date is when what the portal receives last changed (0150), not the
    // row's updated_at — an edit to an internal field must not re-date it
    expect(body).toContain("<date>2026-10-01 09:00:00</date>");
    expect(body).not.toContain("2026-09-10 08:30:15");
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    // ETag = feedEtag(portalId, body): the body's own digest, under the portal's name
    expect(res.headers.get("etag")).toBe(`W/"jamesedition-${sha256Hex(body).slice(0, 32)}"`);
    expect(res.headers.get("etag") ?? "").toMatch(/^W\/"jamesedition-[0-9a-f]{32}"$/);

    // the CONTRACT of assemblePortalFeed: exactly p_limit/p_offset, so a short
    // page can mean "the last page"
    expect(rpcArgs("public_listings")).toEqual({ p_org_slug: "gnk", p_limit: 100, p_offset: 0 });
    // the supplement is read until an EMPTY page (fetchUpTo), advancing by what
    // arrived — so one row read means a second ask starting at row 1
    expect(state.ranges).toEqual([
      [0, 999],
      [1, 1000],
    ]);
    // paging portal_feed_supplement, which has no ORDER BY, is only stable ordered
    expect(state.supplementOrders).toEqual(["reference", "reference"]);
    // the fingerprint of what the portal receives, by reference, on the service role
    expect(state.syncs).toEqual([
      { p_token: TOKEN, p_rows: [{ reference: "PAF0001", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }] },
    ]);
    expect(state.pulls).toEqual([
      pull({ p_served: 1, p_selected: 1, p_excluded: 0, p_detail: { revisions: "synced" } }),
    ]);
    expect(logged(console.warn)).toBe("");
  });

  it("serves the eligible listings and records the rest by reason", async () => {
    // JamesEdition takes residential only, two photos of at least 800×600 —
    // the sizes reach eligibility from the supplement's width/height
    state.connection = [connectionRow({ selected_count: 3 })];
    state.supplements = [
      supplement(),
      supplement({
        reference: "PAF0005",
        images: [{ jpeg: "properties/p5/1_jpeg.jpg", alt: {}, width: 4000, height: 3000 }],
      }),
      supplement({
        reference: "PAF0006",
        images: [
          { jpeg: "properties/p6/1_jpeg.jpg", alt: {}, width: 640, height: 480 },
          { jpeg: "properties/p6/2_jpeg.jpg", alt: {}, width: 640, height: 480 },
        ],
      }),
    ];
    state.listings = [
      listingRow(),
      listingRow({ reference: "PAF0005", property_type: "shop" }),
      listingRow({ reference: "PAF0006" }),
    ];
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<ref>PAF0001</ref>");
    expect(body).not.toContain("PAF0005");
    expect(body).not.toContain("PAF0006");
    // only what goes out is dated
    expect((state.syncs[0]?.p_rows as Array<{ reference: string }>).map((r) => r.reference)).toEqual(["PAF0001"]);
    expect(state.pulls).toEqual([
      pull({
        p_served: 1,
        p_selected: 3,
        p_excluded: 2,
        p_detail: { type_not_accepted: 1, too_few_photos: 2, revisions: "synced" },
      }),
    ]);
    // exclusions are served, never silent
    expect(logged(console.warn)).toContain("2 of 3 selected listing(s) excluded");
  });

  it("records a missing JPEG rendition and a reference that left the site feed, by name", async () => {
    // PAF0007's website shows three photos but only one has its JPEG — the
    // pipeline's fault, not the desk's (feed.ts isRenditionGap). PAF0009 was
    // selected but the completed scan did not find it.
    state.connection = [connectionRow({ selected_count: 3 })];
    state.supplements = [
      supplement(),
      supplement({
        reference: "PAF0007",
        images: [{ jpeg: "properties/p7/1_jpeg.jpg", alt: {}, width: 4000, height: 3000 }],
      }),
      supplement({ reference: "PAF0009" }),
    ];
    state.listings = [
      listingRow(),
      listingRow({ reference: "PAF0007", images: [{ path: "a.webp" }, { path: "b.webp" }, { path: "c.webp" }] }),
    ];
    const res = await get();
    expect(res.status).toBe(200);
    expect(state.pulls).toEqual([
      pull({
        p_served: 1,
        p_selected: 3,
        p_excluded: 1,
        p_detail: { too_few_photos: 1, revisions: "synced", missing: 1, rendition_gaps: 1 },
      }),
    ]);
    expect(logged(console.warn)).toContain("1 selected reference(s) not in the site feed");
  });

  it("links each listing to its page on the website when the site's address is configured", async () => {
    vi.stubEnv("PUBLIC_SITE_URL", "https://site.example");
    const body = await (await get()).text();
    expect(body).toContain("<en>https://site.example/properties/PAF0001</en>");
  });

  it("answers 304 to a matching If-None-Match with no body, and still records the pull", async () => {
    const etag = (await get()).headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    state.pulls = [];
    const res = await get("jamesedition", TOKEN, { "user-agent": UA, "if-none-match": etag });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.text()).toBe("");
    // "last requested" means when the portal last ASKED, not when it last got bytes
    expect(state.pulls).toEqual([
      pull({ p_served: 1, p_selected: 1, p_excluded: 0, p_detail: { revisions: "synced" } }),
    ]);
  });

  it("answers 200 with the body when If-None-Match names another version", async () => {
    const res = await get("jamesedition", TOKEN, { "user-agent": UA, "if-none-match": 'W/"jamesedition-stale"' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<ref>PAF0001</ref>");
  });

  it("changes the ETag exactly when what the portal receives changes", async () => {
    const first = await get();
    const firstBody = await first.text();
    const again = await get();
    // unchanged data: the same fingerprint, the same bytes, the same validator
    expect(again.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(state.syncs[1]).toEqual(state.syncs[0]);

    // a new export revision re-dates the listing, so the bytes and the ETag move
    state.syncedAt = "2026-10-05T12:00:00+00:00";
    const moved = await get();
    const movedBody = await moved.text();
    expect(movedBody).toContain("<date>2026-10-05 12:00:00</date>");
    expect(moved.headers.get("etag")).not.toBe(first.headers.get("etag"));
    expect(moved.headers.get("etag")).toBe(`W/"jamesedition-${sha256Hex(movedBody).slice(0, 32)}"`);
    expect(firstBody).not.toBe(movedBody);
    // the fingerprint leaves the date out, or every sync would re-date it
    expect(state.syncs[2]).toEqual(state.syncs[0]);
  });

  it("records an empty user agent rather than nothing when the caller gave none", async () => {
    expect((await get("jamesedition", TOKEN, {})).status).toBe(200);
    expect(state.pulls).toEqual([
      pull({ p_ua: "", p_served: 1, p_selected: 1, p_excluded: 0, p_detail: { revisions: "synced" } }),
    ]);
  });
});

describe("the supplement is read whole, or not at all", () => {
  it("reads in pages until an EMPTY one (PostgREST caps a call at max_rows)", async () => {
    state.connection = [connectionRow({ selected_count: 1003 })];
    state.supplements = [
      supplement(),
      ...Array.from({ length: 1002 }, (_, i) => supplement({ reference: `SEL${i}` })),
    ];
    // every selected reference is on the site feed (a scan that missed more
    // than MAX_RECHECK of them would be refused — feed.test.ts pins that)
    state.listings = [listingRow(), ...Array.from({ length: 1002 }, (_, i) => listingRow({ reference: `SEL${i}` }))];
    const res = await get();
    expect(res.status).toBe(200);
    expect(state.ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [1003, 2002],
    ]);
    expect(state.pulls).toEqual([
      pull({ p_served: 1003, p_selected: 1003, p_excluded: 0, p_detail: { revisions: "synced" } }),
    ]);
    // a 1,003-listing document is rendered and fingerprinted for real
  }, 30_000);

  it("is not ended early by a lowered max_rows — every page short, the read still whole", async () => {
    // A short page is NOT the last page: lower max_rows (a plausible hardening
    // of the anon key) and every page comes back short. A short-page stop
    // would read 500 of 1200 and then refuse the feed as incomplete.
    state.supplementPageCap = 500;
    state.connection = [connectionRow({ selected_count: 1200 })];
    state.supplements = [
      supplement(),
      ...Array.from({ length: 1199 }, (_, i) => supplement({ reference: `SEL${i}` })),
    ];
    state.listings = [listingRow(), ...Array.from({ length: 1199 }, (_, i) => listingRow({ reference: `SEL${i}` }))];
    const res = await get();
    expect(res.status).toBe(200);
    expect(state.ranges).toEqual([
      [0, 999],
      [500, 1499],
      [1000, 1999],
      [1200, 2199],
    ]);
    expect(state.pulls[0]).toMatchObject({ p_outcome: "served", p_selected: 1200 });
  }, 30_000);

  it("serves a supplement LONGER than the connection's count — a listing went public between the two reads", async () => {
    state.connection = [connectionRow({ selected_count: 0 })];
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<ref>PAF0001</ref>");
    expect(state.pulls[0]).toMatchObject({ p_outcome: "served", p_served: 1, p_selected: 1 });
  });
});

describe("export revisions are best effort: the feed still goes out, dated by updated_at", () => {
  const assertFallback = async (res: Response) => {
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<ref>PAF0001</ref>");
    expect(body).toContain("<date>2026-09-10 08:30:15</date>");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(state.pulls).toEqual([
      pull({ p_served: 1, p_selected: 1, p_excluded: 0, p_detail: { revisions: "fallback" } }),
    ]);
    expect(logged(console.warn)).toContain("export revisions unavailable");
  };

  it("when sync_portal_export fails", async () => {
    state.syncAnswer = { data: null, error: { message: "sync boom" } };
    const res = await get();
    await assertFallback(res);
    expect(state.responses.at(-1)?.text).not.toContain("sync boom");
  });

  it.each([
    ["a hollow answer (data null)", null],
    ["an array instead of an object", [{ reference: "PAF0001", changed_at: SYNCED_AT }]],
    ["a string", SYNCED_AT],
    ["a date that does not parse", { PAF0001: "not a date" }],
    ["an object without the listing", { PAF9999: SYNCED_AT }],
  ])("when sync_portal_export answers %s", async (_label, data) => {
    // every listing dated, or none: a partial answer would mix two clocks
    state.syncAnswer = { data, error: null };
    await assertFallback(await get());
  });

  it("when the service key cannot build a client — costing the dates and the record, never the feed", async () => {
    state.adminThrows = true;
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<date>2026-09-10 08:30:15</date>");
    expect(state.adminBuilt).toBe(2);
    expect(state.pulls).toEqual([]);
    expect(logged(console.warn)).toContain("export revisions unavailable");
    expect(logged(console.warn)).toContain("record_portal_pull threw");
  });

  it("a record that fails never fails the feed — the portal already has its bytes", async () => {
    state.recordError = { message: "record boom" };
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<ref>PAF0001</ref>");
    expect(logged(console.warn)).toContain("record_portal_pull failed");
  });
});

describe("an enabled portal with nothing selected", () => {
  it("serves the empty document — cacheable, recorded, and without asking for a single listing", async () => {
    state.connection = [connectionRow({ selected_count: 0 })];
    state.supplements = [];
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(kyero.empty());
    // NOT no-store: unlike a disabled portal this is a live feed that happens
    // to be empty, and the ETag is what tells the portal it has not changed
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("etag")).toBe(`W/"jamesedition-${sha256Hex(body).slice(0, 32)}"`);
    // no selection means no query — the assembler never pages the site feed
    expect(state.calls).not.toContain("public_listings");
    // but the revisions ARE synced, with no rows, so every listing that left
    // is forgotten and comes back new (0150's delete step)
    expect(state.syncs).toHaveLength(1);
    expect(state.syncs[0]).toMatchObject({ p_token: TOKEN, p_rows: [] });
    expect(state.pulls).toEqual([
      pull({ p_served: 0, p_selected: 0, p_excluded: 0, p_detail: { revisions: "synced" } }),
    ]);
    // nothing was selected, so nothing is wrong
    expect(logged(console.warn)).toBe("");
  });

  it("serves the empty document when everything selected fails the portal's requirements, and says why", async () => {
    // JamesEdition wants two photos; a listing with one is the desk's to fix.
    // A 503 here would keep the portal's WHOLE previous copy up, stale prices
    // and sold listings included (feed.ts, finding 5).
    state.supplements = [
      supplement({ images: [{ jpeg: "properties/p1/1_jpeg.jpg", alt: {}, width: 4000, height: 3000 }] }),
    ];
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(kyero.empty());
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    // synced with no rows: the excluded listing's revision is forgotten
    expect(state.syncs).toHaveLength(1);
    expect(state.syncs[0]).toMatchObject({ p_rows: [] });
    expect(state.pulls).toEqual([
      pull({ p_served: 0, p_selected: 1, p_excluded: 1, p_detail: { too_few_photos: 1, revisions: "synced" } }),
    ]);
    expect(logged(console.warn)).toContain("jamesedition");
    expect(logged(console.warn)).toContain("1 of 1 selected listing(s) excluded");
  });
});

describe("a failure is a 503, recorded, and says nothing about the database", () => {
  const assertUnavailable = async (res: Response, secret?: string) => {
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "Feed unavailable." });
    // never the empty document, which a pull portal reads as "remove everything"
    expect(body).not.toContain("<root>");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBeNull();
    expect(logged(console.error)).toContain("jamesedition");
    if (secret) {
      expect(body).not.toContain(secret);
      // the log keeps the database's words; only the body is generic
      expect(logged(console.error)).toContain(secret);
    }
    // nothing was served, so nothing is dated
    expect(state.syncs).toEqual([]);
  };

  it("when the supplement fails", async () => {
    state.supplementError = { message: "supplement boom" };
    await assertUnavailable(await get(), "supplement boom");
    expect(state.pulls).toEqual([failedPull("supplement_failed")]);
    expect(state.calls).not.toContain("public_listings");
  });

  it.each([
    ["a hollow answer (data null)", null],
    ["a JSON string", JSON.stringify([{ reference: "PAF0001" }])],
    ["an object", { reference: "PAF0001", lat: 34.8821, lng: 32.3789, location_approx: false, images: [] }],
  ])("when the supplement answers %s instead of rows", async (_label, data) => {
    // postgrest-js reports an empty-bodied OK as `data: null, error: null`;
    // read as "no rows" it would be the empty document
    state.supplementAnswer = { data, error: null };
    await assertUnavailable(await get());
    expect(state.pulls).toEqual([failedPull("supplement_failed")]);
    expect(state.calls).not.toContain("public_listings");
  });

  it("when a supplement page fails after a full one — the first page is not everything", async () => {
    state.connection = [connectionRow({ selected_count: 1000 })];
    state.supplements = Array.from({ length: 1000 }, (_, i) => supplement({ reference: `SEL${i}` }));
    state.supplementErrorFrom = 1000;
    await assertUnavailable(await get(), "supplement page boom");
    expect(state.ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(state.pulls).toEqual([failedPull("supplement_failed")]);
  });

  it.each([
    ["a row that is null", null],
    ["an empty reference", supplement({ reference: "" })],
    ["no reference", supplement({ reference: undefined })],
    ["a latitude as text", supplement({ lat: "34.8821" })],
    ["location_approx as text", supplement({ location_approx: "false" })],
    ["images that are not an array", supplement({ images: "[]" })],
    ["an image path that is not text", supplement({ images: [{ jpeg: 5, alt: {}, width: 4000, height: 3000 }] })],
    ["an image width as text", supplement({ images: [{ jpeg: "x.jpg", alt: {}, width: "4000", height: 3000 }] })],
  ])("when a supplement row has %s", async (_label, row) => {
    // a row with no usable reference selects nothing — an empty feed by another road
    state.supplements = [row as Record<string, unknown>];
    await assertUnavailable(await get());
    expect(state.pulls).toEqual([failedPull("supplement_malformed")]);
    expect(state.calls).not.toContain("public_listings");
  });

  it("when the supplement is shorter than the connection's count of the selection", async () => {
    // The array-bodied-404 case: postgrest-js turns it into `data: []`, which
    // by its shape alone is an empty selection — and an empty document. The
    // connection counted the selection independently (0150) to catch exactly this.
    state.connection = [connectionRow({ selected_count: 1 })];
    state.supplements = [];
    await assertUnavailable(await get());
    expect(state.pulls).toEqual([failedPull("supplement_incomplete", { p_selected: 1 })]);
    expect(state.calls).not.toContain("public_listings");
  });

  it("when a lost page leaves the supplement one row short", async () => {
    state.connection = [connectionRow({ selected_count: 3 })];
    state.supplements = [supplement(), supplement({ reference: "PAF0002" })];
    await assertUnavailable(await get());
    expect(state.pulls).toEqual([failedPull("supplement_incomplete", { p_selected: 3 })]);
  });

  it("NOT when a listing left the selection between the two reads: a fresh count agrees, and it simply drops out", async () => {
    // selected_count said 2; the listing was sold before the supplement read
    // it; the recount says 1 — a departure, which must leave the feed now
    // rather than keep the portal's whole stale copy up behind a 503
    state.connection = [connectionRow({ selected_count: 2 })];
    state.recount = [connectionRow({ selected_count: 1 })];
    state.supplements = [supplement()];
    const res = await get();
    expect(res.status).toBe(200);
    expect(state.connectionLookups).toBe(2);
    expect(state.pulls[0]).toMatchObject({ p_outcome: "served", p_served: 1 });
  });

  it("when the recount still says more than the supplement answered, or the connection went away", async () => {
    state.connection = [connectionRow({ selected_count: 2 })];
    state.recount = [connectionRow({ selected_count: 2 })];
    state.supplements = [supplement()];
    await assertUnavailable(await get());
    expect(state.pulls).toEqual([failedPull("supplement_incomplete", { p_selected: 2 })]);

    state.pulls = [];
    state.connectionLookups = 0;
    state.recount = [];
    await assertUnavailable(await get());
    expect(state.pulls).toEqual([failedPull("supplement_incomplete", { p_selected: 2 })]);
  });

  it("when the selection is larger than the scan that would have to find it", async () => {
    // 2,500 = the assembler's MAX_PAGES x MAX_LIMIT. A selection past it can
    // never be fully scanned, so it is refused once one row past the ceiling
    // has been read, rather than after every round trip needed to prove it.
    state.connection = [connectionRow({ selected_count: 3000 })];
    state.supplementInfinite = true;
    await assertUnavailable(await get());
    expect(state.ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2500],
    ]);
    expect(logged(console.error)).toContain("selection exceeds 2500 rows");
    expect(state.pulls).toEqual([failedPull("selection_too_large")]);
    expect(state.calls).not.toContain("public_listings");
  });

  it("when the desk's settings would not survive the portal's own schema", async () => {
    // the dialect renders `email` into a live contact node; an unreplyable
    // address is worse for the desk than a feed that is briefly unavailable
    state.connection = [connectionRow({ settings: { email: "nope" } })];
    await assertUnavailable(await get());
    expect(logged(console.error)).toContain("settings invalid");
    expect(state.pulls).toEqual([failedPull("settings_invalid", { p_selected: 1 })]);
    expect(state.calls).not.toContain("public_listings");
  });

  it("when a listings page fails — never an empty document, which would clear the portal", async () => {
    state.listingsError = { message: "listings boom" };
    await assertUnavailable(await get(), "listings boom");
    expect(state.pulls).toEqual([failedPull("listings_failed", { p_selected: 1 })]);
  });

  it("when a listings page is hollow — data null is not a short page", async () => {
    state.listingsAnswer = { data: null, error: null };
    await assertUnavailable(await get());
    expect(state.pulls).toEqual([failedPull("listings_failed", { p_selected: 1 })]);
  });

  it("when a listings page carries rows of the wrong shape", async () => {
    state.listingsAnswer = { data: [{ ...listingRow(), reference: null }], error: null };
    await assertUnavailable(await get());
    expect(logged(console.error)).toContain("wrong shape");
    expect(state.pulls).toEqual([failedPull("listings_failed", { p_selected: 1 })]);
  });

  it.each([
    ["an empty page (an array-bodied 404 reads as [])", []],
    ["a page of listings nobody selected", [listingRow({ reference: "PAF0099" })]],
  ])("when a complete scan found none of the selected listings: %s", async (_label, rows) => {
    // Every selected listing leaving the website between two reads a few
    // milliseconds apart is not a race anyone will see; a hollow page is.
    state.listings = rows;
    await assertUnavailable(await get());
    expect(state.pulls).toEqual([failedPull("listings_incomplete", { p_selected: 1 })]);
  });

  it("when the scan hits the page ceiling before finding the selection", async () => {
    // every page full of rows nobody selected: the assembler cannot tell "not
    // on the feed" from "on the next page", so it refuses rather than ship a
    // feed that removes listings from the portal
    state.listingsInfinite = true;
    await assertUnavailable(await get());
    expect(logged(console.error)).toContain("truncated");
    const offsets = state.rpcs.filter((r) => r.name === "public_listings").map((r) => r.args.p_offset);
    expect(offsets).toEqual(Array.from({ length: 25 }, (_, i) => i * 100));
    expect(state.pulls).toEqual([failedPull("truncated", { p_selected: 1 })]);
  });
});
