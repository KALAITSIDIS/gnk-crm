import { AlarmClockCheck, AlarmClockMinus } from "lucide-react";
import { judgeAll, type CronJobFacts, EXPECTED_CRON_JOBS } from "@/lib/services/cron-health";
import { CRON_JOB_LABELS, cronJobLabel } from "@/lib/services/cron-job-labels";
import { applySweepVerdict, judgeSweep, type SweepHealthFacts } from "@/lib/services/enquiry-alert-sweep-health";
import { createAdminClient } from "@/lib/supabase/admin";
import { TechnicalDetails } from "@/components/features/shared/technical-details";
import { cn } from "@/lib/utils";

/**
 * One line the admin actually looks at (0074, audit REL-03): are the scheduled
 * jobs alive? Before this, a stopped scheduler — the KNOWN post-restore
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
 * BUSINESS WORDS FIRST (A08, review 2026-10-18): the line names the work —
 * "Mandate expiry", "Website enquiry e-mails" — from cron-job-labels.ts, and
 * says which jobs need attention or are not scheduled at all. The pg_cron
 * names and each verdict's reason, which is what support needs quoted, sit
 * under "Technical details".
 *
 * Server component, rendered ONLY inside the admin branch of the dashboard
 * page: cron_health() is service_role-only (the anon-default-EXECUTE hazard
 * has bitten twice), so it is reached through the admin client — the
 * raise_key_recall_tasks precedent for an already-role-gated call site.
 *
 * An RPC failure renders as its own amber state rather than nothing: this
 * panel's one job is noticing silence, so it must never fail silently itself.
 */
const BANNER = "flex max-w-2xl items-start gap-2 rounded-[10px] border px-4 py-3 text-sm font-medium";
const WARN = "border-warning/30 bg-warning/10 text-warning";

export async function CronHealth() {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("cron_health");

  if (error || !data) {
    return (
      <div data-testid="cron-health" className={cn(BANNER, WARN)}>
        <AlarmClockMinus className="mt-0.5 size-4 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1">
          <span>Background jobs: their status could not be checked.</span>
          <TechnicalDetails>cron_health() failed: {error?.message ?? "no data"} — check pg_cron.</TechnicalDetails>
        </div>
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

  if (healthy) {
    return (
      <div data-testid="cron-health" className={cn(BANNER, "border-success/30 bg-success/10 text-success")}>
        <AlarmClockCheck className="size-4 shrink-0" />
        <span>Background jobs: all {verdicts.length} running.</span>
      </div>
    );
  }

  // The labels' keys are the migrations' job names (a test holds them there),
  // so a key with no row in cron_health() is a job that is not scheduled.
  const present = new Set(verdicts.map((v) => v.jobname));
  const missing = Object.keys(CRON_JOB_LABELS).filter((name) => !present.has(name));
  const parts: string[] = [];
  if (failing.length > 0) {
    parts.push(
      `${failing.length} of ${verdicts.length} need${failing.length === 1 ? "s" : ""} attention — ` +
        failing.map((f) => cronJobLabel(f.jobname)).join(", "),
    );
  }
  if (missing.length > 0) {
    parts.push(`${missing.map(cronJobLabel).join(", ")} ${missing.length === 1 ? "is" : "are"} not scheduled`);
  }
  if (missing.length === 0 && verdicts.length !== EXPECTED_CRON_JOBS) {
    parts.push(`${verdicts.length} found where ${EXPECTED_CRON_JOBS} are expected`);
  }

  return (
    <div data-testid="cron-health" className={cn(BANNER, WARN)}>
      <AlarmClockMinus className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        <span>Background jobs: {parts.join("; ")}.</span>
        <TechnicalDetails>
          {failing.map((f) => (
            <span key={f.jobname} className="block">
              {f.jobname}: {f.reason ?? "unhealthy"}
            </span>
          ))}
          {missing.map((name) => (
            <span key={name} className="block">
              {name}: not in pg_cron
            </span>
          ))}
          {verdicts.length !== EXPECTED_CRON_JOBS ? (
            <span className="block">
              expected {EXPECTED_CRON_JOBS} jobs, found {verdicts.length}
            </span>
          ) : null}
        </TechnicalDetails>
      </div>
    </div>
  );
}
