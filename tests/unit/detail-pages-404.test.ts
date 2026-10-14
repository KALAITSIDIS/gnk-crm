import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every dynamic [id] page and route under app/ answers 404 for a segment that
 * is not an id — BEFORE any query (T-malformed-ids; BACKLOG "External audit —
 * 2026-10-14", "Malformed ids from URLs and action arguments reach queries
 * unchecked").
 *
 * Before: `/properties/<non-uuid>` and its `/units` threw "Property / Project
 * query failed" on PostgREST's 22P02 and rendered the error boundary; the
 * contact page wrote the raw segment into a PostgREST `.or()` filter string
 * before its existence gate; the deal and viewing pages queried and then
 * 404'd. The REAL page functions are called here with a params promise, and
 * the database is a tripwire: `createClient` throws, so a page that reaches
 * it fails with that error instead of `notFound()`'s digest.
 */

const createClient = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("REACHED THE DATABASE");
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => {
    throw new Error("REACHED THE PROFILE READ");
  },
}));

/** What next/navigation's notFound() throws: an Error whose digest says 404. */
const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";

const MALFORMED = [
  "not-a-uuid",
  "123",
  // a filter smuggled after an id: the contact page interpolated the segment into .or()
  "00000000-0000-0000-0000-000000000001,owner_contact_id.not.is.null",
  "00000000-0000-0000-0000-00000000000", // one digit short
];
const VALID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c01";

type PageProps = { params: Promise<{ id: string }>; searchParams?: Promise<Record<string, string>> };
type PageFn = (props: PageProps) => Promise<unknown>;

const PAGES: { route: string; load: () => Promise<{ default: unknown }>; withSearch?: boolean }[] = [
  { route: "/contacts/[id]", load: () => import("@/app/(app)/contacts/[id]/page") },
  { route: "/deals/[id]", load: () => import("@/app/(app)/deals/[id]/page") },
  { route: "/properties/[id]", load: () => import("@/app/(app)/properties/[id]/page"), withSearch: true },
  { route: "/properties/[id]/units", load: () => import("@/app/(app)/properties/[id]/units/page"), withSearch: true },
  { route: "/viewings/[id]", load: () => import("@/app/(app)/viewings/[id]/page") },
  { route: "/viewings/[id]/sign", load: () => import("@/app/(app)/viewings/[id]/sign/page") },
];

const props = (id: string, withSearch?: boolean): PageProps => ({
  params: Promise.resolve({ id }),
  ...(withSearch ? { searchParams: Promise.resolve({}) } : {}),
});

// braces: a function returned from beforeEach is run as its teardown
beforeEach(() => {
  createClient.mockClear();
});

describe("a dynamic [id] page 404s on a segment that is not an id, before any query", () => {
  for (const { route, load, withSearch } of PAGES) {
    it(`${route}: notFound() for each malformed id, and the database is never asked`, async () => {
      const Page = (await load()).default as PageFn;
      for (const id of MALFORMED) {
        const thrown = await Page(props(id, withSearch)).then(
          () => new Error("resolved"),
          (e: unknown) => e,
        );
        expect((thrown as { digest?: unknown }).digest, `${route} with "${id}"`).toBe(NOT_FOUND_DIGEST);
      }
      expect(createClient).not.toHaveBeenCalled();
    });

    it(`${route}: a well-formed id still goes to the database, as before`, async () => {
      const Page = (await load()).default as PageFn;
      await expect(Page(props(VALID, withSearch))).rejects.toThrow("REACHED THE DATABASE");
      expect(createClient).toHaveBeenCalledTimes(1);
    });
  }
});

describe("the viewing calendar file (a route handler) answers 404 on a malformed id", () => {
  it("404, not the 400 it used to give — and no query", async () => {
    const { GET } = await import("@/app/(app)/viewings/[id]/ics/route");
    for (const id of MALFORMED) {
      const res = await GET(new Request("http://localhost/viewings/x/ics"), { params: Promise.resolve({ id }) });
      expect(res.status, id).toBe(404);
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it("a well-formed id still goes to the database", async () => {
    const { GET } = await import("@/app/(app)/viewings/[id]/ics/route");
    await expect(
      GET(new Request("http://localhost/viewings/x/ics"), { params: Promise.resolve({ id: VALID }) }),
    ).rejects.toThrow("REACHED THE DATABASE");
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});
