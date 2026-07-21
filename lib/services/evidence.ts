import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { describeEvent } from "@/lib/services/events";
import { sha256Hex } from "@/lib/services/hash";
import { zonedDateRangeToUtc } from "@/lib/utils/tz";

/**
 * Commission evidence assembly (T5.2, doc 02 §C6): the chronological,
 * hash-chain-verified activity record for one contact, optionally narrowed to
 * a property, a deal, and/or a Cyprus-local date range. Shared by the
 * on-screen preview and the PDF.
 *
 * Deal narrowing (doc 05 "contact + optional property/deal"): the deal filter
 * pins deals/offers to that one deal; viewings, leads and property events
 * narrow through the deal's property (viewings carry no deal_id — when the
 * deal has no property, they drop out entirely rather than guessing).
 */

type Client = SupabaseClient<Database>;

/** Hard cap per entity family; hitting it flags the report as truncated. */
export const EVENTS_PER_FAMILY = 500;

/** Property-media churn excluded from the report when a property is in scope. */
const MEDIA_NOISE = "(media_uploaded,media_deleted,media_reordered,media_cover_set)";

export interface EvidenceRow {
  /** events.id — global insertion (chain) order. Tiebreak only; NOT hashed. */
  id: number;
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

/**
 * "skipped" = verification not run (preview). The generate action always runs
 * it, so a stored PDF only ever carries "verified" or "failed" — and an RPC
 * error refuses generation instead of masquerading as "failed".
 */
export type ChainStatus = "verified" | "failed" | "skipped";

/**
 * Assembly failures are returned as i18n keys (under reports.evidence.errors)
 * rather than prose, so the preview page and the generate action can render
 * them in the caller's language. `message` carries an untranslatable detail
 * (e.g. a Postgres error) for the keys that interpolate one.
 */
export interface EvidenceFailure {
  errorKey: "contactNotFound" | "dealNotFound" | "chainUnavailable";
  message?: string;
}

export interface EvidenceData {
  orgName: string;
  /** who assembled it — printed on the PDF so partial (agent) scope is explicit */
  generatedBy: { name: string; role: string };
  contact: { id: string; name: string; phone: string | null; email: string | null };
  filter: {
    propertyRef: string | null;
    dealTitle: string | null;
    from: string | null;
    to: string | null;
  };
  rows: EvidenceRow[];
  slips: EvidenceSlip[];
  deals: EvidenceDeal[];
  chain: ChainStatus;
  /** true when any entity family hit EVENTS_PER_FAMILY — the record is incomplete */
  truncated: boolean;
  reportHash: string;
}

/**
 * Oldest-first ordering — the evidence narrative reads forward in time.
 * Timestamp ties break on events.id (insertion order = hash-chain order), so
 * the row order — and with it the report hash — is reproducible.
 */
export function sortChronological<T extends { occurredAt: string; id: number }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0) || a.id - b.id,
  );
}

/**
 * Deterministic content hash printed in the report footer: SHA-256 over the
 * canonical JSON of the rows. Recomputable by regenerating with the same
 * filters — NOT the hash of the PDF file (which contains this hash). The
 * event id is deliberately excluded so hashes of previously stored reports
 * stay recomputable.
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
  dealId?: string;
  /** Cyprus-local dates (YYYY-MM-DD), inclusive */
  from?: string;
  to?: string;
  /** fetch slip PNGs as data URIs (PDF only — preview skips the downloads) */
  withSlipImages?: boolean;
  /** run the org-wide chain RPC (generation only — it walks every org event) */
  verifyChain?: boolean;
  /** the acting user — printed on the report */
  generatedBy: { name: string; role: string };
}

/**
 * Assemble the evidence set. `supabase` is the caller's RLS-scoped client —
 * whatever it cannot see stays out of the report (and the PDF says whose view
 * it is). `admin` is used only for slip PNG downloads (private bucket) and
 * the chain check RPC.
 */
export async function assembleEvidence(
  supabase: Client,
  admin: Client,
  orgId: string,
  opts: AssembleOptions,
): Promise<EvidenceData | EvidenceFailure> {
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, display_name, phone_e164, email")
    .eq("id", opts.contactId)
    .maybeSingle();
  if (!contact) return { errorKey: "contactNotFound" };

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", orgId)
    .maybeSingle();

  // related entities (optionally narrowed to one property and/or one deal)
  let dealsQ = supabase
    .from("deals")
    .select("id, title, status, expected_value, commission_split_notes, property_id")
    .or(`buyer_contact_id.eq.${opts.contactId},seller_contact_id.eq.${opts.contactId}`);
  if (opts.propertyId) dealsQ = dealsQ.eq("property_id", opts.propertyId);
  if (opts.dealId) dealsQ = dealsQ.eq("id", opts.dealId);
  const { data: deals } = await dealsQ;
  if (opts.dealId && (deals ?? []).length === 0) {
    return { errorKey: "dealNotFound" };
  }

  // property scope: an explicit property filter, else the filtered deal's
  // property. A deal with no property gives viewings/leads nothing to narrow
  // through, so they drop out (narrowed to none) rather than guessing.
  const dealProperty = opts.dealId ? (deals?.[0]?.property_id ?? null) : null;
  const scopePropertyId = opts.propertyId ?? dealProperty ?? undefined;
  const narrowed = Boolean(opts.propertyId || opts.dealId);

  let viewingsQ = supabase
    .from("viewings")
    .select("id, property_id")
    .eq("contact_id", opts.contactId);
  if (scopePropertyId) viewingsQ = viewingsQ.eq("property_id", scopePropertyId);
  const { data: viewings } =
    narrowed && !scopePropertyId ? { data: [] } : await viewingsQ;

  const { data: offers } = await supabase
    .from("offers")
    .select("id, deal_id")
    .eq("contact_id", opts.contactId);
  const dealIds = new Set((deals ?? []).map((d) => d.id));
  const offerRows = (offers ?? []).filter((o) => !narrowed || dealIds.has(o.deal_id));

  let leadsQ = supabase.from("leads").select("id, property_id").eq("contact_id", opts.contactId);
  if (scopePropertyId) leadsQ = leadsQ.eq("property_id", scopePropertyId);
  const { data: leads } = narrowed && !scopePropertyId ? { data: [] } : await leadsQ;

  // events per entity family (merged + sorted after). A property/deal filter
  // swaps the contact-level rows for the scope property's own history (price
  // changes and legal/status events strengthen the narrative; media churn
  // stays out).
  const families: { type: string; ids: string[] }[] = [
    { type: "contact", ids: narrowed ? [] : [opts.contactId] },
    { type: "property", ids: scopePropertyId ? [scopePropertyId] : [] },
    { type: "deal", ids: (deals ?? []).map((d) => d.id) },
    { type: "viewing", ids: (viewings ?? []).map((v) => v.id) },
    { type: "offer", ids: offerRows.map((o) => o.id) },
    { type: "lead", ids: (leads ?? []).map((l) => l.id) },
  ];

  const bounds = zonedDateRangeToUtc(opts.from, opts.to);
  const eventBatches = await Promise.all(
    families
      .filter((f) => f.ids.length > 0)
      .map(async (f) => {
        let q = supabase
          .from("events")
          .select("id, occurred_at, entity_type, entity_id, event_type, actor_id, payload")
          .eq("entity_type", f.type)
          .in("entity_id", f.ids)
          .order("occurred_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(EVENTS_PER_FAMILY);
        if (f.type === "property") q = q.not("event_type", "in", MEDIA_NOISE);
        if (bounds.gte) q = q.gte("occurred_at", bounds.gte);
        if (bounds.lt) q = q.lt("occurred_at", bounds.lt);
        const { data } = await q;
        return data ?? [];
      }),
  );
  const events = eventBatches.flat();
  const truncated = eventBatches.some((b) => b.length === EVENTS_PER_FAMILY);

  // property refs for rows (deal/viewing/lead/offer/property → property)
  const propertyByEntity = new Map<string, string>();
  for (const d of deals ?? []) if (d.property_id) propertyByEntity.set(d.id, d.property_id);
  for (const v of viewings ?? []) if (v.property_id) propertyByEntity.set(v.id, v.property_id);
  for (const l of leads ?? []) if (l.property_id) propertyByEntity.set(l.id, l.property_id);
  const dealPropById = new Map((deals ?? []).map((d) => [d.id, d.property_id]));
  for (const o of offerRows) {
    const p = dealPropById.get(o.deal_id);
    if (p) propertyByEntity.set(o.id, p);
  }
  if (scopePropertyId) propertyByEntity.set(scopePropertyId, scopePropertyId);

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
      id: e.id,
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
      actorName: e.actor_id ? (actorById.get(e.actor_id) ?? null) : "system",
    })),
  );

  // signed slips for in-scope viewings, kept consistent with the date filter
  const viewingIds = (viewings ?? []).map((v) => v.id);
  const { data: slipRows } = viewingIds.length
    ? await supabase
        .from("viewing_slips")
        .select("viewing_id, signer_name, signed_at, signature_sha256, signature_path")
        .in("viewing_id", viewingIds)
    : { data: [] };
  const fromMs = bounds.gte ? Date.parse(bounds.gte) : -Infinity;
  const toMs = bounds.lt ? Date.parse(bounds.lt) : Infinity;
  const slipRowsInScope = (slipRows ?? []).filter((s) => {
    const t = Date.parse(s.signed_at);
    return t >= fromMs && t < toMs;
  });

  const slips: EvidenceSlip[] = [];
  for (const s of slipRowsInScope) {
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

  // Org-wide chain walk — generation only. An RPC failure must not be
  // printable as "chain FAILED", so it refuses assembly instead.
  let chain: ChainStatus = "skipped";
  if (opts.verifyChain) {
    const res = await admin.rpc("verify_events_chain", { p_org: orgId });
    if (res.error) {
      return { errorKey: "chainUnavailable", message: res.error.message };
    }
    chain = res.data === true ? "verified" : "failed";
  }

  return {
    orgName: org?.name ?? "Agency",
    generatedBy: opts.generatedBy,
    contact: {
      id: contact.id,
      name: contact.display_name ?? "Unnamed",
      phone: contact.phone_e164,
      email: contact.email,
    },
    filter: {
      propertyRef: opts.propertyId ? (refById.get(opts.propertyId) ?? opts.propertyId) : null,
      dealTitle: opts.dealId ? (deals?.[0]?.title ?? opts.dealId) : null,
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
    chain,
    truncated,
    reportHash: reportContentHash(rows),
  };
}
