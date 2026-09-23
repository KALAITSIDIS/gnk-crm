import { describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";

/**
 * A merge writes ids and shape into the chain, never the people it merged
 * (audit SEC-03, DECISIONS T-merged-event-ids-only).
 *
 * Until 2026-09-23 the `merged` event carried the duplicate's display name and,
 * whenever the two records held different e-mails, the duplicate's address
 * under `dropped`. Events are hash-chained and never updated, and erasure
 * leaves them alone by design, so both outlived any request to remove them.
 * The static scan (event-payload-privacy.test.ts) could not see the address:
 * it arrived as the VALUE of a shorthand property built in another module. So
 * this drives the real action and searches everything it logged for the
 * fixtures' own values — whatever syntax put them there.
 */

const state = vi.hoisted(() => ({ caller: null as unknown, admin: null as unknown }));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.caller }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.admin }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "admin-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { mergeContacts } = await import("@/lib/actions/merge-contacts");

const base = {
  org_id: "org-1",
  contact_kind: "person",
  company_name: null,
  phone_raw: null,
  additional_phones: [],
  telegram_username: null,
  has_whatsapp: false,
  languages: ["en"],
  nationality: null,
  contact_types: [],
  temperature: "warm",
  source: null,
  source_detail: null,
  assigned_agent_id: null,
  preferred_channel: null,
  psychology: null,
  kyc: {},
  banking_readiness: {},
  consent_marketing: false,
  consent_at: null,
  gdpr_notes: null,
  notes: null,
  is_archived: false,
  merged_into_id: null,
};

const primary = {
  ...base,
  id: "pri-1",
  first_name: "Maria",
  last_name: "Testides",
  display_name: "Maria Testides",
  phone_e164: "+35799111222",
  email: "maria@primary.example",
};

/** Everything about this person is distinctive, so a leak of any of it shows. */
function duplicate(overrides: Record<string, unknown> = {}) {
  return {
    ...base,
    id: "dup-1",
    first_name: "Mariou",
    last_name: "Duplikatou",
    display_name: "Mariou Duplikatou",
    phone_e164: "+35799333444",
    email: "mariou@duplicate.example",
    ...overrides,
  };
}

async function merge(dup: Record<string, unknown>) {
  logEvent.mockClear();
  state.admin = fakeClient({
    // the two reads (primary, then duplicate), the archive, the merged_into
    // repoint, the backfill — the rest default to an empty, error-free page
    contacts: [
      { data: primary, error: null },
      { data: dup, error: null },
    ],
  }).client;
  state.caller = fakeClient({}).client;
  const form = new FormData();
  form.set("primary_id", "pri-1");
  form.set("duplicate_id", "dup-1");
  const res = await mergeContacts({ error: null, mergedAt: null }, form);
  expect(res.error).toBeNull();
  const events = logEvent.mock.calls.map((c) => c[1]);
  return {
    events,
    merged: events.find((e) => e.eventType === "merged"),
    archived: events.find((e) => e.eventType === "archived"),
  };
}

const identifying = (d: Record<string, unknown>) =>
  [primary, d].flatMap((c) => [
    c.first_name,
    c.last_name,
    c.display_name,
    c.phone_e164,
    c.email,
  ]) as string[];

describe("mergeContacts writes ids and shape into the chain", () => {
  it("carries the duplicate's id and WHICH field was not kept — never its value", async () => {
    // both hold an e-mail and they differ: the backfill keeps the primary's
    const dup = duplicate();
    const { merged } = await merge(dup);
    expect(merged?.payload).toEqual({ merged_contact_id: "dup-1", dropped_fields: ["email"] });
  });

  it("says nothing was dropped when nothing conflicted — the shape is constant", async () => {
    const { merged } = await merge(duplicate({ email: null }));
    expect(merged?.payload).toEqual({ merged_contact_id: "dup-1", dropped_fields: [] });
  });

  it("puts no name, e-mail or phone of either person in ANY event it logs", async () => {
    const dup = duplicate();
    const { events } = await merge(dup);
    expect(events).toHaveLength(2);
    const logged = JSON.stringify(events.map((e) => e.payload));
    const leaked = identifying(dup).filter((v) => logged.includes(v));
    expect(leaked, "a client's data reached the hash chain").toEqual([]);
  });

  it("leaves the duplicate's archive event as it was — the surviving id only", async () => {
    const { archived } = await merge(duplicate());
    expect(archived).toMatchObject({ entityId: "dup-1", payload: { merged_into: "pri-1" } });
  });
});
