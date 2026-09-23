import { describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * `unarchiveContact` refuses an ERASED contact (T-refuse-unarchive-erased).
 *
 * GDPR erasure (lib/services/erasure.ts) keeps the name, e-mail and phone —
 * identity is retained for AML — and parks the row as archived. Unarchiving it
 * put that retained identity back into use: it re-took the phone/e-mail slot
 * under the partial unique indexes (`contacts_phone_unique`,
 * `contacts_email_unique`, both `where is_archived = false`), came back into
 * the duplicate check and the contact picker, and made "Possible existing
 * contact" say "no match" while Create contact was refused as a duplicate.
 *
 * These tests pin the action: the refusal before any write, the write that
 * cannot land on a contact erased between the read and the UPDATE, and that
 * an event is written for an unarchive that happened and for nothing else.
 */

const state = vi.hoisted(() => ({
  client: null as unknown,
  profile: { id: "actor-1", orgId: "org-1", role: "admin" as string },
}));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({ getCurrentProfile: async () => state.profile }));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath }));

const { unarchiveContact } = await import("@/lib/actions/contacts");

const CONTACT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ERASED_AT = "2026-09-01T08:00:00Z";

const ERASED_SENTENCE = "This contact's personal data was erased under GDPR Article 17 — it stays archived.";
const MERGED_SENTENCE = "This contact was merged into another — it stays archived.";
const PERMISSION_SENTENCE = "You don't have permission to unarchive this contact.";

const contact = (over: Record<string, unknown> = {}) => ({
  id: CONTACT,
  is_archived: true,
  merged_into_id: null,
  erased_at: null,
  ...over,
});

function setup(contacts: FakePage[]) {
  const fake = fakeClient({ contacts });
  state.client = fake.client;
  logEvent.mockClear();
  revalidatePath.mockClear();
  return fake;
}

const updates = (fake: ReturnType<typeof fakeClient>) => fake.argsOf("contacts", "update");

describe("unarchiveContact — an erased contact stays archived", () => {
  it("refuses an erased contact with a sentence — no write, no event", async () => {
    const fake = setup([{ data: contact({ erased_at: ERASED_AT }), error: null }]);
    const r = await unarchiveContact(CONTACT);
    expect(r.error).toBe(
      "This contact's personal data was erased under GDPR Article 17 — it stays archived.",
    );
    expect(updates(fake), "the refusal comes before the UPDATE").toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reads erased_at — the refusal cannot rest on a column the read never asked for", async () => {
    const fake = setup([{ data: contact({ erased_at: ERASED_AT }), error: null }]);
    await unarchiveContact(CONTACT);
    const [columns] = fake.argsOf("contacts", "select")[0] as [string];
    expect(columns.split(",").map((c) => c.trim())).toContain("erased_at");
  });

  it("names the ERASURE when an erased contact was also merged — the erased refusal comes first", async () => {
    const fake = setup([{ data: contact({ erased_at: ERASED_AT, merged_into_id: OTHER }), error: null }]);
    expect((await unarchiveContact(CONTACT)).error).toBe(ERASED_SENTENCE);
    expect(updates(fake)).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });
});

/**
 * The builder calls of the UPDATE's own chain — from `update(...)` to the
 * `select(...)` that closes it — so a condition is proven to be ON THE WRITE,
 * not on the read or the re-read around it (the fake client records every
 * chain on a table into one list).
 */
function updateChain(fake: ReturnType<typeof fakeClient>) {
  const calls = fake.calls.filter((c) => c.table === "contacts");
  const start = calls.findIndex((c) => c.method === "update");
  const end = calls.findIndex((c, i) => i > start && c.method === "select");
  expect(start, "an UPDATE was issued").toBeGreaterThanOrEqual(0);
  return calls.slice(start, end + 1);
}

describe("unarchiveContact — the write", () => {
  it("unarchives only while the row is still archived, not erased and not merged", async () => {
    const fake = setup([
      { data: contact(), error: null },
      { data: [{ id: CONTACT }], error: null },
    ]);
    expect(await unarchiveContact(CONTACT)).toEqual({ error: null });
    expect(updates(fake)).toEqual([[{ is_archived: false }]]);
    const write = updateChain(fake).map((c) => [c.method, ...c.args]);
    expect(write).toContainEqual(["eq", "id", CONTACT]);
    expect(write).toContainEqual(["eq", "is_archived", true]);
    // an erasure, or a merge, landing between the read and this UPDATE must not be undone
    expect(write).toContainEqual(["is", "erased_at", null]);
    expect(write).toContainEqual(["is", "merged_into_id", null]);
  });

  it("writes exactly one unarchived event for the unarchive it made", async () => {
    setup([
      { data: contact(), error: null },
      { data: [{ id: CONTACT }], error: null },
    ]);
    await unarchiveContact(CONTACT);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]![1]).toMatchObject({
      entityType: "contact",
      entityId: CONTACT,
      eventType: "unarchived",
      payload: {},
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/contacts/${CONTACT}`);
  });

  /** read: archived, nothing else · the conditional UPDATE: zero rows · then the re-read */
  const zeroRowsThen = (reread: FakePage) =>
    setup([{ data: contact(), error: null }, { data: [], error: null }, reread]);

  it("re-reads every column its answer rests on — a missing one would read as 'unarchived meanwhile'", async () => {
    const fake = zeroRowsThen({ data: contact(), error: null });
    await unarchiveContact(CONTACT);
    const selects = fake.argsOf("contacts", "select");
    expect(selects, "read, UPDATE's returning, re-read").toHaveLength(3);
    const [columns] = selects[2] as [string];
    expect(columns.split(",").map((c) => c.trim())).toEqual(
      expect.arrayContaining(["is_archived", "merged_into_id", "erased_at"]),
    );
  });

  it.each([
    ["erased meanwhile", contact({ erased_at: ERASED_AT }), ERASED_SENTENCE],
    ["merged meanwhile", contact({ merged_into_id: OTHER }), MERGED_SENTENCE],
    ["still archived — the row policy refused it", contact(), PERMISSION_SENTENCE],
    ["no longer visible", null, PERMISSION_SENTENCE],
  ])("zero rows, %s: says why — and writes no event", async (_label, row, sentence) => {
    zeroRowsThen({ data: row, error: null });
    expect((await unarchiveContact(CONTACT)).error).toBe(sentence);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("zero rows because it was unarchived meanwhile (a double click, a colleague) is success with no second event", async () => {
    zeroRowsThen({ data: contact({ is_archived: false }), error: null });
    expect(await unarchiveContact(CONTACT)).toEqual({ error: null });
    expect(logEvent, "the unarchive that happened already has its event").not.toHaveBeenCalled();
    expect(revalidatePath, "the page is redrawn with the contact active").toHaveBeenCalledWith(`/contacts/${CONTACT}`);
  });

  it("a failed re-read is a failure, not 'permission' — postgrest-js resolves errors, it does not throw", async () => {
    zeroRowsThen({ data: null, error: { message: "fetch failed" } });
    expect((await unarchiveContact(CONTACT)).error).toBe("Could not unarchive this contact — try again.");
    expect(logEvent).not.toHaveBeenCalled();
  });
});

describe("unarchiveContact — the refusals that were already there", () => {
  it.each([
    ["a malformed id", "nope", [], "Missing contact"],
    ["an unknown contact", CONTACT, [{ data: null, error: null }], "Contact not found"],
    ["an active contact", CONTACT, [{ data: contact({ is_archived: false }), error: null }], "Not archived"],
    [
      "a merged contact",
      CONTACT,
      [{ data: contact({ merged_into_id: "33333333-3333-4333-8333-333333333333" }), error: null }],
      "This contact was merged into another — it stays archived.",
    ],
  ] as [string, string, FakePage[], string][])("refuses %s", async (_label, id, pages, message) => {
    const fake = setup(pages);
    expect((await unarchiveContact(id)).error).toBe(message);
    expect(updates(fake)).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("names a phone/e-mail slot taken meanwhile instead of leaking a raw 23505", async () => {
    setup([
      { data: contact(), error: null },
      { data: null, error: { message: 'duplicate key value violates unique constraint "contacts_email_unique"', code: "23505" } },
    ]);
    expect((await unarchiveContact(CONTACT)).error).toMatch(/another active contact now uses this phone or email/);
    expect(logEvent).not.toHaveBeenCalled();
  });
});
