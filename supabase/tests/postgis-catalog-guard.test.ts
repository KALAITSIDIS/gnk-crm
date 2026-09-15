/**
 * PostGIS catalog guard (security & compliance audit 2026-09-15, AC-04 / 0099).
 * Requires the local Supabase stack. Run: npm run test:rls
 *
 * The PostGIS install grants anon and authenticated full DML on
 * public.spatial_ref_sys, and PostgREST exposes it, so without a guard an anon
 * DELETE — carrying only the publishable key — wipes the coordinate reference
 * data and breaks every geography operation. The grant cannot be revoked from
 * postgres (the table is owned by supabase_admin), so migration 0099 installs a
 * statement-level trigger that refuses writes from the anon/authenticated API
 * roles while leaving reads intact. This pins that behaviour.
 */
import { describe, expect, it } from "vitest";
import { anonClient } from "./helpers";

// spatial_ref_sys is a PostGIS catalog table, not part of the app schema, so it
// is reached through the untyped anon client the same way the other RLS tests
// query their tables.
describe("PostGIS spatial_ref_sys is read-only for the API roles (0099)", () => {
  it("anon may still read the reference table", async () => {
    const anon = anonClient();
    const { data, error } = await anon.from("spatial_ref_sys").select("srid").limit(1);
    expect(error, error?.message).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it("anon may not delete from it, and nothing is removed", async () => {
    const anon = anonClient();
    const { count: before } = await anon
      .from("spatial_ref_sys")
      .select("srid", { count: "exact", head: true });

    // srid = -99999 matches no row; the statement-level guard fires regardless.
    const { error } = await anon.from("spatial_ref_sys").delete().eq("srid", -99999);
    expect(error, "anon DELETE must be refused by the guard").not.toBeNull();
    expect(error?.message ?? "").toMatch(/read-only for API roles/i);

    const { count: after } = await anon
      .from("spatial_ref_sys")
      .select("srid", { count: "exact", head: true });
    expect(after).toBe(before);
  });

  it("anon may not update it either", async () => {
    const anon = anonClient();
    const { error } = await anon
      .from("spatial_ref_sys")
      .update({ auth_name: "probe" })
      .eq("srid", -99999);
    expect(error, "anon UPDATE must be refused by the guard").not.toBeNull();
    expect(error?.message ?? "").toMatch(/read-only for API roles/i);
  });
});
