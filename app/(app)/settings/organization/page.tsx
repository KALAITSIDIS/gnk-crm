import { BrandingUpload, OrgNameForm } from "@/components/features/settings/org-forms";
import { getCurrentProfile } from "@/lib/services/auth";
import { BRANDING_USE, brandingPublicUrl, readBrandingFiles, type BrandingKind } from "@/lib/services/branding";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function OrganizationSettingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // the layout renders the "Admins only" screen; pages render in PARALLEL with
  // it (Next.js), so each one must stop its own data work for non-admins too
  if (profile.role !== "admin") return null;

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", profile.orgId)
    .maybeSingle();

  // branding lives in the public media bucket; existence check via listing.
  // A failed listing is "could not check", never "not uploaded" (A07).
  const admin = createAdminClient();
  const branding = await readBrandingFiles(admin);
  const current = (kind: BrandingKind): string | null => {
    if (!branding.ok) return null;
    const updatedAt = branding.files[kind];
    // cache-bust with the file's own updated_at, so a re-upload shows immediately
    return updatedAt === undefined ? null : brandingPublicUrl(admin, kind, updatedAt);
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-[10px] border border-border bg-surface p-5">
        <h2 className="mb-3 text-sm font-semibold text-text-1">Profile</h2>
        <OrgNameForm name={org?.name ?? ""} />
      </section>

      <section className="flex flex-col gap-5 rounded-[10px] border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text-1">Branding</h2>
        <BrandingUpload
          kind="logo"
          title="Logo"
          hint={`PNG · ${BRANDING_USE.logo}`}
          currentUrl={current("logo")}
          unreadable={!branding.ok}
        />
        <BrandingUpload
          kind="watermark"
          title="Watermark"
          hint={`PNG with transparency · ${BRANDING_USE.watermark}`}
          currentUrl={current("watermark")}
          unreadable={!branding.ok}
        />
      </section>
    </div>
  );
}
