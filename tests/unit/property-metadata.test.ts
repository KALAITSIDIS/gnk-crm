import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakePage } from "@/lib/testing/fake-client";
import { GUID_SHAPES } from "@/lib/testing/guid-shapes";

/**
 * A08: the property page's browser-tab title is the REFERENCE and nothing
 * else — no listing title, no owner's or buyer's name (tab titles end up in
 * browser history on shared devices) — and generateMetadata never throws:
 * a malformed id asks nothing of the database, and a missing or failed read
 * leaves the default title (the page itself 404s or shows the boundary).
 *
 * The REAL generateMetadata, with the session client replaced by a scripted
 * fake. Outside a React server render cache() is a plain call, so every case
 * here reads afresh.
 */

const session = vi.hoisted(() => ({
  pages: [] as unknown[],
  fail: false,
  argsOf: null as null | ((table: string, method: string) => unknown[][]),
}));
const createClient = vi.hoisted(() =>
  vi.fn(async () => {
    if (session.fail) throw new Error("no session");
    const { fakeClient: make } = await import("@/lib/testing/fake-client");
    const fake = make({ properties: session.pages as FakePage[] });
    session.argsOf = fake.argsOf;
    return fake.client;
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => {
    throw new Error("the metadata must not need the profile");
  },
}));

// imported while the file is collected (see tests/unit/detail-pages-404.test.ts)
const { generateMetadata } = await import("@/app/(app)/properties/[id]/page");

const meta = (id: string) => generateMetadata({ params: Promise.resolve({ id }) });

/** A row as the page's select returns it — with the words that must NOT reach the tab. */
const ROW = {
  id: GUID_SHAPES[0],
  reference: "PAF0042",
  title: { en: "Andreas Georgiou's sea-view flat", el: "Διαμέρισμα", ru: "Квартира" },
  owner_contact_id: "c0ffee00-0000-4000-8000-000000000001",
  owner_net_price: 199000,
  internal_notes: "owner wants a quick sale",
  districts: { name: { en: "Paphos" } },
  areas: { name: { en: "Kato Paphos" } },
};

beforeEach(() => {
  createClient.mockClear();
  session.pages = [];
  session.fail = false;
  session.argsOf = null;
});

describe("properties/[id] generateMetadata", () => {
  it("the title is the reference, exactly — none of the row's other words", async () => {
    for (const id of GUID_SHAPES) {
      session.pages = [{ data: { ...ROW, id }, error: null }];
      const m = await meta(id);
      expect(m, id).toEqual({ title: "PAF0042" });
      const said = JSON.stringify(m);
      for (const secret of ["Andreas", "Georgiou", "sea-view", "199000", "quick sale", "Paphos"]) {
        expect(said, `${secret} must not reach the tab`).not.toContain(secret);
      }
      // the one read is the page's own, by this id
      expect(session.argsOf!("properties", "eq")).toEqual([["id", id]]);
    }
    expect(createClient).toHaveBeenCalledTimes(GUID_SHAPES.length);
  });

  it("a malformed id: no title and no query", async () => {
    for (const id of ["not-a-uuid", "123", "00000000-0000-0000-0000-000000000001,reference.eq.X"]) {
      expect(await meta(id), id).toEqual({});
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it("not found, a failed read, or no session: the default title, never a throw", async () => {
    session.pages = [{ data: null, error: null }];
    expect(await meta(GUID_SHAPES[1])).toEqual({});
    session.pages = [{ data: null, error: { message: "boom", code: "XX000" } }];
    expect(await meta(GUID_SHAPES[1])).toEqual({});
    session.fail = true;
    expect(await meta(GUID_SHAPES[1])).toEqual({});
  });
});
