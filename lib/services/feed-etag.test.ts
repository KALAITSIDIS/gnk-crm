import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { feedEtag } from "./feed-etag";

const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

describe("feedEtag", () => {
  it("is weak, names the snapshot verbatim, and digests the body", () => {
    const body = '{"org":"gnk","count":0,"limit":50,"offset":0,"listings":[]}';
    expect(feedEtag("abc123", body)).toBe('W/"abc123-' + digest(body) + '"');
  });

  it("is a function of its inputs and nothing else", () => {
    expect(feedEtag("s", "b")).toBe(feedEtag("s", "b"));
  });

  it("moves with the body even when the snapshot does not", () => {
    // The whole reason it exists: 0086 and T-deferred-sweep each found a
    // change to the feed that the SQL-side snapshot could not see.
    const a = feedEtag("same", '{"area":"Limassol"}');
    const b = feedEtag("same", '{"area":"Agios Tychonas"}');
    expect(a).not.toBe(b);
    expect(a.split("-")[0]).toBe(b.split("-")[0]);
  });

  it("moves with the snapshot even when the body does not (the site reads that segment)", () => {
    expect(feedEtag("one", "b")).not.toBe(feedEtag("two", "b"));
  });
});
