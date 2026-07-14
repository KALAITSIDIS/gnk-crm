import {
  LocationsEditor,
  type DistrictGroup,
} from "@/components/features/settings/locations-editor";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function LocationsSettingsPage() {
  const supabase = await createClient();
  const [{ data: districts }, { data: areas }] = await Promise.all([
    supabase.from("districts").select("id, name").order("id"),
    supabase.from("areas").select("id, district_id, name").order("id"),
  ]);

  const groups: DistrictGroup[] = (districts ?? []).map((d) => ({
    id: d.id,
    name: (d.name as { en?: string })?.en ?? "—",
    areas: (areas ?? [])
      .filter((a) => a.district_id === d.id)
      .map((a) => ({ id: a.id, name: (a.name as { en?: string })?.en ?? "—" })),
  }));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-2">
        Cyprus districts are fixed; add or rename the areas your listings use. Names are the
        English values (EL/RU localisation lands with the multilingual phase).
      </p>
      <LocationsEditor districts={groups} />
    </div>
  );
}
