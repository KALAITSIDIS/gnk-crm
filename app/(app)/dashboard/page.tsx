import { getTranslations } from "next-intl/server";
import { AdminDashboard } from "@/components/features/dashboard/admin-dashboard";
import { AgentDashboard } from "@/components/features/dashboard/agent-dashboard";
import { CronHealth } from "@/components/features/dashboard/cron-health";
import { ListingHealth } from "@/components/features/dashboard/listing-health";
import { MyDay } from "@/components/features/dashboard/my-day";
import { TeamCards } from "@/components/features/dashboard/team-cards";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Role dashboards (T5.3, guardrail 6: three FIXED dashboards, no
 * customization). Admin → alerts, My day, Team, then the admin KPIs; agent +
 * listing manager → the mobile-first agent view (Owner/Developer dashboard is
 * a later phase).
 *
 * A01: the admin's branch gained the admin's OWN day (the same My day cards an
 * agent gets) and a Team section, in a fixed order — there is no personal/team
 * toggle, because a dashboard filter is what guardrail 6 refuses
 * (DECISIONS:5203). Production's users are admins, so before A01 nobody using
 * the system ever saw their own viewings, tasks or leads here.
 */
export default async function DashboardPage() {
  const t = await getTranslations("dashboard");
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-text-1">{t("title")}</h1>
      {profile.role === "admin" ? (
        <>
          {/* admin-branch only: cron_health() is service_role-gated (0074) */}
          <CronHealth />
          {/* audit 2026-09-15 LST-03: published_below_threshold() finally has a screen */}
          <ListingHealth />
          <section aria-labelledby="dashboard-my-day" className="flex flex-col gap-3">
            <h2 id="dashboard-my-day" className="text-base font-semibold text-text-1">
              {t("myDay.title")}
            </h2>
            <MyDay profileId={profile.id} level={3} className="grid gap-4 lg:grid-cols-2" />
          </section>
          {/* admin-branch only: tasks_select gives an admin the whole org's
              tasks and an agent only their own, so a team card is an admin view */}
          <section aria-labelledby="dashboard-team" className="flex flex-col gap-3">
            <h2 id="dashboard-team" className="text-base font-semibold text-text-1">
              {t("team.title")}
            </h2>
            <TeamCards profileId={profile.id} level={3} />
          </section>
          <AdminDashboard orgId={profile.orgId} />
        </>
      ) : (
        <AgentDashboard profileId={profile.id} />
      )}
    </div>
  );
}
