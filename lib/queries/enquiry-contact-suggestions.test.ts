import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import { LEAD_MESSAGE_REDACTED } from "@/lib/services/erasure";
import { SUGGESTION_HISTORY_LIMIT, SUGGESTION_LOOKUP_LIMIT } from "@/lib/services/enquiry-contact-match";
import { loadEnquiryContactSuggestions } from "./enquiry-contact-suggestions";

/**
 * The page-level lookup behind "Possible existing contact"
 * (T-enquiry-contact-suggestions): how many queries it makes, what it asks
 * for, and how an answer — or a failure — becomes each row's state. What the
 * database then RETURNS under real RLS, per role and per organisation, is
 * proven in supabase/tests/enquiry-contact-suggestions.test.ts.
 */
const header = (email: string | null, phone: string | null) =>
  ["Website enquiry", "Name: Visitor", email ? `Email: ${email}` : null, phone ? `Phone: ${phone}` : null, "", "Hi"]
    .filter((l) => l !== null)
    .join("\n");

const as = (client: unknown) => client as SupabaseClient<Database>;

function setup(pages: FakePage[]) {
  const fake = fakeClient({ contacts: pages });
  return fake;
}

const row = (over: Record<string, unknown>) => ({
  id: "c-x",
  display_name: "X",
  email: null,
  phone_e164: null,
  additional_phones: [],
  leads: [],
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe("loadEnquiryContactSuggestions", () => {
  it("makes no query when nothing on the page can be matched, and says why for each row", async () => {
    const fake = setup([]);
    const states = await loadEnquiryContactSuggestions(as(fake.client), [
      { id: "redacted", message: LEAD_MESSAGE_REDACTED },
      { id: "no-ids", message: header(null, "12345") },
    ]);
    expect(fake.calls).toEqual([]);
    expect(states.get("redacted")).toEqual({ status: "unreadable" });
    expect(states.get("no-ids")).toEqual({ status: "no_identifiers" });
  });

  it("asks ONCE for the whole page — active, unerased contacts, bounded history, bounded rows", async () => {
    const fake = setup([{ data: [], error: null }]);
    await loadEnquiryContactSuggestions(as(fake.client), [
      { id: "a", message: header("Anna@Example.invalid", "+357 99 111111") },
      { id: "b", message: header("bob@example.invalid", null) },
      { id: "c", message: header(null, "0035799222222") },
    ]);
    expect(fake.served.contacts).toBe(1);
    expect(fake.argsOf("contacts", "eq")).toContainEqual(["is_archived", false]);
    expect(fake.argsOf("contacts", "is")).toContainEqual(["erased_at", null]);
    expect(fake.argsOf("contacts", "or")).toEqual([
      [
        'email.in.("anna@example.invalid","bob@example.invalid"),' +
          'phone_e164.in.("+35799111111","+35799222222"),' +
          'additional_phones.ov.{"+35799111111","+35799222222"}',
      ],
    ]);
    expect(fake.argsOf("contacts", "order")).toEqual([
      ["received_at", { referencedTable: "leads", ascending: false }],
      ["id", { referencedTable: "leads", ascending: false }],
      ["id"],
    ]);
    expect(fake.argsOf("contacts", "limit")).toEqual([
      [SUGGESTION_HISTORY_LIMIT + 1, { referencedTable: "leads" }],
      [SUGGESTION_LOOKUP_LIMIT + 1],
    ]);
    const [select] = fake.argsOf("contacts", "select")[0]! as [string];
    // the embedded history never carries an earlier enquiry's message
    expect(select).not.toMatch(/message/);
    expect(select).toMatch(/leads!leads_contact_id_fkey\(id, received_at, status, assigned_agent_id, properties\(id, reference\)\)/);
  });

  it("gives each row ONLY its own matches, with history mapped and bounded", async () => {
    const fake = setup([
      {
        data: [
          row({
            id: "c-anna",
            display_name: "Anna A",
            email: "anna@example.invalid",
            leads: [
              { id: "l1", received_at: "2026-09-20T09:00:00Z", status: "contacted", assigned_agent_id: "agent-1", properties: { id: "p1", reference: "PAF0003" } },
              { id: "l2", received_at: "2026-09-01T09:00:00Z", status: "converted", assigned_agent_id: null, properties: null },
            ],
          }),
          row({ id: "c-bob", display_name: "Bob B", phone_e164: "+35799222222" }),
        ],
        error: null,
      },
    ]);
    const states = await loadEnquiryContactSuggestions(as(fake.client), [
      { id: "a", message: header("anna@example.invalid", null) },
      { id: "b", message: header(null, "99 222 222") },
      { id: "n", message: header("nobody@example.invalid", null) },
    ]);
    const a = states.get("a");
    expect(a?.status).toBe("matches");
    if (a?.status !== "matches") throw new Error("unreachable");
    expect(a.candidates.map((c) => c.contact.name)).toEqual(["Anna A"]);
    expect(a.candidates[0]!.history).toEqual([
      { id: "l1", received_at: "2026-09-20T09:00:00Z", status: "contacted", assigned_agent_id: "agent-1", property: { id: "p1", reference: "PAF0003" } },
      { id: "l2", received_at: "2026-09-01T09:00:00Z", status: "converted", assigned_agent_id: null, property: null },
    ]);
    const b = states.get("b");
    expect(b?.status === "matches" && b.candidates.map((c) => c.contact.name)).toEqual(["Bob B"]);
    expect(states.get("n")).toEqual({ status: "no_match", keys: { email: "nobody@example.invalid", phoneE164: null } });
  });

  it("shows both contacts when the phone and the e-mail point at different people", async () => {
    const fake = setup([
      {
        data: [
          row({ id: "c-a", display_name: "Maria G", phone_e164: "+35799123456" }),
          row({ id: "c-b", display_name: "Maria P", email: "maria@example.invalid" }),
        ],
        error: null,
      },
    ]);
    const states = await loadEnquiryContactSuggestions(as(fake.client), [
      { id: "x", message: header("maria@example.invalid", "+357 99 123456") },
    ]);
    const x = states.get("x");
    if (x?.status !== "matches") throw new Error(`expected matches, got ${x?.status}`);
    expect(x.candidates.map((c) => [c.contact.name, c.matchedOn])).toEqual([
      ["Maria P", "email"],
      ["Maria G", "phone"],
    ]);
    expect(x.split).toEqual({ emailMatches: ["Maria P"], phoneMatches: ["Maria G"] });
  });

  it("reports a failed lookup as UNAVAILABLE — never as no match — and logs no address", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = setup([{ data: null, error: { message: 'bad filter "anna@example.invalid"', code: "PGRST100" } }]);
    const states = await loadEnquiryContactSuggestions(as(fake.client), [
      { id: "a", message: header("anna@example.invalid", null) },
      { id: "r", message: LEAD_MESSAGE_REDACTED },
    ]);
    expect(states.get("a")).toEqual({ status: "unavailable" });
    expect(states.get("r")).toEqual({ status: "unreadable" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("PGRST100");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/anna|example\.invalid/);
  });

  it("reports a thrown lookup as unavailable too — the inbox never fails over it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const client = { from: () => { throw new Error("socket closed"); } };
    const states = await loadEnquiryContactSuggestions(as(client), [{ id: "a", message: header("a@example.invalid", null) }]);
    expect(states.get("a")).toEqual({ status: "unavailable" });
  });

  it("will not show a silently partial answer past the page bound", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const many = Array.from({ length: SUGGESTION_LOOKUP_LIMIT + 1 }, (_, i) =>
      row({ id: `c${i}`, additional_phones: ["+35799123456"] }),
    );
    const fake = setup([{ data: many, error: null }]);
    const states = await loadEnquiryContactSuggestions(as(fake.client), [{ id: "a", message: header(null, "99123456") }]);
    expect(states.get("a")).toEqual({ status: "unavailable" });
  });
});
