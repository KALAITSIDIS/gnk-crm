import { describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";

/**
 * The ⌘K palette and the entity pickers must not offer retired records.
 *
 * On 2026-09-13 typing "PAF00" into the palette listed PAF0005-V04 and
 * PAF0005-V05 — archived on 4 September with the invented data the archive
 * was for — labelled "available", because the property branch filtered on
 * nothing and the sublabel prints status, not visibility. A person picking
 * one lands on a retired record; a viewing or a hold could be booked against
 * it. The contact branch already excluded archived rows; this makes the
 * property branch say the same (audit CRM-07).
 */
const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));

const { searchEntities } = await import("./entity-search");

function propertyRow(reference: string, status = "available") {
  return { id: `id-${reference}`, reference, title: { en: `Title ${reference}` }, status };
}

describe("searchEntities('property')", () => {
  it("asks the database for live listings only: not archived, not withdrawn", async () => {
    const fake = fakeClient({ properties: [{ data: [propertyRow("PAF0001")], error: null }] });
    state.client = fake.client;
    await searchEntities("property", "PAF00");
    const filters = fake.calls
      .filter((c) => c.table === "properties" && (c.method === "neq" || c.method === "eq"))
      .map((c) => `${c.method}(${c.args.join(",")})`);
    expect(filters).toContain("neq(visibility,archived)");
    expect(filters).toContain("neq(status,withdrawn)");
  });

  it("still labels a hit with its reference and status", async () => {
    const fake = fakeClient({ properties: [{ data: [propertyRow("PAF0001", "reserved")], error: null }] });
    state.client = fake.client;
    const out = await searchEntities("property", "PAF00");
    expect(out).toEqual([{ id: "id-PAF0001", label: "Title PAF0001", sublabel: "PAF0001 · reserved" }]);
  });
});

describe("searchEntities('contact')", () => {
  it("keeps excluding archived contacts (the rule the property branch now shares)", async () => {
    const fake = fakeClient({ contacts: [{ data: [], error: null }] });
    state.client = fake.client;
    await searchEntities("contact", "andreas");
    const eqs = fake.calls.filter((c) => c.table === "contacts" && c.method === "eq").map((c) => c.args.join(","));
    expect(eqs).toContain("is_archived,false");
  });
});
