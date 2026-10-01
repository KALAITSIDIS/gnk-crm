import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeClient } from "@/lib/testing/fake-client";

/**
 * A list export records WHICH filters shaped it, never what was typed into
 * them (BACKLOG "Four list exports write the raw URL query string into the
 * chain", T-export-filter-shape).
 *
 * The contacts, keys, leads and properties routes handed `logListExport` the
 * request's raw search params. The search box matches a contact's name, phone
 * and e-mail and a key's holder, so a name searched and then exported went
 * into an `exported` event — append-only and beyond erasure. These tests
 * drive the REAL route handlers with a request that searches for a person
 * and carries a junk parameter, and read the payload the handler actually
 * hands to `logEvent` — whatever code put it there.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "user-1", orgId: "org-1", role: "admin", fullName: "Admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));

const PERSON = "Maria Georgiou";
const AGENT = "11111111-2222-4333-8444-555555555555";
const DISTRICT = "66666666-7777-4888-8999-aaaaaaaaaaaa";

beforeEach(() => {
  state.client = fakeClient({}).client; // every read answers an empty, error-free page
  logEvent.mockClear();
});

async function exportOf(route: string, query: Record<string, string>) {
  const mod = (await import(`@/app/(app)/${route}/export/route`)) as {
    GET: (r: NextRequest) => Promise<Response>;
  };
  logEvent.mockClear(); // one export, one event — read in isolation
  const url = new URL(`http://localhost/${route}/export`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await mod.GET(new NextRequest(url));
  expect(res.status).toBe(200);
  expect(logEvent).toHaveBeenCalledTimes(1);
  const event = logEvent.mock.calls[0]![1];
  expect(event).toMatchObject({ entityType: "export", eventType: "exported" });
  return event.payload as { list: string; count: number; filters?: Record<string, unknown> };
}

/** Nothing anyone typed may reach the chain — in any key, at any depth. */
function expectNoTypedText(payload: unknown) {
  const text = JSON.stringify(payload);
  for (const typed of ["Maria", "Georgiou", "Forged"]) expect(text, `"${typed}" reached the chain`).not.toContain(typed);
}

describe("each export records the shape of its filters, never their text", () => {
  it("contacts: vetted values kept; the search, a free-text nationality and an off-vocabulary source become 'used'", async () => {
    const payload = await exportOf("contacts", {
      q: PERSON,
      type: "buyer",
      temperature: "hot",
      source: "Maria", // crafted: not a lead source
      agent: AGENT,
      nationality: "Georgiou", // a free-text input in the filter bar
      language: "el",
      archived: "1",
      junk: "Forged",
    });
    expectNoTypedText(payload);
    expect(payload.filters).toEqual({
      q: true,
      type: "buyer",
      temperature: "hot",
      source: true,
      agent: AGENT,
      nationality: true,
      language: "el",
      archived: true,
    });
  });

  it("contacts: an off-vocabulary type, temperature, language or a malformed agent id are recorded only as used", async () => {
    const payload = await exportOf("contacts", {
      type: "Maria",
      temperature: "Georgiou",
      language: "Forged",
      agent: "Maria Georgiou",
    });
    expectNoTypedText(payload);
    expect(payload.filters).toEqual({ type: true, temperature: true, language: true, agent: true });
  });

  it("keys: the holder search becomes 'used'; the status scope is kept", async () => {
    const payload = await exportOf("keys", { q: PERSON, status: "checked_out", junk: "Forged" });
    expectNoTypedText(payload);
    expect(payload.filters).toEqual({ q: true, status: "checked_out" });
  });

  it("leads: only the status scope — a parameter the list does not read is not recorded at all", async () => {
    const payload = await exportOf("leads", { status: "closed", q: PERSON, junk: "Forged" });
    expectNoTypedText(payload);
    expect(payload.filters).toEqual({ status: "closed" });
  });

  it("properties: the search becomes 'used'; vetted filters kept; view and page are not filters", async () => {
    const payload = await exportOf("properties", {
      q: PERSON,
      district: DISTRICT,
      type: "apartment",
      status: "available",
      beds: "2",
      price_min: "100000",
      scope: "all",
      view: "cards",
      page: "3",
      junk: "Forged",
    });
    expectNoTypedText(payload);
    expect(payload.filters).toEqual({
      q: true,
      district: DISTRICT,
      type: "apartment",
      status: "available",
      beds: 2,
      price_min: 100000,
      scope: "all",
    });
  });

  it("an export with no filters still records the list's default scope, and nothing else", async () => {
    expect((await exportOf("keys", {})).filters).toEqual({ status: "all" });
    expect((await exportOf("leads", {})).filters).toEqual({ status: "open" });
    expect((await exportOf("contacts", {})).filters).toBeUndefined();
  });
});
