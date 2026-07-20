import Link from "next/link";
import { ArrowLeft, Info, TriangleAlert } from "lucide-react";
import { EvidenceBuilder } from "@/components/features/reports/evidence-builder";
import { getCurrentProfile } from "@/lib/services/auth";
import { assembleEvidence } from "@/lib/services/evidence";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime, formatMoney } from "@/lib/utils/format";
import type { EntityOption } from "@/lib/actions/entity-search";

export const dynamic = "force-dynamic";

const isGuid = (v: string | undefined): v is string =>
  Boolean(v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
const isDate = (v: string | undefined): v is string => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

export default async function CommissionEvidencePage({
  searchParams,
}: {
  searchParams: Promise<{ contact?: string; property?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const contactId = isGuid(params.contact) ? params.contact : undefined;
  const propertyId = isGuid(params.property) ? params.property : undefined;
  const from = isDate(params.from) ? params.from : undefined;
  const to = isDate(params.to) ? params.to : undefined;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  let initialContact: EntityOption | null = null;
  let initialProperty: EntityOption | null = null;
  let preview: Awaited<ReturnType<typeof assembleEvidence>> | null = null;

  if (contactId) {
    const admin = createAdminClient();
    preview = await assembleEvidence(supabase, admin, profile.orgId, {
      contactId,
      propertyId,
      from,
      to,
      withSlipImages: false, // preview stays light; the PDF embeds the PNGs
      verifyChain: false, // the org-wide chain walk runs on generation only
      generatedBy: { name: profile.fullName, role: profile.role },
    });
    if (!("error" in preview)) {
      initialContact = {
        id: contactId,
        label: preview.contact.name,
        sublabel: preview.contact.phone ?? preview.contact.email,
      };
      if (propertyId) {
        initialProperty = {
          id: propertyId,
          label: preview.filter.propertyRef ?? propertyId,
          sublabel: null,
        };
      }
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link
          href="/reports"
          className="mb-2 inline-flex items-center gap-1 text-sm text-text-2 hover:text-text-1"
        >
          <ArrowLeft className="size-4" /> Reports
        </Link>
        <h1 className="text-xl font-semibold text-text-1">Commission evidence</h1>
        <p className="text-sm text-text-2">
          Pick a contact, preview the chronological record, then generate the stored PDF.
        </p>
      </div>

      <EvidenceBuilder
        initialContact={initialContact}
        initialProperty={initialProperty}
        from={from ?? ""}
        to={to ?? ""}
      />

      {preview && "error" in preview ? (
        <p className="text-sm text-danger">{preview.error}</p>
      ) : null}

      {preview && !("error" in preview) ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2 rounded-[10px] border border-border bg-surface px-4 py-3 text-sm text-text-2">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              Preview — the hash chain is verified when the PDF is generated. {preview.rows.length}{" "}
              events · report hash{" "}
              <span className="font-mono text-xs">{preview.reportHash.slice(0, 16)}…</span>
              {profile.role !== "admin"
                ? " · Scope: events visible to you — other staff or system activity may be absent."
                : ""}
            </span>
          </div>

          {preview.truncated ? (
            <div className="flex items-start gap-2 rounded-[10px] border border-danger/30 bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              This preview is incomplete — one event category hit its cap. Narrow the date range;
              generation is refused until the record fits.
            </div>
          ) : null}

          <section className="overflow-x-auto rounded-[10px] border border-border bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
                  <th className="px-4 py-2">Timestamp</th>
                  <th className="px-4 py-2">Event</th>
                  <th className="px-4 py-2">Property</th>
                  <th className="px-4 py-2">Actor</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i} className="border-b border-border/60 align-top">
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-text-2">
                      {formatDateTime(r.occurredAt)}
                    </td>
                    <td className="px-4 py-2 text-text-1">{r.line}</td>
                    <td className="px-4 py-2 font-mono text-xs text-text-2">
                      {r.propertyRef ?? ""}
                    </td>
                    <td className="px-4 py-2 text-text-2">{r.actorName ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {preview.slips.length > 0 ? (
            <section className="rounded-[10px] border border-border bg-surface p-5">
              <h2 className="mb-2 text-sm font-semibold text-text-1">
                Signed slips in scope ({preview.slips.length})
              </h2>
              <ul className="flex flex-col gap-1 text-sm text-text-2">
                {preview.slips.map((s) => (
                  <li key={s.viewingId}>
                    {s.propertyRef ? `${s.propertyRef} — ` : ""}
                    {s.signerName}, {formatDateTime(s.signedAt)}{" "}
                    <span className="font-mono text-xs text-text-3">
                      {s.sha256.slice(0, 16)}…
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {preview.deals.length > 0 ? (
            <section className="rounded-[10px] border border-border bg-surface p-5">
              <h2 className="mb-2 text-sm font-semibold text-text-1">
                Deals &amp; commission notes
              </h2>
              <ul className="flex flex-col gap-2 text-sm">
                {preview.deals.map((d, i) => (
                  <li key={i}>
                    <span className="font-medium text-text-1">
                      {d.title} — {d.status}
                      {d.expectedValue !== null ? ` — ${formatMoney(d.expectedValue)}` : ""}
                    </span>
                    <span className="block text-text-2">
                      {d.commissionNotes ?? "No commission notes recorded."}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
