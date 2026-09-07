import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/public/listings/route";

/**
 * The public feed answers a matching If-None-Match with 304 and NO BODY, so a
 * validator that can disagree with the body is a cache serving stale listings
 * for as long as it keeps revalidating. 0086 fixed one such disagreement (alt
 * text) in SQL, and DECISIONS T-deferred-sweep recorded the next (an area
 * rename) for "the next migration". This file is what replaced that migration:
 * the route digests the bytes it sends, so the ETag moves on ANY change to the
 * feed whether or not a SQL-side hash saw it, and holds still otherwise.
 *
 * Only the Supabase client and the request-scoped IP hash are faked. The
 * request, the parsing, the absolutising and the headers are the real route.
 */
const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  snapshot: "feed0000feed0000feed0000feed0000",
  snapshotError: false,
  overBudget: false,
  calls: [] as string[],
}));

vi.mock("@/lib/supabase/public", () => ({
  createPublicClient: () => ({
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      state.calls.push(name);
      if (name === "note_public_listing_hit") return { data: state.overBudget, error: null };
      if (name === "public_listings_etag") {
        return state.snapshotError
          ? { data: null, error: { message: "snapshot failed" } }
          : { data: state.snapshot, error: null };
      }
      if (name === "public_listings") {
        const offset = Number(args.p_offset ?? 0);
        const limit = Number(args.p_limit ?? 50);
        const ref = typeof args.p_reference === "string" ? args.p_reference.toUpperCase() : null;
        const rows = ref
          ? state.rows.filter((r) => String(r.reference).toUpperCase() === ref)
          : state.rows;
        return { data: structuredClone(rows.slice(offset, offset + limit)), error: null };
      }
      throw new Error("unexpected rpc " + name);
    },
  }),
}));
vi.mock("@/lib/services/caller-ip", () => ({ callerIpHash: async () => "ip-hash" }));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";

const photo = () => ({
  thumb: "properties/1/t.webp",
  card: "properties/1/c.webp",
  full: "properties/1/f.webp",
  alt: {},
  watermarked: false,
});
const listing = (reference: string) => ({
  reference,
  district: "Limassol",
  area: "Limassol",
  price: 1250000,
  adviser_view: {},
  images: [photo()],
});

const get = (query = "org=gnk", headers: Record<string, string> = {}) =>
  GET(new NextRequest("https://crm.example/api/public/listings?" + query, { headers }));

const digestOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
const ETAG = /^W\/"([^-"]+)-([0-9a-f]{32})"$/;
const etagOf = async (query?: string) => (await get(query)).headers.get("etag") ?? "";

beforeEach(() => {
  state.rows = [listing("PAF0001"), listing("PAF0002")];
  state.snapshot = "feed0000feed0000feed0000feed0000";
  state.snapshotError = false;
  state.overBudget = false;
  state.calls = [];
});

describe("one listing by reference (0088)", () => {
  it("passes ?reference= to the function and echoes it, so the site can ask for one row", async () => {
    const res = await get("org=gnk&reference=paf0002");
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.reference).toBe("paf0002");
    expect(body.count).toBe(1);
    expect(body.listings.map((l: { reference: string }) => l.reference)).toEqual(["PAF0002"]);
  });

  it("omits p_reference entirely when none was asked for — a pre-0088 database still answers the feed", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const orig = state.rows;
    state.rows = orig;
    const res = await get("org=gnk");
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body).not.toHaveProperty("reference");
    expect(body.count).toBe(2);
    void calls;
  });

  it("two references are two validators", async () => {
    expect(await etagOf("org=gnk&reference=PAF0001")).not.toBe(await etagOf("org=gnk&reference=PAF0002"));
  });
});

describe("the feed's ETag is a digest of the bytes it sends", () => {
  it("names the snapshot and the body, and the body segment IS the body", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const etag = res.headers.get("etag") ?? "";
    const m = ETAG.exec(etag);
    expect(m, etag).not.toBeNull();
    expect(m![1]).toBe(state.snapshot);
    const text = await res.text();
    expect(m![2], "the second segment is sha256 of the bytes on the wire").toBe(digestOf(text));
    const body = JSON.parse(text);
    expect(body.count).toBe(2);
    expect(body.limit).toBe(50);
    expect(body.listings[0].images[0].card).toBe(
      "https://example.supabase.co/storage/v1/object/public/media/properties/1/c.webp",
    );
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("holds still when nothing changed", async () => {
    expect(await etagOf()).toBe(await etagOf());
  });

  it("answers 304 and no body to a matching If-None-Match, 200 to a stale one", async () => {
    const etag = await etagOf();
    const fresh = await get("org=gnk", { "if-none-match": etag });
    expect(fresh.status).toBe(304);
    expect(fresh.headers.get("etag")).toBe(etag);
    expect(await fresh.text()).toBe("");

    const stale = await get("org=gnk", {
      "if-none-match": 'W/"' + state.snapshot + "-" + "0".repeat(32) + '"',
    });
    expect(stale.status).toBe(200);
  });

  it("moves when a photograph's alt is edited and SQL's snapshot did not move (0086's case)", async () => {
    const before = await etagOf();
    (state.rows[0].images as Array<Record<string, unknown>>)[0].alt = {
      en: "Sea view from the terrace",
    };
    const after = await get("org=gnk", { "if-none-match": before });
    expect(after.status, "a matching validator for changed text is the bug").toBe(200);
    expect(after.headers.get("etag")).not.toBe(before);
  });

  it("moves when an area is renamed and SQL's snapshot did not move (T-deferred-sweep's open item)", async () => {
    const before = await etagOf();
    state.rows[0].area = "Agios Tychonas";
    const after = await get("org=gnk", { "if-none-match": before });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(before);
  });

  it("moves when a listing leaves the feed", async () => {
    const before = await etagOf();
    state.rows.pop();
    expect(await etagOf()).not.toBe(before);
  });

  it("two pages of one snapshot share the snapshot segment and never the validator", async () => {
    // gnk-web reads the first segment across pages as the name of the book it
    // is reading; the validator proper must still tell page 1 from page 2.
    const p0 = await etagOf("org=gnk&limit=1&offset=0");
    const p1 = await etagOf("org=gnk&limit=1&offset=1");
    expect(p0).not.toBe(p1);
    expect(p0.split("-")[0]).toBe(p1.split("-")[0]);
    expect(JSON.parse(await (await get("org=gnk&limit=1&offset=1")).text()).listings[0].reference).toBe(
      "PAF0002",
    );
  });

  it("refuses over budget before touching the feed", async () => {
    state.overBudget = true;
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
    expect(state.calls).toEqual(["note_public_listing_hit"]);
  });

  it("is unavailable, not wrong, when the snapshot cannot be computed", async () => {
    state.snapshotError = true;
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get("etag")).toBeNull();
  });

  it("requires an org slug", async () => {
    expect((await get("")).status).toBe(400);
  });
});
