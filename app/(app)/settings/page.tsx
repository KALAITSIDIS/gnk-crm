import { Suspense } from "react";
import { ReadinessOverview } from "@/components/features/settings/readiness-overview";
import { loadReadinessFacts, type ReadinessFacts } from "@/lib/services/activation-readiness";
import { getCurrentProfile } from "@/lib/services/auth";
import { senderReadiness } from "@/lib/services/enquiry-alert";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Settings → Overview: activation readiness (A07). Was a bare redirect to
 * /settings/organization; every settings URL is unchanged.
 *
 * Read-only. The database facts load first (fast, each read checked); the
 * provider's answer about the sending domain — one read-only `GET /domains`
 * when the From is a custom address, capped at three seconds, never throwing
 * (`senderReadiness`) — streams in behind a Suspense boundary whose fallback
 * is the same overview with those rows reading "Checking…".
 */
export default async function SettingsOverviewPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // pages render in parallel with the layout's admin gate — stop here too
  if (profile.role !== "admin") return null;

  const facts = await loadReadinessFacts(supabase, createAdminClient, profile.orgId);
  return (
    <Suspense fallback={<ReadinessOverview facts={facts} sender={null} />}>
      <WithSender facts={facts} />
    </Suspense>
  );
}

async function WithSender({ facts }: { facts: ReadinessFacts }) {
  return <ReadinessOverview facts={facts} sender={await senderReadiness()} />;
}
