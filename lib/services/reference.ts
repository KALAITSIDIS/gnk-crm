import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Reference numbering (doc 02 §A6): GNK-{DISTRICT}-{4-digit seq}, e.g.
 * GNK-PAF-0001. Generated server-side via the next_reference() security-definer
 * function (atomic per org+district). Immutable once assigned.
 */
export async function generateReference(
  supabase: SupabaseClient<Database>,
  orgId: string,
  districtCode: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("next_reference", {
    p_org: orgId,
    p_district_code: districtCode,
  });
  if (error) {
    throw new Error(`next_reference failed for ${districtCode}: ${error.message}`);
  }
  return data;
}
