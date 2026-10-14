import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// the forms' hooks and actions, outside a Next app: rendering must need neither
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/actions/property-documents", () => ({
  uploadPropertyDocument: vi.fn(),
  deletePropertyDocument: vi.fn(),
}));
vi.mock("@/lib/actions/contact-documents", () => ({
  uploadContactDocument: vi.fn(),
  deleteContactDocument: vi.fn(),
}));
vi.mock("@/lib/actions/documents", () => ({ getDocumentDownloadUrl: vi.fn() }));
vi.mock("@/lib/actions/settings", () => ({ updateOrgName: vi.fn(), uploadBranding: vi.fn() }));

const { DocumentsTab } = await import("@/components/features/properties/documents-tab");
const { ContactDocumentsTab } = await import("@/components/features/contacts/documents-tab");
const { BrandingUpload } = await import("@/components/features/settings/org-forms");

/**
 * What the upload forms PRINT as their limit (T-upload-size-honest), rendered
 * the way the server renders them — the source guard in
 * upload-forms-guard.test.ts can be satisfied by an import alone, and an
 * unused import is only a lint warning. The limit is the measured request
 * budget (3,500,000 bytes = 3.3 MB in the repo's 1024 × 1024 MB), not the
 * actions' undeliverable 15 MB; branding prints its own 2 MB cap.
 *
 * The mandate upload's line lives in a dialog that renders nothing until it
 * is opened (and is not exported), so its label is pinned by the guard's
 * markup-scoped pattern instead.
 */
const markup = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(element)
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** The label of the file input (`for="doc_file"`), as the page shows it. */
const DOCUMENT_LABEL = /<label[^>]*for="doc_file"[^>]*>File \(PDF, JPG or PNG · up to 3\.3 MB\)<\/label>/;

describe("the upload forms print the limit they enforce", () => {
  it("the property documents tab labels its file input with the real limit", () => {
    const html = markup(createElement(DocumentsTab, { propertyId: "p-1", items: [] }));
    expect(html).toMatch(DOCUMENT_LABEL);
    expect(html).not.toMatch(/15\s*MB/);
  });

  it("the contact (KYC) documents tab labels its file input with the real limit", () => {
    const html = markup(createElement(ContactDocumentsTab, { contactId: "c-1", items: [] }));
    expect(html).toMatch(DOCUMENT_LABEL);
    expect(html).not.toMatch(/15\s*MB/);
  });

  it("the branding upload prints its own 2 MB cap", () => {
    const html = markup(
      createElement(BrandingUpload, { kind: "logo", title: "Logo", hint: "A PNG with transparency.", currentUrl: null }),
    );
    expect(html).toContain("A PNG with transparency. Up to 2.0 MB.");
    expect(html).toMatch(/<input[^>]*type="file"[^>]*accept="image\/png"/);
  });
});
