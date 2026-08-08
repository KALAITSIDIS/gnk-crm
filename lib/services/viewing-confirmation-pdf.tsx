import "server-only";
import React from "react";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { PDF_FONT, registerPdfFonts } from "@/lib/services/pdf-fonts";

/**
 * Viewing confirmation (IMPROVEMENTS B4 / doc 01 M10) — the branded sheet an
 * agent sends or prints BEFORE the viewing. Its counterpart is the signed slip
 * (`slip-pdf.tsx`), which is produced AT the viewing and is the evidential
 * artifact; this one confirms an appointment and carries no signature.
 *
 * Everything here comes from the record. The only prose is `gdprLine`, and that
 * is `SLIP_GDPR_LINE` — the same notice the slip already shows, passed in rather
 * than restated so the two can never drift into saying different things about
 * the same data.
 *
 * Noto Sans throughout, not Helvetica: attendee names, agent names and Paphos
 * addresses are routinely Greek or Cyrillic (see pdf-fonts.ts).
 */
export interface ViewingConfirmationData {
  orgName: string;
  agentName: string;
  agentEmail: string | null;
  agentPhone: string | null;
  attendeeName: string;
  propertyRef: string;
  propertyAddress: string | null;
  viewingWhen: string;
  durationLabel: string;
  gdprLine: string;
  generatedAtLabel: string;
}

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 11, color: "#1a1a1a", fontFamily: PDF_FONT },
  org: { fontSize: 16, fontFamily: PDF_FONT, fontWeight: 700 },
  title: { fontSize: 13, marginTop: 4, marginBottom: 20, color: "#555" },
  row: { flexDirection: "row", marginBottom: 8 },
  label: { width: 130, color: "#777", fontFamily: PDF_FONT, fontWeight: 700 },
  value: { flex: 1 },
  sectionGap: { marginTop: 14 },
  note: {
    marginTop: 18,
    padding: 10,
    fontSize: 10,
    color: "#333",
    backgroundColor: "#f4f4f5",
    lineHeight: 1.4,
  },
  gdpr: {
    marginTop: 12,
    padding: 10,
    fontSize: 9,
    color: "#555",
    backgroundColor: "#f4f4f5",
    lineHeight: 1.4,
  },
  footer: { marginTop: 24, fontSize: 8, color: "#888" },
});

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

export function ViewingConfirmationDocument(d: ViewingConfirmationData) {
  const contactBits = [d.agentEmail, d.agentPhone].filter(Boolean).join(" · ");
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.org}>{d.orgName}</Text>
        <Text style={styles.title}>Viewing confirmation</Text>

        <Row label="Attendee" value={d.attendeeName} />
        <Row label="Property" value={d.propertyRef} />
        {d.propertyAddress ? <Row label="Address" value={d.propertyAddress} /> : null}

        <View style={styles.sectionGap} />
        <Row label="Date and time" value={d.viewingWhen} />
        <Row label="Duration" value={d.durationLabel} />

        <View style={styles.sectionGap} />
        <Row label="Agent" value={d.agentName} />
        {contactBits ? <Row label="Contact" value={contactBits} /> : null}

        <Text style={styles.note}>
          This confirms the appointment above. It is not a reservation and does not commit either
          party to a transaction. At the viewing you will be asked to sign a short attendance slip
          recording that this property was shown to you by {d.orgName}.
        </Text>

        <Text style={styles.gdpr}>{d.gdprLine}</Text>

        <Text style={styles.footer}>Generated {d.generatedAtLabel}</Text>
      </Page>
    </Document>
  );
}

export async function renderViewingConfirmationPdf(d: ViewingConfirmationData): Promise<Buffer> {
  registerPdfFonts();
  return renderToBuffer(<ViewingConfirmationDocument {...d} />);
}
