import { describe, expect, it } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import {
  PROPOSAL_HISTORY_LIMIT,
  latestProposalBy,
  proposalsForContact,
  proposalsForProperty,
  type SentProposal,
} from "./proposals-sent";

/**
 * What was already proposed to whom (A04), read from the proposal links. The
 * properties these reads must keep: no id list in the URL (414 at ~197 ids,
 * T-worklist-id-lists), a UNIQUE order so the bounded page is the same page on
 * every read, a bound, and a failure that is "unavailable" — never `[]`, which
 * the page would draw as "not proposed".
 */

const CONTACT = "c0c0c0c0-1111-4111-8111-111111111111";
const PROPERTY = "a0a0a0a0-1111-4111-8111-111111111111";

const link = (over: Record<string, unknown> = {}) => ({
  id: "b0b0b0b0-1111-4111-8111-111111111111",
  contact_id: CONTACT,
  created_at: "2026-10-18T08:00:00+00:00",
  expires_at: "2026-11-01T08:00:00+00:00",
  revoked_at: null,
  view_count: 3,
  share_link_properties: [{ property_id: PROPERTY }],
  ...over,
});

const ok = (rows: unknown[]): FakePage => ({ data: rows, error: null });

describe.each([
  ["proposalsForContact", (c: never) => proposalsForContact(c, CONTACT)],
  ["proposalsForProperty", (c: never) => proposalsForProperty(c, PROPERTY)],
] as const)("%s", (_name, read) => {
  it("reads proposal links only, newest first by a unique order, bounded — and no id list", async () => {
    const fake = fakeClient({ share_links: [ok([link()])] });
    await read(fake.client as never);
    expect(fake.argsOf("share_links", "eq")).toContainEqual(["kind", "proposal"]);
    expect(fake.argsOf("share_links", "order")).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(fake.argsOf("share_links", "limit")).toEqual([[PROPOSAL_HISTORY_LIMIT]]);
    expect(fake.argsOf("share_links", "in"), "an id list is a 414 waiting to happen").toEqual([]);
    const [select] = fake.argsOf("share_links", "select")[0] as [string];
    expect(select, "the token's hash is never read").not.toMatch(/token/);
  });

  it("answers the proposals, with what each held and how often it was opened", async () => {
    const fake = fakeClient({ share_links: [ok([link()])] });
    expect(await read(fake.client as never)).toEqual({
      ok: true,
      capped: false,
      proposals: [
        {
          id: "b0b0b0b0-1111-4111-8111-111111111111",
          contactId: CONTACT,
          createdAt: "2026-10-18T08:00:00+00:00",
          expiresAt: "2026-11-01T08:00:00+00:00",
          revokedAt: null,
          viewCount: 3,
          propertyIds: [PROPERTY],
        },
      ],
    });
  });

  it("a failed read, a read with no rows array, or a row with no curation array is UNAVAILABLE — never none", async () => {
    for (const page of [
      { data: null, error: { message: "upstream timeout" } },
      { data: null, error: null, status: 204 },
      ok([link({ share_link_properties: null })]),
      ok([link({ contact_id: null })]),
    ] as FakePage[]) {
      const fake = fakeClient({ share_links: [page] });
      expect(await read(fake.client as never)).toEqual({ ok: false });
    }
  });

  it("an empty answer is genuinely none", async () => {
    const fake = fakeClient({ share_links: [ok([])] });
    expect(await read(fake.client as never)).toEqual({ ok: true, proposals: [], capped: false });
  });

  it("a full page says it is capped, so an older proposal past it is not read as none", async () => {
    const rows = Array.from({ length: PROPOSAL_HISTORY_LIMIT }, (_, i) => link({ id: `b${i}` }));
    const fake = fakeClient({ share_links: [ok(rows)] });
    expect(await read(fake.client as never)).toMatchObject({ ok: true, capped: true });
  });
});

describe("the two directions filter by their own key", () => {
  it("the contact side: this buyer's links, every listing each held", async () => {
    const fake = fakeClient({ share_links: [ok([])] });
    await proposalsForContact(fake.client as never, CONTACT);
    expect(fake.argsOf("share_links", "eq")).toEqual([
      ["kind", "proposal"],
      ["contact_id", CONTACT],
    ]);
    expect(fake.argsOf("share_links", "select")[0]![0]).toMatch(/share_link_properties\(property_id\)/);
  });

  it("the property side: buyer-bound links holding this listing — an inner embed, filtered by the listing", async () => {
    const fake = fakeClient({ share_links: [ok([])] });
    await proposalsForProperty(fake.client as never, PROPERTY);
    expect(fake.argsOf("share_links", "select")[0]![0]).toMatch(/share_link_properties!inner\(property_id\)/);
    expect(fake.argsOf("share_links", "eq")).toEqual([
      ["kind", "proposal"],
      ["share_link_properties.property_id", PROPERTY],
    ]);
    expect(fake.argsOf("share_links", "not"), "an unbound link names no buyer").toEqual([["contact_id", "is", null]]);
  });
});

describe("latestProposalBy", () => {
  const p = (id: string, contactId: string, createdAt: string, propertyIds: string[]): SentProposal => ({
    id,
    contactId,
    createdAt,
    expiresAt: "2026-12-01T00:00:00Z",
    revokedAt: null,
    viewCount: 0,
    propertyIds,
  });

  it("keeps the FIRST seen per key — the reads are newest first", () => {
    const newest = p("l2", "c1", "2026-10-18T00:00:00Z", ["p1", "p2"]);
    const older = p("l1", "c1", "2026-10-01T00:00:00Z", ["p1", "p3"]);
    const byProperty = latestProposalBy([newest, older], "property");
    expect(byProperty.get("p1")?.id).toBe("l2");
    expect(byProperty.get("p3")?.id).toBe("l1");
    expect(byProperty.has("p9")).toBe(false);
    const byContact = latestProposalBy([newest, older, p("l0", "c2", "2026-09-01T00:00:00Z", ["p1"])], "contact");
    expect(byContact.get("c1")?.id).toBe("l2");
    expect(byContact.get("c2")?.id).toBe("l0");
  });
});
