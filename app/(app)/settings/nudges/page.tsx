import { NudgeThresholdsPanel } from "@/components/features/settings/nudge-thresholds-panel";
import { getCurrentProfile } from "@/lib/services/auth";
import { readThresholds } from "@/lib/services/nudge-thresholds";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Settings → Nudges (migration 0052).
 *
 * Reads the `nudge_thresholds` row through `readThresholds`, which applies the
 * SAME fallback rules as `public.nudge_threshold()` in SQL — so what this page
 * shows is what the sweeps actually use, including when the row is missing or
 * somebody has put nonsense in it via the raw JSON editor.
 */
export default async function NudgeSettingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // pages render in parallel with the layout's admin gate — stop here too
  if (profile.role !== "admin") return null;

  const { data: row } = await supabase
    .from("cyprus_config")
    .select("value")
    .eq("key", "nudge_thresholds")
    .maybeSingle();

  // A missing row is not an error state: the sweeps fall back to their shipped
  // constants, so the form shows those and saving restores the row.
  return <NudgeThresholdsPanel values={readThresholds(row?.value ?? null)} />;
}
