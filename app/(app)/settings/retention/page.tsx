import { RetentionPanel } from "@/components/features/settings/retention-panel";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { summarizeRetention, type RetentionRow } from "@/lib/services/retention";
import { zonedParts } from "@/lib/utils/tz";

export const dynamic = "force-dynamic";

/**
 * Retention-expiry surface (IMPROVEMENTS B11). Closes the other half of the
 * GDPR Art.17 flow: erasure retains KYC records when an AML relationship
 * existed and stamps `retention_until`, and this is where that duty is seen
 * through. Backed by `contacts_retention_idx` (migration 0017), which was
 * created for exactly this query.
 */
export default async function RetentionSettingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // pages render in parallel with the layout's admin gate — stop here too
  if (profile.role !== "admin") return null;

  const { data, error } = await supabase
    .from("contacts")
    .select("id, display_name, retention_until")
    .not("retention_until", "is", null)
    .order("retention_until", { ascending: true })
    .limit(500);
  if (error) throw new Error(`Retention query failed: ${error.message}`);

  const rows: RetentionRow[] = (data ?? [])
    .filter((c): c is typeof c & { retention_until: string } => Boolean(c.retention_until))
    .map((c) => ({
      id: c.id,
      displayName: c.display_name,
      retentionUntil: c.retention_until,
    }));

  // Cyprus wall-clock date: the retention duty is a calendar obligation there,
  // not a UTC instant (doc 02 §A11).
  const today = zonedParts(new Date()).dayKey;

  return <RetentionPanel rows={summarizeRetention(rows, today)} />;
}
