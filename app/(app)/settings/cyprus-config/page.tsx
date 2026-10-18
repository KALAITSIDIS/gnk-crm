import { ConfigCard, type ConfigRow } from "@/components/features/settings/config-editor";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";

export const dynamic = "force-dynamic";

export default async function CyprusConfigSettingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // pages render in parallel with the layout's admin gate — stop here too
  if (profile.role !== "admin") return null;

  // A failed read is the error boundary, never an empty page of settings
  // that looks like a database with none (A08).
  const rows = unwrapRows(
    await supabase
      .from("cyprus_config")
      .select("key, value, description, verified_at, source_note")
      .order("key"),
    "cyprus_config",
  );

  const configs: ConfigRow[] = rows.map((r) => ({
    key: r.key,
    valueJson: JSON.stringify(r.value, null, 2),
    description: r.description,
    verifiedAt: r.verified_at,
    sourceNote: r.source_note,
  }));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-2">
        The rates and settings behind the calculators, documents and lead handling, exactly as stored. The calculators
        read tax and fee rates from here every time — none are built in. Transfer fees and stamp duty are checked before
        saving, so a typo cannot produce nonsense fees, and every save is recorded in the event log. Set &ldquo;Verified
        on&rdquo; after checking the current law.
      </p>
      {configs.map((c) => (
        <ConfigCard key={c.key} row={c} />
      ))}
    </div>
  );
}
