import { LeadEscalationPanel } from "@/components/features/settings/lead-escalation-panel";
import { getCurrentProfile } from "@/lib/services/auth";
import { readLeadEscalation } from "@/lib/services/lead-escalation";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Settings → Lead escalation (0107, audit 2026-09-22 finding 3).
 *
 * Reads the `lead_escalation` row through `readLeadEscalation`, which applies
 * the SAME fallback rules `public.lead_escalation_config()` applies in SQL —
 * so what this page shows is what the five-minute sweep will actually do,
 * including when the row is missing or somebody has put nonsense in it via
 * the raw JSON editor.
 *
 * Only admins and agents can be told: a listing manager cannot work a lead
 * (doc 04), so offering one here would chase a person who cannot open it.
 */
export default async function LeadEscalationSettingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // pages render in parallel with the layout's admin gate — stop here too
  if (profile.role !== "admin") return null;

  const [{ data: row }, { data: members }] = await Promise.all([
    supabase.from("cyprus_config").select("value").eq("key", "lead_escalation").maybeSingle(),
    supabase
      .from("profiles")
      .select("id, full_name, role, is_active")
      .in("role", ["admin", "agent"])
      .order("is_active", { ascending: false })
      .order("full_name", { ascending: true }),
  ]);

  return <LeadEscalationPanel value={readLeadEscalation(row?.value ?? null)} members={members ?? []} />;
}
