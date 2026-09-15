import { LeadRoutingPanel } from "@/components/features/settings/lead-routing-panel";
import { getCurrentProfile } from "@/lib/services/auth";
import { readLeadRouting } from "@/lib/services/lead-routing";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Settings → Lead routing (0098, audit LR-05).
 *
 * Reads the `lead_routing` row through `readLeadRouting`, which applies the
 * SAME fallback rules the enquiry door applies in SQL — so what this page
 * shows is what a website lead will actually get, including when the row is
 * missing or somebody has put nonsense in it via the raw JSON editor.
 *
 * Only admins and agents can be routed to: a listing manager cannot work a
 * lead (doc 04), so offering one here would route enquiries to a person who
 * cannot open them.
 */
export default async function LeadRoutingSettingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // pages render in parallel with the layout's admin gate — stop here too
  if (profile.role !== "admin") return null;

  const [{ data: row }, { data: members }] = await Promise.all([
    supabase.from("cyprus_config").select("value").eq("key", "lead_routing").maybeSingle(),
    supabase
      .from("profiles")
      .select("id, full_name, role, is_active")
      .in("role", ["admin", "agent"])
      .order("is_active", { ascending: false })
      .order("full_name", { ascending: true }),
  ]);

  return <LeadRoutingPanel value={readLeadRouting(row?.value ?? null)} members={members ?? []} />;
}
