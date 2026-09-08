import { describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";

/**
 * A `document_deleted` event must carry `doc_type`, because that is the only
 * thing left that can decide who may read its title.
 *
 * `lib/services/entity-timeline.ts` withholds a document's title from a
 * non-admin unless `contactDocVisibility(payload.doc_type) === "internal"`, and
 * it FAILS CLOSED when the payload has no readable doc_type — correctly, because
 * an unrecognised shape must not hand over a passport filename.
 *
 * But neither delete path sent the field. Both wrote `{ document_id, title }`,
 * so for the whole `document_deleted` half the doc_type branch was DEAD and the
 * redactor was unconditionally strip-the-title: every deleted title deed, plan,
 * valuation and contract lost its name for every agent and listing manager, on
 * documents nothing was protecting. The timeline widening of 2026-09-07 existed
 * to make the audit trail honest, and this was the one line it quietly dropped.
 *
 * The redactor's own unit test did not catch it because it built its
 * `document_deleted` row from a payload WITH doc_type — a shape production never
 * wrote. It asserted the right answer for the wrong reason. THIS file pins the
 * other half of the contract: what the writer actually sends.
 *
 * The row is gone by the time anyone reads the timeline, so there is no lookup
 * to fall back on. Historical events keep losing their titles, and must.
 */

const state = vi.hoisted(() => ({ caller: null as unknown }));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);
const removeObjectsBestEffort = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.caller }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ storage: {} }) }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "admin-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/services/storage", () => ({ removeObjectsBestEffort }));

const { deleteContactDocument } = await import("@/lib/actions/contact-documents");
const { deletePropertyDocument } = await import("@/lib/actions/property-documents");

const docRow = (entityType: "contact" | "property", docType: string) => ({
  id: "doc-1",
  org_id: "org-1",
  title: entityType === "contact" ? "passport_AB123456.pdf" : "Title deed PAF0001.pdf",
  doc_type: docType,
  storage_path: "org-1/doc-1.pdf",
  entity_type: entityType,
  entity_id: entityType === "contact" ? "c1" : "p1",
});

function serve(entityType: "contact" | "property", docType: string) {
  logEvent.mockClear();
  const caller = fakeClient({
    documents: [
      { data: docRow(entityType, docType), error: null }, // the pre-read
      { data: [{ id: "doc-1" }], error: null }, // the delete, proving it wrote
    ],
  });
  state.caller = caller.client;
  return caller;
}

describe("the deletion event carries the doc_type the timeline needs", () => {
  it("a contact document — so a KYC title stays withheld for the right reason", async () => {
    serve("contact", "id_document");
    const res = await deleteContactDocument("doc-1", "c1");
    expect(res.error).toBeNull();

    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][1]).toMatchObject({
      eventType: "document_deleted",
      entityType: "contact",
      payload: { document_id: "doc-1", title: "passport_AB123456.pdf", doc_type: "id_document" },
    });
  });

  it("a property document — so an org-readable title is no longer lost on deletion", async () => {
    serve("property", "title_deed");
    const res = await deletePropertyDocument("doc-1", "p1");
    expect(res.error).toBeNull();

    expect(logEvent.mock.calls[0][1]).toMatchObject({
      eventType: "document_deleted",
      entityType: "property",
      payload: { document_id: "doc-1", title: "Title deed PAF0001.pdf", doc_type: "title_deed" },
    });
  });

  it.each([
    ["contact", deleteContactDocument, "c1"],
    ["property", deletePropertyDocument, "p1"],
  ] as const)("the %s pre-read asks for doc_type at all", async (entityType, fn, entityId) => {
    // the field can only reach the payload if the SELECT brings it back, and
    // widening that select is the actual fix — a mutation that drops it from the
    // select alone must fail something
    const caller = serve(entityType, "contract");
    await fn("doc-1", entityId);
    const selects = caller.argsOf("documents", "select").map((a) => String(a[0]));
    expect(
      selects.some((s) => s.includes("doc_type")),
      "the row is gone afterwards — this is the only chance to read it",
    ).toBe(true);
  });
});
