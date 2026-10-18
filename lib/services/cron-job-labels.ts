/**
 * Plain names for the scheduled jobs, for the admin dashboard's
 * background-jobs line (A08, review 2026-10-18). The line used to print the
 * pg_cron names and their verdicts — "enquiry-alerts (never succeeded (last
 * run: failed))" — which is the right thing to quote to support and the
 * wrong thing to lead with. The line now names the work in business words
 * and keeps the job name and the verdict under "Technical details".
 *
 * Beside EXPECTED_CRON_JOBS (cron-health.ts) in spirit: the KEYS are the
 * names the migrations give `cron.schedule()`, and
 * tests/unit/business-wording.test.ts holds them to the migrations the same
 * way cron-jobs-pinned.test.ts holds the count — a job scheduled without a
 * name here fails that test, and the dashboard would otherwise fall back to
 * printing the raw name.
 *
 * Pure: no imports, so a test and a server component read the same table.
 */
export const CRON_JOB_LABELS: Readonly<Record<string, string>> = {
  "expire-mandates": "Mandate expiry",
  "verify-events-chain": "Nightly event-log integrity check",
  "verify-events-chain-full": "Weekly full event-log integrity check",
  "ensure-events-partitions": "Event-log storage for the coming months",
  "followup-nudges": "Chase-up tasks",
  "expire-reservations": "Reservation expiry",
  "warn-expiring-reservations": "Reservation expiry warnings",
  "remind-due-installments": "Instalment reminders",
  "redact-stale-enquiries": "Removing old enquiry details (privacy)",
  "lead-sla": "Unanswered-lead follow-up tasks",
  "enquiry-alerts": "Website enquiry e-mails",
  "lead-escalation": "Unanswered-enquiry escalations",
};

/** The job's plain name, or the job name itself for one this table does not know (own entries only). */
export function cronJobLabel(jobname: string): string {
  return Object.hasOwn(CRON_JOB_LABELS, jobname) ? CRON_JOB_LABELS[jobname]! : jobname;
}
