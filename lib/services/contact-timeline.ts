import type { Json } from "@/lib/supabase/database.types";

/**
 * The `note` each line of a contact's combined timeline carries (DECISIONS
 * T2.3): events of a contact merged into this one are labelled with that
 * contact's name, and a `merged` event is named after the duplicate it
 * absorbed. Both names come from the ROWS the page read — the `contacts` row
 * is where a name lives, and erasure can reach it; the hash-chained event
 * cannot be (audit SEC-03, DECISIONS T-merged-event-ids-only).
 *
 * A `merged` event written before 2026-09-23 carries `merged_contact_name`
 * and its line already prints it, so it gets no second copy.
 *
 * ONLY A CONTACT'S EVENT CAN COME FROM A MERGED CONTACT. Since A06 the feed
 * also carries the person's leads, deals and viewings, whose `entity_id` is
 * never this contact's — "any other id is a merged duplicate" would have
 * labelled every call logged on the lead "merged contact". An event with no
 * `entity_type` is read as a contact's, which is what every caller passed
 * before the feed was combined.
 */
export function annotateContactTimeline<
  E extends {
    entity_type?: string;
    entity_id: string | null;
    event_type: string;
    payload: Json;
    note?: string | null;
  },
>(
  events: E[],
  contactId: string,
  mergedRows: { id: string; display_name: string | null }[],
): E[] {
  const nameOf = new Map(mergedRows.map((m) => [m.id, m.display_name]));
  const join = (...parts: (string | null | undefined)[]) =>
    parts.filter(Boolean).join(" · ") || null;

  return events.map((e) => {
    const isContactEvent = e.entity_type === undefined || e.entity_type === "contact";
    // the merged-away source's name, and/or the conversation note the reader attached (0094)
    if (isContactEvent && e.entity_id !== contactId) {
      return { ...e, note: join(nameOf.get(e.entity_id ?? "") ?? "merged contact", e.note) };
    }
    if (!isContactEvent) return { ...e, note: e.note ?? null };
    const p =
      e.payload && typeof e.payload === "object" && !Array.isArray(e.payload)
        ? (e.payload as Record<string, unknown>)
        : {};
    if (e.event_type === "merged" && !p.merged_contact_name && typeof p.merged_contact_id === "string") {
      return { ...e, note: join(nameOf.get(p.merged_contact_id), e.note) };
    }
    return { ...e, note: e.note ?? null };
  });
}
