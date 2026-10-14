import { NextResponse } from "next/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { buildViewingIcs } from "@/lib/services/viewing-ics";
import { createClient } from "@/lib/supabase/server";
import { isGuid } from "@/lib/validators/ids";

/**
 * Per-viewing calendar file (audit ICS-1). RLS scopes the select to the
 * caller's org, so the route needs no extra gate; the file is derived data,
 * so no export event is logged (the getSlipDownloadUrl precedent — the
 * logListExport audit is reserved for bulk list exports).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // a segment that is not an id names no viewing: the same 404 as a missing
  // one, before any query (T-malformed-ids; it answered 400 before)
  if (!isGuid(id)) {
    return NextResponse.json({ error: "Viewing not found" }, { status: 404 });
  }

  const supabase = await createClient();
  await getCurrentProfile(supabase);

  const { data: v } = await supabase
    .from("viewings")
    .select(
      `id, scheduled_at, duration_min,
       properties(reference, address),
       contacts(display_name),
       agent:profiles!agent_id(full_name)`,
    )
    .eq("id", id)
    .maybeSingle();
  if (!v) {
    return NextResponse.json({ error: "Viewing not found" }, { status: 404 });
  }

  const property = v.properties as { reference: string; address: string | null } | null;
  const ics = buildViewingIcs({
    id: v.id,
    scheduledAt: v.scheduled_at,
    durationMin: v.duration_min,
    propertyRef: property?.reference ?? "viewing",
    propertyAddress: property?.address ?? null,
    contactName: (v.contacts as { display_name: string | null } | null)?.display_name ?? null,
    agentName: (v.agent as { full_name: string } | null)?.full_name ?? null,
  });

  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="viewing-${property?.reference ?? v.id}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
