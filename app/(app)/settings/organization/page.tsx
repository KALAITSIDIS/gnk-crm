import { BrandingUpload, OrgNameForm } from "@/components/features/settings/org-forms";
import { getCurrentProfile } from "@/lib/services/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function OrganizationSettingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", profile.orgId)
    .maybeSingle();

  // branding lives in the public media bucket; existence check via listing
  const admin = createAdminClient();
  const { data: brandingFiles } = await admin.storage.from("media").list("branding");
  const fileMeta = new Map((brandingFiles ?? []).map((f) => [f.name, f.updated_at ?? ""]));
  // cache-bust with the file's own updated_at, so a re-upload shows immediately
  const publicUrl = (file: string) =>
    admin.storage.from("media").getPublicUrl(`branding/${file}`).data.publicUrl +
    `?v=${encodeURIComponent(fileMeta.get(file) ?? "")}`;

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
          hint="PNG · used on documents and reports."
          currentUrl={fileMeta.has("logo.png") ? publicUrl("logo.png") : null}
        />
        <BrandingUpload
          kind="watermark"
          title="Watermark"
          hint="PNG with transparency · applied to public/partner photo renditions by the media pipeline."
          currentUrl={fileMeta.has("watermark.png") ? publicUrl("watermark.png") : null}
        />
      </section>
    </div>
  );
}
