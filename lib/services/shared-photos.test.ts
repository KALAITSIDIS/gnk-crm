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
    expect(await fetchSharedPhotoReferences(client as unknown as Client, "p1", [])).toEqual([]);
    expect(served.property_media).toBeUndefined();
  });

  it("answers the other listings' references, sorted", async () => {
    const { client } = fakeClient({
      property_media: [{ data: [{ property_id: "p3" }, { property_id: "p2" }, { property_id: "p3" }], error: null }],
      properties: [{ data: [{ reference: "PAF0003" }, { reference: "PAF0002" }], error: null }],
    });
    expect(await fetchSharedPhotoReferences(client as unknown as Client, "p1", [H1, H1])).toEqual([
      "PAF0002",
      "PAF0003",
    ]);
  });

  it("throws on a failed read rather than answering 'nobody'", async () => {
    const { client } = fakeClient({
      property_media: [{ data: null, error: { message: "boom" } }],
    });
    await expect(fetchSharedPhotoReferences(client as unknown as Client, "p1", [H1])).rejects.toThrow(
      "Query failed (shared photographs): boom",
    );
  });
});
