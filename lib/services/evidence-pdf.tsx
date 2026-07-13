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
import type { EvidenceData } from "@/lib/services/evidence";
import { formatDateTime, formatMoney } from "@/lib/utils/format";

/**
 * Commission evidence PDF (T5.2, doc 02 §C6): company header, contact
 * identity, chronological event table, signed-slip thumbnails + hashes,
 * deals with manual commission notes, chain-check + report-hash footer.
 */

const styles = StyleSheet.create({
  page: { padding: 40, paddingBottom: 64, fontSize: 9, color: "#1a1a1a", fontFamily: "Helvetica" },
  org: { fontSize: 15, fontFamily: "Helvetica-Bold" },
  title: { fontSize: 11, marginTop: 2, marginBottom: 12, color: "#555" },
  identity: { marginBottom: 4, flexDirection: "row", gap: 6 },
  idLabel: { width: 70, color: "#777", fontFamily: "Helvetica-Bold" },
  chain: { marginTop: 8, marginBottom: 12, padding: 6, fontSize: 9, fontFamily: "Helvetica-Bold" },
  chainOk: { backgroundColor: "#e8f5ee", color: "#166534" },
  chainBad: { backgroundColor: "#fdecec", color: "#991b1b" },
  th: {
    flexDirection: "row",
    borderBottom: "1.5 solid #333",
    paddingBottom: 3,
    marginBottom: 2,
    fontFamily: "Helvetica-Bold",
    color: "#555",
  },
  tr: { flexDirection: "row", borderBottom: "0.5 solid #ddd", paddingVertical: 3 },
  cTime: { width: 105 },
  cEvent: { flex: 1, paddingRight: 6 },
  cProp: { width: 90 },
  cActor: { width: 90 },
  section: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 16, marginBottom: 6 },
  slip: { flexDirection: "row", gap: 10, marginBottom: 10 },
  slipImg: { width: 150, height: 70, border: "1 solid #ddd", objectFit: "contain", backgroundColor: "#fff" },
  slipMeta: { flex: 1, gap: 2 },
  hash: { fontFamily: "Courier", fontSize: 7 },
  dealRow: { marginBottom: 6 },
  dealTitle: { fontFamily: "Helvetica-Bold" },
  footer: {
    position: "absolute",
    bottom: 28,
    left: 40,
    right: 40,
    fontSize: 7,
    color: "#999",
    borderTop: "0.5 solid #ddd",
    paddingTop: 4,
  },
});

function EvidenceDoc({ d, generatedAt }: { d: EvidenceData; generatedAt: string }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.org}>{d.orgName}</Text>
        <Text style={styles.title}>Commission Evidence Report</Text>

        <View style={styles.identity}>
          <Text style={styles.idLabel}>Contact</Text>
          <Text>{d.contact.name}</Text>
        </View>
        {d.contact.phone ? (
          <View style={styles.identity}>
            <Text style={styles.idLabel}>Phone</Text>
            <Text>{d.contact.phone}</Text>
          </View>
        ) : null}
        {d.contact.email ? (
          <View style={styles.identity}>
            <Text style={styles.idLabel}>Email</Text>
            <Text>{d.contact.email}</Text>
          </View>
        ) : null}
        {d.filter.propertyRef ? (
          <View style={styles.identity}>
            <Text style={styles.idLabel}>Property</Text>
            <Text>{d.filter.propertyRef}</Text>
          </View>
        ) : null}
        {d.filter.from || d.filter.to ? (
          <View style={styles.identity}>
            <Text style={styles.idLabel}>Period</Text>
            <Text>
              {d.filter.from ?? "…"} — {d.filter.to ?? "…"}
            </Text>
          </View>
        ) : null}

        <Text style={[styles.chain, d.chainOk ? styles.chainOk : styles.chainBad]}>
          Event hash chain verified: {d.chainOk ? "TRUE" : "FALSE"} (verify_events_chain at
          generation time)
        </Text>

        <View style={styles.th}>
          <Text style={styles.cTime}>Timestamp</Text>
          <Text style={styles.cEvent}>Event</Text>
          <Text style={styles.cProp}>Property</Text>
          <Text style={styles.cActor}>Actor</Text>
        </View>
        {d.rows.map((r, i) => (
          <View key={i} style={styles.tr} wrap={false}>
            <Text style={styles.cTime}>{formatDateTime(r.occurredAt)}</Text>
            <Text style={styles.cEvent}>{r.line}</Text>
            <Text style={styles.cProp}>{r.propertyRef ?? ""}</Text>
            <Text style={styles.cActor}>{r.actorName ?? ""}</Text>
          </View>
        ))}

        {d.slips.length > 0 ? (
          <>
            <Text style={styles.section}>Signed viewing slips</Text>
            {d.slips.map((s) => (
              <View key={s.viewingId} style={styles.slip} wrap={false}>
                {s.pngDataUri ? (
                  // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt prop
                  <Image style={styles.slipImg} src={s.pngDataUri} />
                ) : null}
                <View style={styles.slipMeta}>
                  <Text>
                    {s.propertyRef ? `${s.propertyRef} — ` : ""}signed by {s.signerName} on{" "}
                    {formatDateTime(s.signedAt)}
                  </Text>
                  <Text style={styles.hash}>SHA-256: {s.sha256}</Text>
                </View>
              </View>
            ))}
          </>
        ) : null}

        {d.deals.length > 0 ? (
          <>
            <Text style={styles.section}>Deals &amp; commission notes</Text>
            {d.deals.map((deal, i) => (
              <View key={i} style={styles.dealRow} wrap={false}>
                <Text style={styles.dealTitle}>
                  {deal.title} — {deal.status}
                  {deal.expectedValue !== null ? ` — ${formatMoney(deal.expectedValue)}` : ""}
                </Text>
                <Text>{deal.commissionNotes ?? "No commission notes recorded."}</Text>
              </View>
            ))}
          </>
        ) : null}

        <View style={styles.footer} fixed>
          <Text>
            Generated {generatedAt} · {d.rows.length} events · report hash (SHA-256 of rows):
          </Text>
          <Text style={styles.hash}>{d.reportHash}</Text>
          <Text
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}

export async function renderEvidencePdf(d: EvidenceData, generatedAt: string): Promise<Buffer> {
  return renderToBuffer(<EvidenceDoc d={d} generatedAt={generatedAt} />);
}
