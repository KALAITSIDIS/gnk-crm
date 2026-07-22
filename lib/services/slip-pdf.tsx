import "server-only";
import React from "react";
import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import { PDF_FONT, registerPdfFonts } from "@/lib/services/pdf-fonts";

export interface SlipPdfData {
  orgName: string;
  agentName: string;
  signerName: string;
  propertyRef: string;
  propertyAddress: string | null;
  viewingWhen: string;
  gdprLine: string;
  /** data:image/png;base64,… drawn on a white background */
  signatureDataUrl: string;
  signedAtLabel: string;
  sha256: string;
}

// Noto Sans, not Helvetica: attendee/agent names and addresses are routinely
// Greek or Cyrillic (see pdf-fonts.ts). Courier stays for the hex digest only.
const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 11, color: "#1a1a1a", fontFamily: PDF_FONT },
  org: { fontSize: 16, fontFamily: PDF_FONT, fontWeight: 700 },
  title: { fontSize: 13, marginTop: 4, marginBottom: 20, color: "#555" },
  row: { flexDirection: "row", marginBottom: 8 },
  label: { width: 130, color: "#777", fontFamily: PDF_FONT, fontWeight: 700 },
  value: { flex: 1 },
  gdpr: {
    marginTop: 18,
    marginBottom: 18,
    padding: 10,
    fontSize: 9,
    color: "#555",
    backgroundColor: "#f4f4f5",
    lineHeight: 1.4,
  },
  sigLabel: { fontSize: 9, color: "#777", marginBottom: 4, fontFamily: PDF_FONT, fontWeight: 700 },
  sig: {
    width: 260,
    height: 120,
    border: "1 solid #ddd",
    objectFit: "contain",
    backgroundColor: "#fff",
  },
  signer: { marginTop: 6, fontSize: 11, fontFamily: PDF_FONT, fontWeight: 700 },
  footer: { position: "absolute", bottom: 40, left: 48, right: 48, fontSize: 8, color: "#999" },
  // NOT Courier — standard-14 fonts embed without a ToUnicode CMap, so the
  // signature digest could not be copied or searched out of the slip.
  hash: { fontFamily: PDF_FONT, marginTop: 2, letterSpacing: 0.3 },
});

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function SlipDoc({ d }: { d: SlipPdfData }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.org}>{d.orgName}</Text>
        <Text style={styles.title}>Viewing Confirmation Slip</Text>

        <Field label="Agent" value={d.agentName} />
        <Field label="Attendee" value={d.signerName} />
        <Field label="Property" value={d.propertyRef} />
        {d.propertyAddress ? <Field label="Address" value={d.propertyAddress} /> : null}
        <Field label="Viewing" value={d.viewingWhen} />

        <Text style={styles.gdpr}>{d.gdprLine}</Text>

        <Text style={styles.sigLabel}>SIGNATURE</Text>
        {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt prop */}
        <Image style={styles.sig} src={d.signatureDataUrl} />
        <Text style={styles.signer}>{d.signerName}</Text>

        <View style={styles.footer}>
          <Text>Signed: {d.signedAtLabel}</Text>
          <Text style={styles.hash}>SHA-256: {d.sha256}</Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderSlipPdf(d: SlipPdfData): Promise<Buffer> {
  registerPdfFonts();
  return renderToBuffer(<SlipDoc d={d} />);
}
