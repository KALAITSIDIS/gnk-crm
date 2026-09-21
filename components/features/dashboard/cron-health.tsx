import { AlarmClockCheck, AlarmClockMinus } from "lucide-react";
import { judgeAll, type CronJobFacts, EXPECTED_CRON_JOBS } from "@/lib/services/cron-health";
import { applySweepVerdict, judgeSweep, type SweepHealthFacts } from "@/lib/services/enquiry-alert-sweep-health";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";

/**
 * One line the admin actually looks at (0074, audit REL-03): are the scheduled
 * sweeps alive? Before this, a stopped scheduler — the KNOWN post-restore
 * state — or a persistently failing job was invisible until a mandate silently
 * failed to expire.
 *
 * HOW MANY, AND HOW OFTEN, BOTH LIVE ELSEWHERE — deliberately. This sentence
 * said "the eight nightly/weekly/monthly sweeps" while there were ten, one of
 * them running every ten minutes (0098's lead-sla): the same staleness the
 * COUNT suffered before it was hoisted into EXPECTED_CRON_JOBS. That constant
 * is derived from the migrations by tests/unit/cron-jobs-pinned.test.ts, and
 * the cadence each job is judged against is allowanceMs in
 * lib/services/cron-health.ts. Neither number belongs in this file, including
 * in prose.
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

  // 0105: the enquiry-alerts job "succeeds" whenever pg_net QUEUES its
  // request, whatever the sweep route then answers. Its real outcomes are
  // reconciled into enquiry_alert_sweep_runs; the worker's verdict is folded
  // into that one line, so this card cannot stay green while every request
  // is being queued and every one of them fails. An unreadable summary is
  // itself the unhealthy state, never a silent pass.
  const sweep = await admin.rpc("enquiry_alert_sweep_health");
  const facts = sweep.error ? null : (((sweep.data ?? []) as SweepHealthFacts[])[0] ?? null);
  const now = new Date();
  const verdicts = applySweepVerdict(judgeAll(data as CronJobFacts[], now), judgeSweep(facts, now));
  const failing = verdicts.filter((v) => !v.healthy);
  // The count is the pin in lib/services/cron-health.ts, which a test holds to
  // the migrations' `cron.schedule` names; a literal here went stale twice
  // (the ninth job on 2026-09-13, the tenth on 2026-09-15).
  const healthy = failing.length === 0 && verdicts.length === EXPECTED_CRON_JOBS;

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
          {verdicts.length !== EXPECTED_CRON_JOBS
            ? ` · expected ${EXPECTED_CRON_JOBS} jobs, found ${verdicts.length}`
            : ""}
        </span>
      )}
    </div>
  );
}
