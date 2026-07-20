import { ConfigCard, type ConfigRow } from "@/components/features/settings/config-editor";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function CyprusConfigSettingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // pages render in parallel with the layout's admin gate — stop here too
  if (profile.role !== "admin") return null;

  const { data: rows } = await supabase
    .from("cyprus_config")
    .select("key, value, description, verified_at, source_note")
    .order("key");

  const configs: ConfigRow[] = (rows ?? []).map((r) => ({
    key: r.key,
    valueJson: JSON.stringify(r.value, null, 2),
    description: r.description,
    verifiedAt: r.verified_at,
    sourceNote: r.source_note,
  }));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-2">
        Rates the calculators read live (guardrail 5: never hardcoded). Every save is an event;
        transfer_fees and stamp_duty are shape-checked before saving so a typo cannot produce
        nonsense fees. Set “verified on” after checking current legislation.
      </p>
      {configs.map((c) => (
        <ConfigCard key={c.key} row={c} />
      ))}
    </div>
  );
}
