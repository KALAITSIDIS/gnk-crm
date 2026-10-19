import { ShieldAlert } from "lucide-react";
import { SettingsNav } from "@/components/features/settings/settings-nav";
import { SettingsSectionHeading } from "@/components/features/settings/settings-section-heading";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import type { Metadata } from "next";

/** The browser tab's name (A08) for every settings section: "Settings · GN REOS" through the root layout's template. */
export const metadata: Metadata = { title: "Settings" };

/**
 * Settings shell (T5.4, doc 05: admin area). UI gate here; every write is
 * ALSO admin-gated in its action and by admin-only RLS — the acceptance
 * "non-admin blocked (RLS + UI)" is belt and braces.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  if (profile.role !== "admin") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-[10px] border border-border bg-surface py-16">
        <ShieldAlert className="size-8 text-warning" />
        <p className="text-sm font-medium text-text-1">Admins only</p>
        <p className="text-sm text-text-2">Settings are restricted to administrators.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-text-1">Settings</h1>
      <SettingsNav />
      {/* each section opens with an <h2> naming it — drawn here, from the tabs' own list (A08) */}
      <SettingsSectionHeading />
      {children}
    </div>
  );
}
