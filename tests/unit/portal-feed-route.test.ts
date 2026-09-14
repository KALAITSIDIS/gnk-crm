import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/portals/[portal]/[token]/route";
import { kyero } from "@/lib/services/portals/dialects/kyero";
import { SALE_VILLA } from "@/lib/services/portals/dialects/__fixtures__/listings";
import type { PublicListingRow, SupplementRow } from "@/lib/services/portals/feed-listing";

/**
 * The portal feed over a faked Supabase client — the sibling of
 * public-listings-route.test.ts, and faked at the same seam: only
 * `createPublicClient` and `after()` are stand-ins. The path parameters, the
 * token check, the paging, the assembler, the dialect, the ETag and the
 * headers are the real route.
 *
 * What the file is really pinning is the set of promises a pull portal relies
 * on, each of which fails silently in production if it breaks:
 *
 *  - a DISABLED portal gets a valid EMPTY document, never a 404 — absence is
 *    how a pull portal is told to remove our listings, and a 404 leaves them
 *    stale on the portal forever;
 *  - a FAILURE is a 503, never an empty document, for the same reason: an
 *    empty feed would delete a live book of listings off the portal;
 *  - no Postgres text reaches the body, because that body lands in a third
 *    party's logs;
 *  - the pull is noted even when the answer is 304, because "last pulled" on
 *    the settings page means "when did the portal last ask";
 *  - and the feed is NEVER metered (`note_public_listing_hit`) — a valid
 *    token is the proof, and the counter row is the shared-lock problem
 *    REL-03 removed from the site feed on 2026-09-13. Asserted after EVERY
 *    test, not in one of them.
 */

const TOKEN = "a".repeat(64);
const SNAPSHOT = "5|2026-09-10T08:30:15+00:00|abc";
const UA = "KyeroBot/1.0";

const state = vi.hoisted(() => ({
  connection: [] as Array<Record<string, unknown>>,
  connectionError: null as { message: string } | null,
  supplements: [] as Array<Record<string, unknown>>,
  supplementError: null as { message: string } | null,
  listings: [] as Array<Record<string, unknown>>,
  /** every page full of rows nobody selected — what a scan that cannot finish looks like */
  listingsInfinite: false,
  listingsError: null as { message: string } | null,
  snapshot: "" as string,
  snapshotError: null as { message: string } | null,
  calls: [] as string[],
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  ranges: [] as Array<[number, number]>,
  pulls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase/public", () => ({
  createPublicClient: () => ({
    rpc: (name: string, args: Record<string, unknown> = {}) => {
      state.calls.push(name);
      state.rpcs.push({ name, args });
      if (name === "portal_supplement") {
        // the real builder is not a promise until `.range()` narrows it
        return {
          range: async (from: number, to: number) => {
            state.ranges.push([from, to]);
            return state.supplementError
              ? { data: null, error: state.supplementError }
              : { data: state.supplements.slice(from, to + 1), error: null };
          },
        };
      }
      if (name === "portal_connection_by_token") {
        return Promise.resolve(
          state.connectionError
            ? { data: null, error: state.connectionError }
            : { data: state.connection, error: null },
        );
      }
      if (name === "public_listings_etag") {
        return Promise.resolve(
          state.snapshotError
            ? { data: null, error: state.snapshotError }
            : { data: state.snapshot, error: null },
        );
      }
      if (name === "public_listings") {
        if (state.listingsError) return Promise.resolve({ data: null, error: state.listingsError });
        const offset = Number(args.p_offset ?? 0);
        const limit = Number(args.p_limit ?? 0);
        if (state.listingsInfinite) {
          const page = Array.from({ length: limit }, (_, i) => ({
            ...SALE_VILLA.row,
            reference: `UNR${offset + i}`,
          }));
          return Promise.resolve({ data: page, error: null });
        }
        return Promise.resolve({ data: state.listings.slice(offset, offset + limit), error: null });
      }
      if (name === "note_portal_pull") {
        state.pulls.push(args);
        return Promise.resolve({ data: null, error: null });
      }
      throw new Error("unexpected rpc " + name);
    },
  }),
}));

// after() throws outside a request scope and the route then sends inline; the
// stand-in makes the call observable either way.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (fn: () => unknown) => {
      void fn();
    },
  };
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";

/** PAF0001, two JPEGs, an exact point — the shape 0095's supplement returns. */
const supplement = (over: Partial<SupplementRow> = {}): Record<string, unknown> => ({
  reference: "PAF0001",
  lat: 34.8821,
  lng: 32.3789,
  location_approx: false,
  images: [
    { jpeg: "properties/p1/1_jpeg.jpg", alt: { en: "Front elevation" } },
    { jpeg: "properties/p1/2_jpeg.jpg", alt: {} },
  ],
  ...over,
});

const listingRow = () => ({ ...(SALE_VILLA.row as PublicListingRow) });

const get = (
  portal = "jamesedition",
  token = TOKEN,
  headers: Record<string, string> = { "user-agent": UA },
) =>
  GET(new NextRequest(`https://crm.example/api/portals/${portal}/${token}`, { headers }), {
    params: Promise.resolve({ portal, token }),
  });

const rpcArgs = (name: string) => state.rpcs.find((r) => r.name === name)?.args;
const logged = (fn: typeof console.error | typeof console.warn) =>
  vi
    .mocked(fn)
    .mock.calls.map((c: unknown[]) => c.map(String).join(" "))
    .join("\n");

beforeEach(() => {
  state.connection = [{ org_slug: "gnk", enabled: true, settings: { email: "sales@example.com" } }];
  state.connectionError = null;
  state.supplements = [supplement()];
  state.supplementError = null;
  state.listings = [listingRow()];
  state.listingsInfinite = false;
  state.listingsError = null;
  state.snapshot = SNAPSHOT;
  state.snapshotError = null;
  state.calls = [];
  state.rpcs = [];
  state.ranges = [];
  state.pulls = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // REL-03: a valid token is the proof; the feed never touches a counter row.
  expect(state.calls).not.toContain("note_public_listing_hit");
  vi.restoreAllMocks();
});

describe("nothing knowable without the database costs a round trip", () => {
  it("404s an unknown portal id", async () => {
    const res = await get("not_a_portal");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.calls).toEqual([]);
  });

  it("404s a token that is not 64 hex", async () => {
    expect((await get("jamesedition", "short")).status).toBe(404);
    expect((await get("jamesedition", "A".repeat(64))).status).toBe(404);
    expect((await get("jamesedition", "z".repeat(64))).status).toBe(404);
    expect(state.calls).toEqual([]);
  });

  it("404s a portal whose dialect has no renderer in this build, before any query", async () => {
    // rera is spec: "pending" — DIALECT_RENDERERS.rera is null, so there is
    // nothing to serialise and no reason to ask the database anything.
    const res = await get("rera");
    expect(res.status).toBe(404);
    expect(state.calls).toEqual([]);
  });
});

describe("the token is the whole of the proof", () => {
  it("404s a wrong token after exactly one lookup — nothing else is touched", async () => {
    state.connection = [];
    const res = await get();
    expect(res.status).toBe(404);
    expect(JSON.parse(await res.text())).toEqual({ error: "Not found." });
    expect(state.calls).toEqual(["portal_connection_by_token"]);
    expect(rpcArgs("portal_connection_by_token")).toEqual({
      p_portal: "jamesedition",
      p_token: TOKEN,
    });
    expect(state.pulls).toEqual([]);
  });

  it("404s, not 503, when the lookup itself fails — a guesser learns nothing either way", async () => {
    state.connectionError = { message: "connection boom" };
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("connection boom");
    expect(logged(console.error)).toContain("jamesedition");
  });
});

describe("a disabled portal gets an empty document, never a 404", () => {
  it("answers 200 with the dialect's empty feed and nothing cached", async () => {
    state.connection = [{ org_slug: "gnk", enabled: false, settings: {} }];
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(kyero.empty());
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // an empty feed is the whole answer: no supplement, no listings, no snapshot
    expect(state.calls).toEqual(["portal_connection_by_token"]);
  });
});

describe("an enabled portal gets the listings selected for it", () => {
  it("renders the feed, pages public_listings the assembler's way, and notes the pull", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<ref>PAF0001</ref>");
    expect(body).toContain("<email>sales@example.com</email>");
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("etag") ?? "").toMatch(/^W\/"5\|.*-[0-9a-f]{32}"$/);

    // the CONTRACT of assemblePortalFeed: exactly p_limit/p_offset, so a short
    // page can mean "the last page"
    expect(rpcArgs("public_listings")).toEqual({ p_org_slug: "gnk", p_limit: 100, p_offset: 0 });
    expect(state.ranges).toEqual([[0, 999]]);
    expect(state.pulls).toEqual([{ p_token: TOKEN, p_ua: UA, p_count: 1 }]);
  });

  it("answers 304 to a matching If-None-Match with no body, and still notes the pull", async () => {
    const etag = (await get()).headers.get("etag") ?? "";
    state.pulls = [];
    const res = await get("jamesedition", TOKEN, { "user-agent": UA, "if-none-match": etag });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.text()).toBe("");
    // "last pulled" means when the portal last ASKED, not when it last got bytes
    expect(state.pulls).toEqual([{ p_token: TOKEN, p_ua: UA, p_count: 1 }]);
  });

  it("sends an empty user agent rather than nothing when the caller gave none", async () => {
    expect((await get("jamesedition", TOKEN, {})).status).toBe(200);
    expect(state.pulls).toEqual([{ p_token: TOKEN, p_ua: "", p_count: 1 }]);
  });

  it("reads the supplement in pages until a short one (PostgREST caps a call at max_rows)", async () => {
    state.supplements = [
      supplement(),
      ...Array.from({ length: 1002 }, (_, i) => supplement({ reference: `UNSELECTED${i}` })),
    ];
    const res = await get();
    expect(res.status).toBe(200);
    expect(state.ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    // the 1002 references the site feed does not carry are reported, not fatal
    expect(logged(console.warn)).toContain("1002 selected reference(s) not in the site feed");
  });
});

describe("a failure is a 503 and says nothing about the database", () => {
  const assertUnavailable = async (res: Response, secret: string) => {
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "Feed unavailable." });
    expect(body).not.toContain(secret);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(logged(console.error)).toContain("jamesedition");
    expect(logged(console.error)).toContain(secret);
  };

  it("when a listings page throws — never an empty document, which would clear the portal", async () => {
    state.listingsError = { message: "listings boom" };
    await assertUnavailable(await get(), "listings boom");
    expect(state.pulls).toEqual([]);
  });

  it("when the supplement fails", async () => {
    state.supplementError = { message: "supplement boom" };
    await assertUnavailable(await get(), "supplement boom");
    expect(state.pulls).toEqual([]);
  });

  it("when the snapshot cannot be computed", async () => {
    state.snapshotError = { message: "snapshot boom" };
    await assertUnavailable(await get(), "snapshot boom");
    expect(state.pulls).toEqual([]);
  });

  it("when the scan hits the page ceiling before finding the selection", async () => {
    // every page full of rows nobody selected: the assembler cannot tell "not
    // on the feed" from "on the next page", so it refuses rather than ship a
    // feed that removes listings from the portal
    state.listingsInfinite = true;
    const res = await get();
    expect(res.status).toBe(503);
    expect(logged(console.error)).toContain("truncated");
    expect(state.pulls).toEqual([]);
  });
});

describe("a feed that is quietly wrong is a warning, not a silence", () => {
  it("warns when everything selected is ineligible — the empty document still goes out", async () => {
    // JamesEdition wants two photos; a stalled JPEG backfill leaves one.
    state.supplements = [supplement({ images: [{ jpeg: "properties/p1/1_jpeg.jpg", alt: {} }] })];
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(kyero.empty());
    const warned = logged(console.warn);
    expect(warned).toContain("jamesedition");
    expect(warned).toContain("nothing eligible");
    expect(state.pulls).toEqual([{ p_token: TOKEN, p_ua: UA, p_count: 0 }]);
  });
});

describe("the feed is not metered", () => {
  it("never calls note_public_listing_hit on the path that serves a feed", async () => {
    expect((await get()).status).toBe(200);
    expect(state.calls).toEqual([
      "portal_connection_by_token",
      "portal_supplement",
      "public_listings_etag",
      "public_listings",
      "note_portal_pull",
    ]);
  });
});
