import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { describeEvent } from "@/lib/services/events";
import { sha256Hex } from "@/lib/services/hash";

/**
 * Commission evidence assembly (T5.2, doc 02 §C6): the chronological,
 * hash-chain-verified activity record for one contact, optionally narrowed to
 * a property and/or date range. Shared by the on-screen preview and the PDF.
 */

type Client = SupabaseClient<Database>;

export interface EvidenceRow {
  occurredAt: string;
  entityType: string;
  line: string;
  propertyRef: string | null;
  actorName: string | null;
}

export interface EvidenceSlip {
  viewingId: string;
  signerName: string;
  signedAt: string;
  sha256: string;
  propertyRef: string | null;
  /** data:image/png;base64,… — only populated for the PDF (heavy) */
  pngDataUri: string | null;
}

export interface EvidenceDeal {
  title: string;
  status: string;
  expectedValue: number | null;
  commissionNotes: string | null;
}

export interface EvidenceData {
  orgName: string;
  contact: { id: string; name: string; phone: string | null; email: string | null };
  filter: { propertyRef: string | null; from: string | null; to: string | null };
  rows: EvidenceRow[];
  slips: EvidenceSlip[];
  deals: EvidenceDeal[];
  chainOk: boolean;
  reportHash: string;
}

/** Oldest-first ordering — the evidence narrative reads forward in time. */
export function sortChronological<T extends { occurredAt: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
}

/**
 * Deterministic content hash printed in the report footer: SHA-256 over the
 * canonical JSON of the rows. Recomputable by regenerating with the same
 * filters — NOT the hash of the PDF file (which contains this hash).
 */
export function reportContentHash(rows: EvidenceRow[]): string {
  const canonical = rows.map((r) => [
    r.occurredAt,
    r.entityType,
    r.line,
    r.propertyRef ?? "",
    r.actorName ?? "",
  ]);
  return sha256Hex(Buffer.from(JSON.stringify(canonical)));
}

export interface AssembleOptions {
  contactId: string;
  propertyId?: string;
  /** ISO dates (YYYY-MM-DD), inclusive */
  from?: string;
  to?: string;
  /** fetch slip PNGs as data URIs (PDF only — preview skips the downloads) */
  withSlipImages?: boolean;
}

/**
 * Assemble the evidence set. `supabase` is the caller's RLS-scoped client —
 * whatever it cannot see stays out of the report. `admin` is used only for
 * slip PNG downloads (private bucket) and the chain check RPC.
 */
export async function assembleEvidence(
  supabase: Client,
  admin: Client,
  orgId: string,
  opts: AssembleOptions,
): Promise<EvidenceData | { error: string }> {
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, display_name, phone_e164, email")
    .eq("id", opts.contactId)
    .maybeSingle();
  if (!contact) return { error: "Contact not found" };

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", orgId)
    .maybeSingle();

  // related entities (optionally narrowed to one property)
  let dealsQ = supabase
    .from("deals")
    .select("id, title, status, expected_value, commission_split_notes, property_id")
    .or(`buyer_contact_id.eq.${opts.contactId},seller_contact_id.eq.${opts.contactId}`);
  if (opts.propertyId) dealsQ = dealsQ.eq("property_id", opts.propertyId);
  const { data: deals } = await dealsQ;

  let viewingsQ = supabase
    .from("viewings")
    .select("id, property_id")
    .eq("contact_id", opts.contactId);
  if (opts.propertyId) viewingsQ = viewingsQ.eq("property_id", opts.propertyId);
  const { data: viewings } = await viewingsQ;

  const { data: offers } = await supabase
    .from("offers")
    .select("id, deal_id")
    .eq("contact_id", opts.contactId);
  const dealIds = new Set((deals ?? []).map((d) => d.id));
  const offerRows = (offers ?? []).filter((o) => !opts.propertyId || dealIds.has(o.deal_id));

  let leadsQ = supabase.from("leads").select("id").eq("contact_id", opts.contactId);
  if (opts.propertyId) leadsQ = leadsQ.eq("property_id", opts.propertyId);
  const { data: leads } = await leadsQ;

  // events per entity family (merged + sorted after)
  const families: { type: string; ids: string[] }[] = [
    { type: "contact", ids: opts.propertyId ? [] : [opts.contactId] },
    { type: "deal", ids: (deals ?? []).map((d) => d.id) },
    { type: "viewing", ids: (viewings ?? []).map((v) => v.id) },
    { type: "offer", ids: offerRows.map((o) => o.id) },
    { type: "lead", ids: (leads ?? []).map((l) => l.id) },
  ];

  const eventBatches = await Promise.all(
    families
      .filter((f) => f.ids.length > 0)
      .map(async (f) => {
        let q = supabase
          .from("events")
          .select("occurred_at, entity_type, entity_id, event_type, actor_id, payload")
          .eq("entity_type", f.type)
          .in("entity_id", f.ids)
          .order("occurred_at", { ascending: true })
          .limit(500);
        if (opts.from) q = q.gte("occurred_at", `${opts.from}T00:00:00Z`);
        if (opts.to) q = q.lte("occurred_at", `${opts.to}T23:59:59Z`);
        const { data } = await q;
        return data ?? [];
      }),
  );
  const events = eventBatches.flat();

  // property refs for rows (deal/viewing → property)
  const propertyByEntity = new Map<string, string>();
  for (const d of deals ?? []) if (d.property_id) propertyByEntity.set(d.id, d.property_id);
  for (const v of viewings ?? []) if (v.property_id) propertyByEntity.set(v.id, v.property_id);
  const propertyIds = [...new Set(propertyByEntity.values())];
  const { data: props } = propertyIds.length
    ? await supabase.from("properties").select("id, reference").in("id", propertyIds)
    : { data: [] };
  const refById = new Map((props ?? []).map((p) => [p.id, p.reference]));

  const actorIds = [...new Set(events.map((e) => e.actor_id).filter(Boolean))] as string[];
  const { data: actors } = actorIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", actorIds)
    : { data: [] };
  const actorById = new Map((actors ?? []).map((a) => [a.id, a.full_name]));

  const rows: EvidenceRow[] = sortChronological(
    events.map((e) => ({
      occurredAt: e.occurred_at,
      entityType: e.entity_type,
      line: describeEvent({
        entity_type: e.entity_type,
        event_type: e.event_type,
        payload: e.payload as Json,
      }),
      propertyRef: e.entity_id
        ? (refById.get(propertyByEntity.get(e.entity_id) ?? "") ?? null)
        : null,
      actorName: e.actor_id ? (actorById.get(e.actor_id) ?? null) : (e.actor_id === null ? "system" : null),
    })),
  );

  // signed slips for in-scope viewings
  const viewingIds = (viewings ?? []).map((v) => v.id);
  const { data: slipRows } = viewingIds.length
    ? await supabase
        .from("viewing_slips")
        .select("viewing_id, signer_name, signed_at, signature_sha256, signature_path")
        .in("viewing_id", viewingIds)
    : { data: [] };

  const slips: EvidenceSlip[] = [];
  for (const s of slipRows ?? []) {
    let pngDataUri: string | null = null;
    if (opts.withSlipImages) {
      const { data: file } = await admin.storage.from("signatures").download(s.signature_path);
      if (file) {
        const buf = Buffer.from(await file.arrayBuffer());
        pngDataUri = `data:image/png;base64,${buf.toString("base64")}`;
      }
    }
    const viewing = (viewings ?? []).find((v) => v.id === s.viewing_id);
    slips.push({
      viewingId: s.viewing_id,
      signerName: s.signer_name,
      signedAt: s.signed_at,
      sha256: s.signature_sha256,
      propertyRef: viewing?.property_id ? (refById.get(viewing.property_id) ?? null) : null,
      pngDataUri,
    });
  }

  const chain = await admin.rpc("verify_events_chain", { p_org: orgId });

  return {
    orgName: org?.name ?? "Agency",
    contact: {
      id: contact.id,
      name: contact.display_name ?? "Unnamed",
      phone: contact.phone_e164,
      email: contact.email,
    },
    filter: {
      propertyRef: opts.propertyId ? (refById.get(opts.propertyId) ?? opts.propertyId) : null,
      from: opts.from ?? null,
      to: opts.to ?? null,
    },
    rows,
    slips,
    deals: (deals ?? []).map((d) => ({
      title: d.title,
      status: d.status,
      expectedValue: d.expected_value === null ? null : Number(d.expected_value),
      commissionNotes: d.commission_split_notes,
    })),
    chainOk: chain.data === true,
    reportHash: reportContentHash(rows),
  };
}
