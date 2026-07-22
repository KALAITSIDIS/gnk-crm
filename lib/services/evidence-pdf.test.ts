import { describe, expect, it } from "vitest";
import { renderEvidencePdf } from "./evidence-pdf";
import { renderSlipPdf } from "./slip-pdf";
import { extractPdfText } from "@/lib/testing/pdf-text";
import type { EvidenceData } from "./evidence";

/**
 * The agency's data is trilingual (en/el/ru): contact names, signer names and
 * commission notes routinely contain Greek or Cyrillic. react-pdf's built-in
 * Helvetica only encodes Latin-1, so both PDFs must embed a Unicode font
 * (Noto Sans LGC) — these tests pin that the font is actually embedded and
 * that non-Latin text renders without throwing.
 */

const evidenceFixture: EvidenceData = {
  orgName: "GN Kalaitsidis Capital",
  generatedBy: { name: "Γιώργος Καλαϊτσίδης", role: "admin" },
  contact: {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Αντρέας Παπαδόπουλος",
    phone: "+35799123456",
    email: null,
  },
  filter: {
    propertyRef: "GNK-PAF-0001",
    dealTitle: "Πώληση — Κάτω Πάφος",
    from: "2026-07-01",
    to: "2026-07-15",
  },
  rows: [
    {
      id: 1,
      occurredAt: "2026-07-02T08:00:00Z",
      entityType: "viewing",
      line: "Viewing slip signed by Дмитрий Иванов · Stage Νέο → Προβολή",
      propertyRef: "GNK-PAF-0001",
      actorName: "Γιώργος Καλαϊτσίδης",
    },
  ],
  slips: [
    {
      viewingId: "00000000-0000-0000-0000-000000000002",
      signerName: "Дмитрий Иванов",
      signedAt: "2026-07-02T08:30:00Z",
      sha256: "ab".repeat(32),
      propertyRef: "GNK-PAF-0001",
      pngDataUri: null,
    },
  ],
  deals: [
    {
      title: "Πώληση — Κάτω Πάφος",
      status: "active",
      expectedValue: 480000,
      commissionNotes: "50/50 με συνεργάτη · аванс получен",
    },
  ],
  chain: "verified",
  truncated: false,
  reportHash: "cd".repeat(32),
};

describe("renderEvidencePdf (unicode)", () => {
  it("renders Greek and Cyrillic content into a PDF with Noto Sans embedded", async () => {
    const pdf = await renderEvidencePdf(evidenceFixture, "20 Jul 2026, 12:00");
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(10_000);
    expect(pdf.toString("latin1")).toContain("NotoSans");
  });
});

describe("evidence PDF text is extractable (copy/paste + search)", () => {
  /*
   * A commission report gets text-searched and quoted. Ligature substitution
   * ("fi" -> a single glyph) leaves the page looking right while the glyph
   * carries no ToUnicode mapping, so extraction silently drops characters:
   * "first-response" came out "?rst-response" in a real production report.
   * Our bundled fonts therefore ship with the ligature features disabled.
   */
  const ligatureFixture: EvidenceData = {
    ...evidenceFixture,
    rows: [
      {
        id: 1,
        occurredAt: "2026-07-02T08:00:00Z",
        entityType: "lead",
        line: "Lead corrected — first-response reset",
        propertyRef: null,
        actorName: "Office staff",
      },
    ],
    slips: [],
    deals: [],
  };

  it("round-trips ligature-prone words through the PDF's own ToUnicode map", async () => {
    const text = extractPdfText(await renderEvidencePdf(ligatureFixture, "22 Jul 2026, 18:14"));
    // fi ligature in the row, ff in the actor, fi again in the fixed template
    expect(text).toContain("first-response reset");
    expect(text).toContain("Office staff");
    expect(text).toContain("chain verified");
  });

  it("leaves no unmapped glyphs anywhere in the document", async () => {
    const text = extractPdfText(await renderEvidencePdf(ligatureFixture, "22 Jul 2026, 18:14"));
    expect(text).not.toContain("�");
    // the report hash is what a verifier pastes into "Verify a report"
    expect(text).toContain(ligatureFixture.reportHash);
  });
});

describe("renderSlipPdf (unicode)", () => {
  // 1×1 white PNG — a valid stand-in for the signature raster
  const whitePixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("renders a Greek/Cyrillic slip with Noto Sans embedded", async () => {
    const pdf = await renderSlipPdf({
      orgName: "GN Kalaitsidis Capital",
      agentName: "Γιώργος Καλαϊτσίδης",
      signerName: "Дмитрий Иванов",
      propertyRef: "GNK-PAF-0001",
      propertyAddress: "Οδός Ποσειδώνος 12, Πάφος",
      viewingWhen: "20 Jul 2026, 10:00",
      gdprLine: "Τα δεδομένα σας υποβάλλονται σε επεξεργασία σύμφωνα με τον GDPR.",
      signatureDataUrl: whitePixel,
      signedAtLabel: "20 Jul 2026, 10:25",
      sha256: "ef".repeat(32),
    });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("NotoSans");
  });
});
