import { PrintButton } from "@/components/features/viewings/print-button";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils/format";
import { zonedParts } from "@/lib/utils/tz";

export const dynamic = "force-dynamic";

/**
 * Printable day sheet (T4.4): the saved route for a date, in visiting order —
 * refs, addresses, times, contacts. Lives in the chromeless (print) group;
 * auth still applies via proxy.ts.
 */
export default async function RouteSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date: raw } = await searchParams;
  const now = new Date();
  const date = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : zonedParts(now).dayKey;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", profile.orgId)
    .maybeSingle();

  const { data: rows } = await supabase
    .from("viewings")
    .select(
      `id, scheduled_at, duration_min, status, route_order,
       properties(reference, address),
       contacts(display_name, phone_e164),
       agent:profiles!agent_id(full_name)`,
    )
    .eq("route_date", date)
    .neq("status", "cancelled")
    .order("route_order", { ascending: true });

  const stops = (rows ?? []).map((r) => ({
    id: r.id,
    order: r.route_order,
    time: zonedParts(r.scheduled_at).timeLabel,
    durationMin: r.duration_min,
    reference: (r.properties as { reference: string; address: string | null } | null)?.reference ?? "—",
    address: (r.properties as { reference: string; address: string | null } | null)?.address ?? "—",
    contact: (r.contacts as { display_name: string | null; phone_e164: string | null } | null),
    agent: (r.agent as { full_name: string } | null)?.full_name ?? "—",
  }));

  return (
    <div className="mx-auto w-full max-w-3xl bg-white p-8 text-text-1 print:p-0">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{org?.name ?? "Agency"} — Viewing day sheet</h1>
          <p className="text-sm text-text-2">{formatDate(date)}</p>
        </div>
        <PrintButton />
      </div>

      {stops.length === 0 ? (
        <p className="text-sm text-text-2">
          No route saved for this date. Build one from Viewings → Route.
        </p>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b-2 border-border text-left text-xs uppercase tracking-wide text-text-3">
              <th className="py-2 pr-3">#</th>
              <th className="py-2 pr-3">Time</th>
              <th className="py-2 pr-3">Reference</th>
              <th className="py-2 pr-3">Address</th>
              <th className="py-2 pr-3">Contact</th>
              <th className="py-2">Agent</th>
            </tr>
          </thead>
          <tbody>
            {stops.map((s, i) => (
              <tr key={s.id} className="border-b border-border align-top">
                <td className="py-2 pr-3 font-semibold tabular-nums">{s.order ?? i + 1}</td>
                <td className="py-2 pr-3 tabular-nums">
                  {s.time}
                  <span className="ml-1 text-xs text-text-3">{s.durationMin}m</span>
                </td>
                <td className="py-2 pr-3 font-mono text-xs">{s.reference}</td>
                <td className="py-2 pr-3">{s.address}</td>
                <td className="py-2 pr-3">
                  {s.contact?.display_name ?? "—"}
                  {s.contact?.phone_e164 ? (
                    <span className="block text-xs tabular-nums text-text-3">
                      {s.contact.phone_e164}
                    </span>
                  ) : null}
                </td>
                <td className="py-2">{s.agent}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="mt-6 text-xs text-text-3">
        Generated {formatDate(now)} · statuses at print time; cancelled viewings excluded.
      </p>
    </div>
  );
}
