import { StagesEditor, type StageRow } from "@/components/features/settings/stages-editor";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function StagesSettingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // pages render in parallel with the layout's admin gate — stop here too
  if (profile.role !== "admin") return null;

  // deal_type first: group order follows the enum (sale, rental, antiparoxi,
  // advisory) instead of whichever type happened to own sort_order 1
  const { data: rows } = await supabase
    .from("deal_stages")
    .select("id, name, deal_type, sort_order, is_won, is_lost")
    .order("deal_type", { ascending: true })
    .order("sort_order", { ascending: true });

  const byType = new Map<string, StageRow[]>();
  for (const s of rows ?? []) {
    const arr = byType.get(s.deal_type) ?? [];
    arr.push(s);
    byType.set(s.deal_type, arr);
  }
  const groups = [...byType.entries()].map(([dealType, stages]) => ({ dealType, stages }));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-2">
        Rename, reorder or add pipeline stages per deal type. Won/lost stages are locked and
        always stay last; a stage with deals in it cannot be deleted.
      </p>
      <StagesEditor groups={groups} />
    </div>
  );
}
