/**
 * Per-viewing calendar file (audit ICS-1). Pure string generation — no
 * external calendar API, which is the whole point: a booked viewing reaches
 * the agent's phone through the one format every calendar app imports.
 *
 * Timestamps are emitted in UTC basis (`...Z`): `scheduled_at` is stored UTC,
 * so DTSTART is a reformat, not a conversion — the calendar app localises.
 * The UID is stable per viewing and METHOD:PUBLISH is set, so re-importing
 * after a reschedule REPLACES the old entry instead of duplicating it.
 */

export interface ViewingIcsInput {
  id: string;
  scheduledAt: string;
  durationMin: number;
  propertyRef: string;
  propertyAddress: string | null;
  contactName: string | null;
  agentName: string | null;
}

/** RFC 5545 text escaping: backslash first, then comma/semicolon/newline. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** 2026-09-01T10:30:00.000Z → 20260901T103000Z */
export function icsUtcStamp(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * RFC 5545 §3.1: lines longer than 75 octets SHOULD be folded with
 * CRLF + one space. Folding by code unit is fine here — the inputs are
 * short identifiers and names, and every calendar client unfolds leniently.
 */
export function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) {
    parts.push(" " + line.slice(i, i + 74));
  }
  return parts.join("\r\n");
}

export function buildViewingIcs(v: ViewingIcsInput, now: Date = new Date()): string {
  const start = new Date(v.scheduledAt);
  const end = new Date(start.getTime() + v.durationMin * 60_000);

  const summary = `Viewing: ${v.propertyRef}${v.contactName ? ` — ${v.contactName}` : ""}`;
  const description = [
    v.contactName ? `Attendee: ${v.contactName}` : null,
    v.agentName ? `Agent: ${v.agentName}` : null,
    `Reference: ${v.propertyRef}`,
  ]
    .filter(Boolean)
    .join("\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//gnk-crm//viewings//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:viewing-${v.id}@gnk-crm`,
    `DTSTAMP:${icsUtcStamp(now)}`,
    `DTSTART:${icsUtcStamp(start)}`,
    `DTEND:${icsUtcStamp(end)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    ...(v.propertyAddress ? [`LOCATION:${escapeIcsText(v.propertyAddress)}`] : []),
    `DESCRIPTION:${escapeIcsText(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
