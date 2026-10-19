import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * The calculators opened on a property (F01). The Costs link now carries
 * `property=<id>`; the page reads that row through the viewer's own client
 * and opens on the scenario its stored VAT status implies. These tests render
 * the REAL server component (and the client component's first paint) with
 * each answer the read can give, and read the markup.
 *
 * The rule under test: the context is a convenience, never a gate. A hidden
 * or missing row is the bare calculator (no 404, and nothing that says the
 * row exists); a failed read is the bare calculator plus one line saying the
 * scenario shown is the default; a malformed id is never queried.
 */

const state = vi.hoisted(() => ({ pages: {} as Record<string, FakePage[]> }));
const fake = vi.hoisted(() => ({ current: null as ReturnType<typeof fakeClient> | null }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    fake.current = fakeClient(state.pages);
    return fake.current.client;
  },
}));

const ID = "11111111-2222-3333-4444-555555555555";

const CONFIG_ROWS = [
  {
    key: "transfer_fees",
    value: {
      bands: [
        { up_to: 85000, rate: 0.03 },
        { up_to: 170000, rate: 0.05 },
        { up_to: null, rate: 0.08 },
      ],
      relief_pct: 0.5,
      vat_paid_exempt: true,
      vat_paid_note: "No transfer fees when the transaction was subject to VAT",
    },
    verified_at: "2026-07-22",
  },
  {
    key: "stamp_duty",
    value: {
      bands: [
        { up_to: 5000, rate: 0 },
        { up_to: 170000, rate: 0.0015 },
        { up_to: null, rate: 0.002 },
      ],
      cap: 20000,
      abolished: { from: "2026-01-01", law: "Law 239(I)/2025" },
    },
    verified_at: "2026-07-22",
  },
];

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  reference: "PAF0099",
  kind: "standalone",
  property_type: "land",
  vat_status: "unknown",
  ...over,
});

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.pages = { cyprus_config: [{ data: CONFIG_ROWS, error: null }] };
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

async function render(query: Record<string, string | string[]>, property?: FakePage) {
  if (property) state.pages.properties = [property];
  const { default: Page } = await import("@/app/(app)/calculators/page");
  const el = (await Page({ searchParams: Promise.resolve(query) })) as ReactElement;
  return renderToStaticMarkup(el);
}

/** which scenario radio is checked, read from the markup */
function checkedScenario(html: string): string | null {
  const radios = html.match(/<input[^>]*name="vat-scenario"[^>]*>/g) ?? [];
  const checked = radios.filter((r) => /checked=""/.test(r));
  expect(checked, "exactly one scenario is chosen").toHaveLength(1);
  return checked[0].match(/value="([a-z_]+)"/)?.[1] ?? null;
}

describe("/calculators — bare, as before F01", () => {
  it("never reads a property, and opens on 'not subject to VAT' at today's figure", async () => {
    const html = await render({ price: "300000" });
    expect(fake.current!.served.properties).toBeUndefined();
    expect(checkedScenario(html)).toBe("does_not_apply");
    // the €8,600 pin, on the client component's first paint
    expect(html).toContain("€8.600");
    expect(html).not.toContain("VAT status:");
    expect(html).not.toContain("could not be read");
    // the config's own wording sits under the choice
    expect(html).toContain("No transfer fees when the transaction was subject to VAT.");
  });

  it("the €3,400 pin at €170,000 holds", async () => {
    const html = await render({ price: "170000" });
    expect(html).toContain("€3.400");
  });
});

describe("/calculators?property= — opened on a listing", () => {
  it("unknown land: names the listing, opens on 'Not confirmed', shows both branches", async () => {
    const html = await render({ price: "200000", property: ID }, { data: row(), error: null });

    // the read: one row, by id, through the viewer's client
    expect(fake.current!.argsOf("properties", "eq")).toEqual([["id", ID]]);
    expect(fake.current!.argsOf("properties", "maybeSingle")).toHaveLength(1);
    const cols = String(fake.current!.argsOf("properties", "select")[0][0]);
    // only what the strip needs — no price, no owner net, no notes
    expect(cols).toBe("id, reference, kind, property_type, vat_status");

    expect(html).toContain(`href="/properties/${ID}?tab=details"`);
    expect(html).toContain("PAF0099");
    expect(html).toContain("· land · VAT status: Unknown (not confirmed)");
    expect(checkedScenario(html)).toBe("unconfirmed");
    expect(html).toContain("VAT status not confirmed — confirm before quoting.");
    expect(html).toContain("If the sale is subject to VAT, no transfer fees are payable.");
    expect(html).toContain("If not subject to VAT");
    expect(html).toContain("Total (if not subject to VAT)");
    // 9,200 gross at €200,000, halved by the relief that stays live
    expect(html).toContain("€4.600");
  });

  it("a new build opens on 'Subject to VAT' with the nil assessment and a way back", async () => {
    const html = await render(
      { price: "300000", property: ID },
      { data: row({ property_type: "apartment", vat_status: "new_vat" }), error: null },
    );
    expect(checkedScenario(html)).toBe("applies");
    expect(html).toContain("VAT status: New (VAT applies)");
    expect(html).toContain("No transfer fees — the transaction is subject to VAT.");
    expect(html).toContain("VAT applies instead — see the property");
    // relief cannot move a nil figure: disabled, not reset (UX-4)
    expect(html).toContain("No relief to apply");
  });

  it("a resale opens on 'Not subject to VAT' at the same figure as the bare page", async () => {
    const html = await render(
      { price: "300000", property: ID },
      { data: row({ property_type: "villa", vat_status: "resale_no_vat" }), error: null },
    );
    expect(checkedScenario(html)).toBe("does_not_apply");
    expect(html).toContain("VAT status: Resale (no VAT)");
    expect(html).toContain("€8.600");
  });

  it("a development names its kind as well as its type", async () => {
    const html = await render(
      { property: ID },
      { data: row({ kind: "project", property_type: "mixed_use", vat_status: "new_vat" }), error: null },
    );
    expect(html).toContain("· project · mixed use · VAT status: New (VAT applies)");
  });

  it("a row the viewer cannot see is the bare calculator — no 404, nothing said about it", async () => {
    const html = await render({ price: "300000", property: ID }, { data: null, error: null });
    expect(fake.current!.served.properties).toBe(1);
    expect(checkedScenario(html)).toBe("does_not_apply");
    expect(html).not.toContain("VAT status:");
    expect(html).not.toContain("could not be read");
    expect(html).toContain("€8.600");
  });

  it("a failed read is the bare calculator plus a line saying the scenario is the default", async () => {
    const html = await render(
      { price: "300000", property: ID },
      { data: null, error: { message: "boom", code: "08006" } },
    );
    expect(checkedScenario(html)).toBe("does_not_apply");
    expect(html).not.toContain("VAT status:");
    expect(html).toContain("could not be read");
    expect(html).toContain("the VAT scenario below is the default");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("a malformed id is never queried", async () => {
    for (const property of ["not-a-uuid", "", "1; drop table properties"]) {
      const html = await render({ price: "300000", property });
      expect(fake.current!.served.properties, property).toBeUndefined();
      expect(checkedScenario(html)).toBe("does_not_apply");
    }
  });

  it("a repeated param: the first value wins", async () => {
    const html = await render(
      { price: ["170000", "999"], property: [ID, "22222222-2222-2222-2222-222222222222"] },
      { data: row(), error: null },
    );
    expect(fake.current!.argsOf("properties", "eq")).toEqual([["id", ID]]);
    expect(html).toContain('value="170000"');
  });
});
