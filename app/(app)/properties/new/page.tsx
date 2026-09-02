import { CreatePropertyWizard } from "@/components/features/properties/create-wizard";
import type { EntityOption } from "@/lib/actions/entity-search";
import { buildPropertySeed, type PropertySeed } from "@/lib/services/property-seed";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";

export default async function NewPropertyPage({
  searchParams,
}: {
  searchParams: Promise<{ similar?: string }>;
}) {
  const supabase = await createClient();
  const { similar } = await searchParams;

  const [districtsRes, areasRes, profile] = await Promise.all([
    supabase.from("districts").select("id, code, name, sort_order").order("sort_order"),
    supabase.from("areas").select("id, district_id, name"),
    getCurrentProfile(supabase),
  ]);
  // The units page lets only these two roles manage units (its `canManage`),
  // so the wizard offers to create them to the same two — an agent creating a
  // project wrote units it could not then touch (2026-09-02). Everyone else
  // still creates the project; the units come afterwards from that page.
  const canGenerate = profile.role === "admin" || profile.role === "listing_manager";

  const districts = unwrapRows(districtsRes, "districts").map((d) => ({
    id: d.id,
    code: d.code,
    name: (d.name as { en?: string })?.en ?? d.code,
  }));
  const areas = unwrapRows(areasRes, "areas").map((a) => ({
    id: a.id,
    districtId: a.district_id,
    name: (a.name as { en?: string })?.en ?? "—",
  }));

  /**
   * "Create similar" (BACKLOG). The id arrives in the URL, so it is treated as
   * untrusted: the read goes through the USER's client, and RLS decides whether
   * they may see that property at all. A missing or forbidden id silently
   * yields a normal blank form — there is nothing useful to say about a
   * property the viewer is not allowed to know exists.
   */
  let seed: PropertySeed | null = null;
  let seedParty: EntityOption | null = null;

  if (similar) {
    const { data: source } = await supabase
      .from("properties")
      // ONE STRING LITERAL, not a concatenation: supabase-js infers the row
      // type from the select text, and anything it cannot parse statically
      // degrades to GenericStringError. Narrow on purpose — see property-seed.ts.
      .select(
        "reference, kind, property_type, transaction_type, district_id, area_id, address, title, asking_price, rent_price_month, plot_area_sqm, covered_area_sqm, bedrooms, bathrooms, internal_notes, owner_contact_id, developer_contact_id",
      )
      .eq("id", similar)
      .maybeSingle();

    if (source) {
      seed = buildPropertySeed(source);
      if (seed.partyId) {
        // resolved here so the picker shows a NAME rather than a bare id; if the
        // contact is gone or unreadable the picker just starts empty
        const { data: contact } = await supabase
          .from("contacts")
          .select("id, display_name, phone_e164, email")
          .eq("id", seed.partyId)
          .maybeSingle();
        if (contact) {
          seedParty = {
            id: contact.id,
            label: contact.display_name ?? "Unnamed",
            // same shape entity-search builds, so the picker reads identically
            sublabel: contact.phone_e164 ?? contact.email,
          };
        } else {
          // do not carry a link the form cannot show — an invisible prefilled
          // party is exactly the kind of silent inheritance this page warns about
          seed = { ...seed, partyId: null };
        }
      }
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">
          {seed ? `Add property like ${seed.fromReference}` : "Add property"}
        </h1>
        <p className="text-sm text-text-2">
          Reference is generated automatically and never changes.
        </p>
      </div>
      <CreatePropertyWizard
        districts={districts}
        areas={areas}
        canGenerate={canGenerate}
        seed={seed}
        seedParty={seedParty}
      />
    </div>
  );
}
