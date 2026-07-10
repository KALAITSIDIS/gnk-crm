import { CreatePropertyWizard } from "@/components/features/properties/create-wizard";
import { createClient } from "@/lib/supabase/server";

export default async function NewPropertyPage() {
  const supabase = await createClient();

  const [{ data: districtRows }, { data: areaRows }] = await Promise.all([
    supabase.from("districts").select("id, code, name, sort_order").order("sort_order"),
    supabase.from("areas").select("id, district_id, name"),
  ]);

  const districts = (districtRows ?? []).map((d) => ({
    id: d.id,
    code: d.code,
    name: (d.name as { en?: string })?.en ?? d.code,
  }));
  const areas = (areaRows ?? []).map((a) => ({
    id: a.id,
    districtId: a.district_id,
    name: (a.name as { en?: string })?.en ?? "—",
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">Add property</h1>
        <p className="text-sm text-text-2">
          Reference is generated automatically and never changes.
        </p>
      </div>
      <CreatePropertyWizard districts={districts} areas={areas} />
    </div>
  );
}
