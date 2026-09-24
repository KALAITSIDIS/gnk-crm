import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * A document event names the document by id and carries the facts that decide
 * who may see it (`doc_type`, `visibility`) — never its title or the uploaded
 * file's name (audit SEC-03, DECISIONS T-event-typed-text-shape).
 *
 * The title is typed text, and when nobody types one it IS the uploaded file's
 * name — "Andreou passport scan.pdf". Until this change the contact, property
 * and mandate uploads (and the two deletions) copied it into the hash-chained
 * event, where erasure cannot reach it. The `documents` ROW keeps the title;
 * a timeline reads it from there with the viewer's own permissions, and a
 * deleted document reads as "Document deleted".
 *
 * The real actions call the real `logEvent`; the assertions read the row that
 * reached `events.insert`. Storage is a stand-in (these tests are about the
 * chain, not the bucket); transport is lib/testing/fake-client.ts.
 */

const state = vi.hoisted(() => ({
  client: null as unknown,
  role: "admin",
  removed: [] as string[][],
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        upload: async () => ({ data: { path: "p" }, error: null }),
        remove: async (paths: string[]) => {
          state.removed.push(paths);
          return { data: paths.map((name) => ({ name })), error: null };
        },
        exists: async () => ({ data: false, error: null }),
      }),
    },
  }),
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "admin-1", orgId: "org-1", role: state.role }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { uploadContactDocument, deleteContactDocument } = await import("@/lib/actions/contact-documents");
const { uploadPropertyDocument, deletePropertyDocument } = await import("@/lib/actions/property-documents");
const { uploadMandateDocument } = await import("@/lib/actions/mandates");

const CONTACT_ID = "8b1c2d3e-4f5a-4b6c-9d7e-0f1a2b3c4d01";
const PROPERTY_ID = "8b1c2d3e-4f5a-4b6c-9d7e-0f1a2b3c4d02";
const MANDATE_ID = "8b1c2d3e-4f5a-4b6c-9d7e-0f1a2b3c4d03";
const DOC_ID = "8b1c2d3e-4f5a-4b6c-9d7e-0f1a2b3c4d04";

// synthetic identifiers — none may reach the chain
const FILE_NAME = "Andreou Kyriakos passport AB1234567 +35799111222.pdf";
const TYPED_TITLE = "Passport of Kyriakos Andreou (kyriakos.andreou@example.invalid)";
const WORDS = ["Andreou", "Kyriakos", "AB1234567", "35799111222", "kyriakos.andreou", "example.invalid", ".pdf"];

const pdf = () => new File([new Uint8Array([37, 80, 68, 70])], FILE_NAME, { type: "application/pdf" });

function form(fields: Record<string, string>, withFile = true) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (withFile) fd.set("file", pdf());
  return fd;
}

function install(pages: Record<string, FakePage[]>) {
  const fake = fakeClient(pages);
  state.client = fake.client;
  return fake;
}

/** every row the real logEvent handed to `events.insert` */
const inserted = (fake: ReturnType<typeof fakeClient>) =>
  fake.argsOf("events", "insert").map((args) => args[0] as Record<string, unknown>);

const leaked = (fake: ReturnType<typeof fakeClient>) => {
  const text = JSON.stringify(inserted(fake));
  return WORDS.filter((w) => text.includes(w));
};

const idle = { error: null, savedAt: null };

beforeEach(() => {
  state.client = null;
  state.role = "admin";
  state.removed = [];
});

describe("contact documents", () => {
  it("upload: the event carries the document id, type and visibility — no title, no file name", async () => {
    for (const title of [TYPED_TITLE, ""]) {
      // "" = no title typed, so the row's title defaults to the FILE NAME
      const fake = install({
        contacts: [{ data: { id: CONTACT_ID, org_id: "org-1", is_archived: false }, error: null }],
        documents: [{ data: { id: DOC_ID, visibility: "admin_only" }, error: null }],
      });
      const result = await uploadContactDocument(
        idle,
        form({ contact_id: CONTACT_ID, doc_type: "id_document", title }),
      );
      expect(result.error).toBeNull();

      // the row keeps the descriptive text — that is where it belongs
      const [row] = fake.argsOf("documents", "insert")[0] as [Record<string, unknown>];
      expect(row.title).toBe(title || FILE_NAME);

      const rows = inserted(fake);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entity_type: "contact",
        entity_id: CONTACT_ID,
        event_type: "document_uploaded",
      });
      expect(rows[0].payload).toEqual({
        document_id: DOC_ID,
        doc_type: "id_document",
        visibility: "admin_only",
      });
      expect(leaked(fake), "a document's title or file name reached the hash chain").toEqual([]);
    }
  });

  it("delete: the event carries the document id, type and visibility — no title", async () => {
    const fake = install({
      documents: [
        {
          data: {
            id: DOC_ID,
            org_id: "org-1",
            title: TYPED_TITLE,
            doc_type: "id_document",
            visibility: "admin_only",
            storage_path: `org-1/contacts/${CONTACT_ID}/1-${FILE_NAME}`,
            entity_type: "contact",
            entity_id: CONTACT_ID,
          },
          error: null,
        },
        { data: [{ id: DOC_ID }], error: null },
      ],
    });
    expect(await deleteContactDocument(DOC_ID, CONTACT_ID)).toEqual({ error: null });
    // the stored file still goes — storage behaviour is unchanged
    expect(state.removed).toHaveLength(1);

    const rows = inserted(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: "contact", entity_id: CONTACT_ID, event_type: "document_deleted" });
    expect(rows[0].payload).toEqual({ document_id: DOC_ID, doc_type: "id_document", visibility: "admin_only" });
    expect(leaked(fake)).toEqual([]);
  });

  it("a refused delete (RLS filtered it to 0 rows) removes nothing and logs nothing", async () => {
    const fake = install({
      documents: [
        {
          data: {
            id: DOC_ID,
            org_id: "org-1",
            title: TYPED_TITLE,
            doc_type: "other",
            visibility: "internal",
            storage_path: "x",
            entity_type: "contact",
            entity_id: CONTACT_ID,
          },
          error: null,
        },
        { data: [], error: null },
      ],
    });
    expect((await deleteContactDocument(DOC_ID, CONTACT_ID)).error).toMatch(/only admins/);
    expect(state.removed).toEqual([]);
    expect(inserted(fake)).toEqual([]);
  });
});

describe("property documents", () => {
  it("upload: the event carries the document id, type and visibility — no title, no file name", async () => {
    for (const title of [TYPED_TITLE, ""]) {
      const fake = install({
        properties: [{ data: { id: PROPERTY_ID, org_id: "org-1" }, error: null }],
        documents: [{ data: { id: DOC_ID, visibility: "internal" }, error: null }],
      });
      const result = await uploadPropertyDocument(
        idle,
        form({ property_id: PROPERTY_ID, doc_type: "title_deed", title }),
      );
      expect(result.error).toBeNull();

      const [row] = fake.argsOf("documents", "insert")[0] as [Record<string, unknown>];
      expect(row.title).toBe(title || FILE_NAME);

      const rows = inserted(fake);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entity_type: "property",
        entity_id: PROPERTY_ID,
        event_type: "document_uploaded",
      });
      expect(rows[0].payload).toEqual({ document_id: DOC_ID, doc_type: "title_deed", visibility: "internal" });
      expect(leaked(fake)).toEqual([]);
    }
  });

  it("delete: the event carries the document id, type and visibility — no title", async () => {
    const fake = install({
      documents: [
        {
          data: {
            id: DOC_ID,
            org_id: "org-1",
            title: TYPED_TITLE,
            doc_type: "title_deed",
            visibility: "internal",
            storage_path: `org-1/properties/${PROPERTY_ID}/1-${FILE_NAME}`,
            entity_type: "property",
            entity_id: PROPERTY_ID,
          },
          error: null,
        },
        { data: [{ id: DOC_ID }], error: null },
      ],
    });
    expect(await deletePropertyDocument(DOC_ID, PROPERTY_ID)).toEqual({ error: null });
    expect(state.removed).toHaveLength(1);

    const rows = inserted(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: "property", entity_id: PROPERTY_ID, event_type: "document_deleted" });
    expect(rows[0].payload).toEqual({ document_id: DOC_ID, doc_type: "title_deed", visibility: "internal" });
    expect(leaked(fake)).toEqual([]);
  });

  it("a refused delete logs nothing", async () => {
    const fake = install({
      documents: [
        {
          data: {
            id: DOC_ID,
            org_id: "org-1",
            title: TYPED_TITLE,
            doc_type: "other",
            visibility: "internal",
            storage_path: "x",
            entity_type: "property",
            entity_id: PROPERTY_ID,
          },
          error: null,
        },
        { data: [], error: null },
      ],
    });
    expect((await deletePropertyDocument(DOC_ID, PROPERTY_ID)).error).toMatch(/only admins/);
    expect(inserted(fake)).toEqual([]);
  });
});

describe("mandate documents", () => {
  it("upload: the event carries the uploaded document's id for traceability — not the file name", async () => {
    const fake = install({
      mandates: [
        { data: { id: MANDATE_ID, org_id: "org-1", property_id: PROPERTY_ID }, error: null },
        { data: null, error: null }, // the signed_document_id link
      ],
      documents: [{ data: { id: DOC_ID, visibility: "internal" }, error: null }],
    });
    const result = await uploadMandateDocument(idle, form({ mandate_id: MANDATE_ID }));
    expect(result.error).toBeNull();

    // the row keeps the file name as its title, and the mandate links the row
    const [row] = fake.argsOf("documents", "insert")[0] as [Record<string, unknown>];
    expect(row.title).toBe(FILE_NAME);
    expect(fake.argsOf("mandates", "update")).toEqual([[{ signed_document_id: DOC_ID }]]);

    const rows = inserted(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity_type: "mandate",
      entity_id: MANDATE_ID,
      event_type: "document_uploaded",
    });
    expect(rows[0].payload).toEqual({
      document_id: DOC_ID,
      doc_type: "mandate_agreement",
      visibility: "internal",
    });
    expect(leaked(fake), "the mandate file's name reached the hash chain").toEqual([]);
  });

  it("a non-admin upload is refused before anything is written or logged", async () => {
    state.role = "agent";
    const fake = install({});
    expect((await uploadMandateDocument(idle, form({ mandate_id: MANDATE_ID }))).error).toMatch(/admins/);
    expect(fake.argsOf("documents", "insert")).toEqual([]);
    expect(inserted(fake)).toEqual([]);
  });
});
