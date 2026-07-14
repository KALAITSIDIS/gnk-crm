import { getTranslations } from "next-intl/server";
import { AdminDashboard } from "@/components/features/dashboard/admin-dashboard";
import { AgentDashboard } from "@/components/features/dashboard/agent-dashboard";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Role dashboards (T5.3, guardrail 6: three FIXED dashboards, no
 * customization). Admin → admin KPIs; agent + listing manager → the
 * mobile-first agent view (Owner/Developer dashboard is a later phase).
 */
export default async function DashboardPage() {
  const t = await getTranslations("dashboard");
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-text-1">{t("title")}</h1>
      {profile.role === "admin" ? (
        <AdminDashboard />
      ) : (
        <AgentDashboard profileId={profile.id} />
      )}
    </div>
  );
}
