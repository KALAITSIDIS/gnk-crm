import { describe, expect, it } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";
import { fetchSharedPhotoReferences, sharedPhotoReferences } from "./shared-photos";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const refs = new Map([
  ["p1", "PAF0001"],
  ["p2", "PAF0002"],
  ["p3", "PAF0003"],
]);

describe("which listings share a photograph (in memory, for the worklist)", () => {
  it("names the OTHER listing on both sides, by reference", () => {
    const out = sharedPhotoReferences(
      [
        { property_id: "p1", content_sha256: H1 },
        { property_id: "p2", content_sha256: H1 },
      ],
      refs,
    );
    expect(out.get("p1")).toEqual(["PAF0002"]);
    expect(out.get("p2")).toEqual(["PAF0001"]);
  });

  it("never names a listing to itself — two copies of one picture on one listing are not sharing", () => {
    const out = sharedPhotoReferences(
      [
        { property_id: "p1", content_sha256: H1 },
        { property_id: "p1", content_sha256: H1 },
      ],
      refs,
    );
    expect(out.size).toBe(0);
  });

  it("collects every other listing across every shared hash, sorted and once", () => {
    const out = sharedPhotoReferences(
      [
        { property_id: "p1", content_sha256: H1 },
        { property_id: "p3", content_sha256: H1 },
        { property_id: "p1", content_sha256: H2 },
        { property_id: "p2", content_sha256: H2 },
        { property_id: "p3", content_sha256: H2 },
      ],
      refs,
    );
    expect(out.get("p1")).toEqual(["PAF0002", "PAF0003"]);
    expect(out.get("p2")).toEqual(["PAF0001", "PAF0003"]);
    expect(out.get("p3")).toEqual(["PAF0001", "PAF0002"]);
  });

  it("ignores rows with no hash yet — a pre-0088 upload is unknown, not shared", () => {
    const out = sharedPhotoReferences(
      [
        { property_id: "p1", content_sha256: null },
        { property_id: "p2", content_sha256: null },
      ],
      refs,
    );
    expect(out.size).toBe(0);
  });
});

describe("the same question of the database, for one listing", () => {
  type Client = Parameters<typeof fetchSharedPhotoReferences>[0];

  it("asks nothing when the listing has no hashed photograph", async () => {
    const { client, served } = fakeClient({});
    expect(await fetchSharedPhotoReferences(client as unknown as Client, "p1", "org-1", [])).toEqual([]);
    expect(served.property_media).toBeUndefined();
  });

  it("answers the other listings' references, sorted and once each — the reference rides with each row", async () => {
    const { client, served } = fakeClient({
      property_media: [
        {
          data: [
            { id: "m1", listing: { reference: "PAF0003" } },
            { id: "m2", listing: { reference: "PAF0002" } },
            { id: "m3", listing: { reference: "PAF0003" } },
            // a listing the session cannot read embeds as null: not named
            { id: "m4", listing: null },
          ],
          error: null,
        },
      ],
    });
    expect(await fetchSharedPhotoReferences(client as unknown as Client, "p1", "org-1", [H1, H1])).toEqual([
      "PAF0002",
      "PAF0003",
    ]);
    expect(served.properties, "no second read by id").toBeUndefined();
  });

  /*
   * T-shared-photo-references: every hash in one URL, then every sharing
   * listing's id in another, answered 414 past about 122 hashes or 210
   * listings — the property page fell over and set-cover threw after its
   * write. The hashes now go out in bounded slices, each read paged.
   */
  it("asks about the hashes in bounded slices, each read paged — never one URL with all of them", async () => {
    const hashes = Array.from({ length: 95 }, (_, i) => i.toString(16).padStart(64, "0"));
    const { client, argsOf } = fakeClient({});
    await fetchSharedPhotoReferences(client as unknown as Client, "p1", "org-1", hashes);
    const slices = argsOf("property_media", "in").map((a) => a[1] as string[]);
    expect(slices.map((s) => s.length)).toEqual([40, 40, 15]);
    expect(slices.flat(), "every hash asked about, once").toEqual(hashes);
    expect(argsOf("property_media", "neq")).toEqual([["property_id", "p1"], ["property_id", "p1"], ["property_id", "p1"]]);
    // the property's org on every slice (the service role's only index-able predicate)
    expect(argsOf("property_media", "eq")).toEqual([["org_id", "org-1"], ["org_id", "org-1"], ["org_id", "org-1"]]);
    // fetchAll: ordered by id, from row 0, ending on the empty page
    expect(argsOf("property_media", "order")).toEqual([["id"], ["id"], ["id"]]);
    expect(argsOf("property_media", "range")).toEqual([[0, 999], [0, 999], [0, 999]]);
  });

  it("throws on a failed read rather than answering 'nobody'", async () => {
    const { client } = fakeClient({
      property_media: [{ data: null, error: { message: "boom" } }],
    });
    await expect(fetchSharedPhotoReferences(client as unknown as Client, "p1", "org-1", [H1])).rejects.toThrow(
      "Query failed (shared photographs): boom",
    );
  });
});
