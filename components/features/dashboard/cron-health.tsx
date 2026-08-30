import { AlarmClockCheck, AlarmClockMinus } from "lucide-react";
import { judgeAll, type CronJobFacts } from "@/lib/services/cron-health";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";

/**
 * One line the admin actually looks at (0074, audit REL-03): are the eight
 * nightly/weekly/monthly sweeps alive? Before this, a stopped scheduler —
 * the KNOWN post-restore state — or a persistently failing job was invisible
 * until a mandate silently failed to expire.
 *
 * Server component, rendered ONLY inside the admin branch of the dashboard
 * page: cron_health() is service_role-only (the anon-default-EXECUTE hazard
 * has bitten twice), so it is reached through the admin client — the
 * raise_key_recall_tasks precedent for an already-role-gated call site.
 *
 * An RPC failure renders as its own amber state rather than nothing: this
 * panel's one job is noticing silence, so it must never fail silently itself.
 */
export async function CronHealth() {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("cron_health");

  if (error || !data) {
    return (
      <div className="flex max-w-2xl items-center gap-2 rounded-[10px] border border-warning/30 bg-warning/10 px-4 py-3 text-sm font-medium text-warning">
        <AlarmClockMinus className="size-4 shrink-0" />
        Scheduled sweeps: health unreadable ({error?.message ?? "no data"}) — check pg_cron.
      </div>
    );
  }

  const verdicts = judgeAll(data as CronJobFacts[], new Date());
  const failing = verdicts.filter((v) => !v.healthy);
  const healthy = failing.length === 0 && verdicts.length === 8;

  return (
    <div
      className={cn(
        "flex max-w-2xl items-start gap-2 rounded-[10px] border px-4 py-3 text-sm font-medium",
        healthy
          ? "border-success/30 bg-success/10 text-success"
          : "border-warning/30 bg-warning/10 text-warning",
      )}
    >
      {healthy ? (
        <AlarmClockCheck className="size-4 shrink-0" />
      ) : (
        <AlarmClockMinus className="mt-0.5 size-4 shrink-0" />
      )}
      {healthy ? (
        <span>Scheduled sweeps: all {verdicts.length} healthy.</span>
      ) : (
        <span>
          Scheduled sweeps: {failing.length} of {verdicts.length} unhealthy —{" "}
          {failing.map((f) => `${f.jobname} (${f.reason})`).join("; ")}
          {verdicts.length !== 8 ? ` · expected 8 jobs, found ${verdicts.length}` : ""}
        </span>
      )}
    </div>
  );
}
