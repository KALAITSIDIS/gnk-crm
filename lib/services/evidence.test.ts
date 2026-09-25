import { describe, expect, it } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";
import { assembleEvidence, reportContentHash, sortChronological, type EvidenceRow } from "./evidence";

let seq = 0;
const row = (occurredAt: string, line: string, extra?: Partial<EvidenceRow>): EvidenceRow => ({
  id: ++seq,
  occurredAt,
  entityType: "deal",
  line,
  propertyRef: null,
  actorName: null,
  ...extra,
});

describe("sortChronological", () => {
  it("orders oldest first regardless of input order", () => {
    const out = sortChronological([
      row("2026-07-12T10:00:00Z", "second"),
      row("2026-07-10T09:00:00Z", "first"),
      row("2026-07-13T08:00:00Z", "third"),
    ]);
    expect(out.map((r) => r.line)).toEqual(["first", "second", "third"]);
  });

  it("breaks timestamp ties by event id (chain order), whatever the input order", () => {
    const a = row("2026-07-12T10:00:00Z", "first-inserted", { id: 7 });
    const b = row("2026-07-12T10:00:00Z", "second-inserted", { id: 9 });
    const c = row("2026-07-12T10:00:00Z", "third-inserted", { id: 12 });
    expect(sortChronological([b, c, a]).map((r) => r.line)).toEqual([
      "first-inserted",
      "second-inserted",
      "third-inserted",
    ]);
    expect(sortChronological([c, a, b])).toEqual(sortChronological([a, b, c]));
  });

  it("does not mutate the input", () => {
    const input = [row("2026-07-12T10:00:00Z", "b"), row("2026-07-10T09:00:00Z", "a")];
    sortChronological(input);
    expect(input[0].line).toBe("b");
  });
});

describe("reportContentHash", () => {
  const rows = [
    row("2026-07-10T09:00:00Z", "Created", { propertyRef: "PAF0001", actorName: "G. K." }),
    row("2026-07-11T10:00:00Z", "Stage New → Qualified"),
  ];

  it("is deterministic for identical content", () => {
    expect(reportContentHash(rows)).toBe(reportContentHash([...rows]));
  });

  it("is a 64-char lowercase hex digest", () => {
    expect(reportContentHash(rows)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any row field changes", () => {
    const base = reportContentHash(rows);
    const tamperedLine = [rows[0], { ...rows[1], line: "Stage New → Viewing" }];
    const tamperedActor = [{ ...rows[0], actorName: "someone else" }, rows[1]];
    expect(reportContentHash(tamperedLine)).not.toBe(base);
    expect(reportContentHash(tamperedActor)).not.toBe(base);
  });

  it("treats null and empty-string fields identically (canonical form)", () => {
    const a = [row("2026-07-10T09:00:00Z", "x", { propertyRef: null })];
    const b = [row("2026-07-10T09:00:00Z", "x", { propertyRef: "" as unknown as null })];
    expect(reportContentHash(a)).toBe(reportContentHash(b));
  });

  it("ignores the internal event id — old report hashes stay recomputable", () => {
    const a = [row("2026-07-10T09:00:00Z", "x", { id: 1 })];
    const b = [row("2026-07-10T09:00:00Z", "x", { id: 999 })];
    expect(reportContentHash(a)).toBe(reportContentHash(b));
  });
});

/**
 * T-event-typed-text-shape: the commission evidence report renders its lines
 * through describeEvent, so it prints no document title (or file name), no
 * deal or lead lost reason and no reservation release reason — not from a new
 * payload, which carries none, and not from
 * an older one, which does. The PDF is a new document at rest; it must not
 * re-publish what the chain cannot erase. Driven through the real assembler.
 */
describe("assembleEvidence prints no typed text from event payloads", () => {
  const CONTACT = "66666666-6666-4666-8666-666666666666";
  const DEAL = "77777777-7777-4777-8777-777777777777";
  const DOC = "88888888-8888-4888-8888-888888888888";

  it("renders legacy and new document and deal-lost events as neutral lines", async () => {
    const at = (m: number) => `2026-09-${String(m).padStart(2, "0")}T10:00:00Z`;
    const ev = (id: number, entity_type: string, entity_id: string, event_type: string, payload: unknown) => ({
      id,
      occurred_at: at(id),
      entity_type,
      entity_id,
      event_type,
      actor_id: null,
      payload,
    });
    const caller = fakeClient({
      contacts: [{ data: { id: CONTACT, display_name: "Fixture Buyer", phone_e164: null, email: null }, error: null }],
      organizations: [{ data: { name: "Fixture Agency" }, error: null }],
      deals: [
        {
          data: [{ id: DEAL, title: "Fixture deal", status: "lost", expected_value: null, commission_split_notes: null, property_id: null }],
          error: null,
        },
      ],
      events: [
        // the contact family is awaited first, then the deal family
        {
          data: [
            ev(1, "contact", CONTACT, "document_uploaded", { document_id: DOC, title: "passport_AB1234567.pdf", doc_type: "id_document", visibility: "admin_only" }),
            ev(2, "contact", CONTACT, "document_deleted", { document_id: DOC, title: "Andreou source of funds.pdf" }),
            ev(3, "contact", CONTACT, "document_uploaded", { document_id: DOC, doc_type: "contract", visibility: "internal" }),
          ],
          error: null,
        },
        {
          data: [
            ev(4, "deal", DEAL, "lost", { reason: "Eleni Charalambous bought elsewhere", stage: "Lost" }),
            ev(5, "deal", DEAL, "lost", { stage: "Lost" }),
          ],
          error: null,
        },
      ],
    });
    const admin = fakeClient({});

    const out = await assembleEvidence(caller.client as never, admin.client as never, "org-1", {
      contactId: CONTACT,
      generatedBy: { name: "Admin", role: "admin" },
    });
    if ("errorKey" in out) throw new Error(`assembly failed: ${out.errorKey}`);

    expect(out.rows.map((r) => r.line)).toEqual([
      "Document uploaded",
      "Document deleted",
      "Document uploaded",
      "Marked lost",
      "Marked lost",
    ]);
    const text = JSON.stringify(out.rows);
    for (const word of ["passport", "AB1234567", "Andreou", "Eleni", "Charalambous"]) {
      expect(text, `${word} reached the evidence rows`).not.toContain(word);
    }
    // the evidence path never asks the admin client for anything but slips and the chain
    expect(admin.calls).toEqual([]);
  });

  it("renders a lead's legacy lost and spam reasons as neutral lines (T-lead-lost-reason-shape)", async () => {
    const LEAD = "99999999-9999-4999-8999-999999999999";
    const caller = fakeClient({
      contacts: [{ data: { id: CONTACT, display_name: "Fixture Buyer", phone_e164: null, email: null }, error: null }],
      organizations: [{ data: { name: "Fixture Agency" }, error: null }],
      deals: [{ data: [], error: null }],
      leads: [{ data: [{ id: LEAD, property_id: null }], error: null }],
      events: [
        // the contact family is awaited first, then the lead family
        { data: [], error: null },
        {
          data: [
            { id: 1, occurred_at: "2026-09-01T10:00:00Z", entity_type: "lead", entity_id: LEAD, event_type: "lost", actor_id: null, payload: { reason: "Andreas Kyprianou went elsewhere" } },
            { id: 2, occurred_at: "2026-09-02T10:00:00Z", entity_type: "lead", entity_id: LEAD, event_type: "spam", actor_id: null, payload: { reason: "sent from 99 555 666" } },
            { id: 3, occurred_at: "2026-09-03T10:00:00Z", entity_type: "lead", entity_id: LEAD, event_type: "lost", actor_id: null, payload: {} },
          ],
          error: null,
        },
      ],
    });
    const out = await assembleEvidence(caller.client as never, fakeClient({}).client as never, "org-1", {
      contactId: CONTACT,
      generatedBy: { name: "Admin", role: "admin" },
    });
    if ("errorKey" in out) throw new Error(`assembly failed: ${out.errorKey}`);
    expect(out.rows.map((r) => r.line)).toEqual(["Marked lost", "Marked spam", "Marked lost"]);
    const text = JSON.stringify(out.rows);
    for (const word of ["Andreas", "Kyprianou", "99 555 666"]) expect(text).not.toContain(word);
  });

  it("renders a property-scoped report's legacy release reasons as neutral lines (T-reservation-release-reason-shape)", async () => {
    // A report about ONE buyer, scoped to a property, lists every hold on that
    // property — other buyers' too. Their typed reasons used to print here.
    const PROPERTY = "aaaaaaaa-1111-4111-8111-111111111111";
    const caller = fakeClient({
      contacts: [{ data: { id: CONTACT, display_name: "Fixture Buyer", phone_e164: null, email: null }, error: null }],
      organizations: [{ data: { name: "Fixture Agency" }, error: null }],
      deals: [{ data: [], error: null }],
      events: [
        {
          data: [
            { id: 1, occurred_at: "2026-09-01T10:00:00Z", entity_type: "property", entity_id: PROPERTY, event_type: "reservation_status_changed", actor_id: null, payload: { reservation_id: "r1", from: "held", to: "released", reason: "Elena Hadjipetrou withdrew, 99 777 888" } },
            { id: 2, occurred_at: "2026-09-02T10:00:00Z", entity_type: "property", entity_id: PROPERTY, event_type: "reservation_status_changed", actor_id: null, payload: { reservation_id: "r2", from: "held", to: "released" } },
          ],
          error: null,
        },
      ],
      properties: [{ data: [{ id: PROPERTY, reference: "PAF0999" }], error: null }],
    });
    const out = await assembleEvidence(caller.client as never, fakeClient({}).client as never, "org-1", {
      contactId: CONTACT,
      propertyId: PROPERTY,
      generatedBy: { name: "Admin", role: "admin" },
    });
    if ("errorKey" in out) throw new Error(`assembly failed: ${out.errorKey}`);
    expect(out.rows.map((r) => r.line)).toEqual(["Reservation held → released", "Reservation held → released"]);
    const text = JSON.stringify(out.rows);
    for (const word of ["Elena", "Hadjipetrou", "99 777 888"]) expect(text).not.toContain(word);
  });

  it("renders a property-scoped report's viewing feedback as neutral lines — other buyers' words included (T-viewing-feedback-shape)", async () => {
    // A report about ONE buyer, scoped to a property, lists every viewing's
    // feedback on that property — OTHER buyers' words too, in a PDF made to be
    // handed to a third party in a commission dispute.
    const PROPERTY = "aaaaaaaa-1111-4111-8111-111111111111";
    // real uuids: an id the context reader would actually look up
    const V1 = "bbbbbbbb-1111-4111-8111-111111111111";
    const V2 = "bbbbbbbb-2222-4222-8222-222222222222";
    const caller = fakeClient({
      contacts: [{ data: { id: CONTACT, display_name: "Fixture Buyer", phone_e164: null, email: null }, error: null }],
      organizations: [{ data: { name: "Fixture Agency" }, error: null }],
      deals: [{ data: [], error: null }],
      events: [
        {
          data: [
            { id: 1, occurred_at: "2026-09-01T10:00:00Z", entity_type: "property", entity_id: PROPERTY, event_type: "viewing_feedback", actor_id: null, payload: { viewing_id: V1, reference: "PAF0999", rating: 4, liked: "Zenobia Quillfeather loved it", disliked: "price", comment: "call 99 000 111" } },
            { id: 2, occurred_at: "2026-09-02T10:00:00Z", entity_type: "property", entity_id: PROPERTY, event_type: "viewing_feedback", actor_id: null, payload: { viewing_id: V2, reference: "PAF0999", rating: 2 } },
          ],
          error: null,
        },
      ],
      properties: [{ data: [{ id: PROPERTY, reference: "PAF0999" }], error: null }],
      // the buyer's own viewings read (none), then — should anything ever wire
      // the current-feedback reader into the report — rows whose words it would print
      viewings: [
        { data: [], error: null },
        {
          data: [
            { id: V1, property_id: PROPERTY, feedback: { rating: 4, liked: null, disliked: null, comment: "Current words of Zenobia" } },
            { id: V2, property_id: PROPERTY, feedback: { rating: 2, liked: "Current words of Andreas", disliked: null, comment: null } },
          ],
          error: null,
        },
      ],
    });
    const admin = fakeClient({});
    const out = await assembleEvidence(caller.client as never, admin.client as never, "org-1", {
      contactId: CONTACT,
      propertyId: PROPERTY,
      generatedBy: { name: "Admin", role: "admin" },
    });
    if ("errorKey" in out) throw new Error(`assembly failed: ${out.errorKey}`);
    expect(out.rows.map((r) => r.line)).toEqual(["Viewing feedback ★★★★", "Viewing feedback ★★"]);
    const text = JSON.stringify(out.rows);
    for (const word of ["Zenobia", "Quillfeather", "99 000 111", "price", "Current words", "Andreas"]) {
      expect(text).not.toContain(word);
    }
    // the report attaches no CURRENT feedback either: it reads the buyer's own
    // viewings for their slips — once — and never the feedback column
    expect(caller.served.viewings).toBe(1);
    expect(caller.argsOf("viewings", "select").flat().join(" ")).not.toMatch(/feedback/);
    expect(admin.calls).toEqual([]);
  });

  it("renders the contact's legacy imported event without the name it carries (T-imported-identity-shape)", async () => {
    // An admin's un-narrowed report includes the contact's own actor-null
    // `imported` event; the CSV importers wrote `{ name }` into it. The header
    // names the contact from the row — the line must not reprint the chain's copy.
    const caller = fakeClient({
      contacts: [{ data: { id: CONTACT, display_name: "Fixture Buyer", phone_e164: null, email: null }, error: null }],
      organizations: [{ data: { name: "Fixture Agency" }, error: null }],
      deals: [{ data: [], error: null }],
      events: [
        {
          data: [
            { id: 1, occurred_at: "2026-09-01T10:00:00Z", entity_type: "contact", entity_id: CONTACT, event_type: "imported", actor_id: null, payload: { source: "csv_import", name: "Zenobia Quillfeather", batch: "b1" } },
            { id: 2, occurred_at: "2026-09-02T10:00:00Z", entity_type: "contact", entity_id: CONTACT, event_type: "imported", actor_id: null, payload: { source: "csv_import", name: "+35799778899", as: "owner", batch: "b1" } },
            { id: 3, occurred_at: "2026-09-03T10:00:00Z", entity_type: "contact", entity_id: CONTACT, event_type: "imported", actor_id: null, payload: { source: "csv_import", batch: "b1" } },
          ],
          error: null,
        },
      ],
    });
    const out = await assembleEvidence(caller.client as never, fakeClient({}).client as never, "org-1", {
      contactId: CONTACT,
      generatedBy: { name: "Admin", role: "admin" },
    });
    if ("errorKey" in out) throw new Error(`assembly failed: ${out.errorKey}`);
    expect(out.rows.map((r) => r.line)).toEqual(["Imported from CSV", "Imported from CSV", "Imported from CSV"]);
    const text = JSON.stringify(out.rows);
    for (const word of ["Zenobia", "Quillfeather", "99778899"]) expect(text).not.toContain(word);
  });
});
