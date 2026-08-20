import { describe, expect, it } from "vitest";
import { renderViewingConfirmationPdf, type ViewingConfirmationData } from "./viewing-confirmation-pdf";
import { extractPdfText } from "@/lib/testing/pdf-text";

/**
 * Same two properties the evidence and slip PDFs are pinned on, for the same
 * reasons (see evidence-pdf.test.ts):
 *
 * 1. **A Unicode font is really embedded.** Attendee names, agent names and
 *    Paphos addresses are routinely Greek or Cyrillic; react-pdf's built-in
 *    Helvetica encodes Latin-1 only, so without Noto Sans the sheet renders
 *    mojibake for a large share of this desk's clients.
 * 2. **The text is extractable.** This one is handed to a buyer and gets
 *    searched, copied and forwarded. A ligature with no ToUnicode mapping looks
 *    right and vanishes from extraction — that is not hypothetical here: this
 *    template's own prose is full of "confirms" / "confirmation", which is
 *    exactly the `fi` pair that came out as "?rst-response" in a real report.
 */
/**
 * react-pdf emits each laid-out run as its own chunk, so a value can arrive
 * split at a line-break opportunity: "20 Jul 2026, 12:00" extracts as "20 " +
 * "Jul 2026, 12:00". The page is correct; only the run boundaries are visible
 * to the extractor. Assert on whitespace-normalised text so these pin CONTENT
 * rather than today's line breaks — a test that fails when a label gets one
 * character wider is noise.
 */
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

const fixture: ViewingConfirmationData = {
  orgName: "GN Kalaitsidis Capital",
  agentName: "Γιώργος Καλαϊτσίδης",
  agentEmail: "agent@gnk.local",
  agentPhone: "+35799123456",
  attendeeName: "Дмитрий Иванов",
  propertyRef: "PAF0001",
  propertyAddress: "Κάτω Πάφος, Πάφος",
  viewingWhen: "20 Jul 2026, 12:00",
  durationLabel: "30 minutes",
  gdprLine: "Your personal data is processed under our privacy notice.",
  generatedAtLabel: "19 Jul 2026, 09:30",
};

describe("renderViewingConfirmationPdf", () => {
  it("produces a PDF with Noto Sans embedded", async () => {
    const pdf = await renderViewingConfirmationPdf(fixture);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(5_000);
    expect(pdf.toString("latin1")).toContain("NotoSans");
  });

  it("draws every field the agent is relying on", async () => {
    // A confirmation missing the time or the property is worse than none — the
    // buyer turns up to the wrong place, or not at all.
    const text = flat(extractPdfText(await renderViewingConfirmationPdf(fixture)));
    expect(text).toContain("GN Kalaitsidis Capital");
    expect(text).toContain("PAF0001");
    expect(text).toContain("20 Jul 2026, 12:00");
    expect(text).toContain("30 minutes");
    expect(text).toContain("agent@gnk.local");
  });

  it("round-trips Greek and Cyrillic through the PDF's own ToUnicode map", async () => {
    const text = flat(extractPdfText(await renderViewingConfirmationPdf(fixture)));
    expect(text).toContain("Дмитрий Иванов");
    expect(text).toContain("Γιώργος Καλαϊτσίδης");
    expect(text).toContain("Κάτω Πάφος, Πάφος");
  });

  it("leaves no unmapped glyphs — the template's own prose is ligature-prone", async () => {
    const text = flat(extractPdfText(await renderViewingConfirmationPdf(fixture)));
    expect(text).not.toContain("�");
    // "confirms" and "confirmation" both carry the fi pair that broke extraction
    // in a production evidence report.
    expect(text).toContain("This confirms the appointment above");
    expect(text).toContain("Viewing confirmation");
  });

  it("omits the address and contact rows rather than drawing empty labels", async () => {
    const text = flat(
      extractPdfText(
        await renderViewingConfirmationPdf({
          ...fixture,
          propertyAddress: null,
          agentEmail: null,
          agentPhone: null,
        }),
      ),
    );
    expect(text).not.toContain("Address");
    expect(text).not.toContain("Contact");
    // the rest of the sheet is unaffected
    expect(text).toContain("PAF0001");
  });

  it("states plainly that it is not a reservation", async () => {
    // The one line with legal weight on the page. A branded sheet that looks
    // like a commitment is the failure mode worth guarding.
    const text = flat(extractPdfText(await renderViewingConfirmationPdf(fixture)));
    expect(text).toContain("It is not a reservation and does not commit either party");
  });
});
