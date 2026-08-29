#!/usr/bin/env node
/**
 * Dead-man's-switch ping for the nightly backup (audit 2026-08-29, REL-02).
 *
 *   node --env-file=... scripts/backup/notify.mjs --rc <exit code>
 *
 * Pings HEALTHCHECK_URL (a healthchecks.io-style check) after the nightly:
 * on rc=0 the base URL, otherwise <url>/fail with the exit code attached.
 * The SERVICE is the alarm, not this script — it emails the operator when
 * the ping goes silent for ~26h, which is the one failure mode nothing on
 * this machine can report: the machine being off, asleep, or logged out.
 * (Measured before building: the 2026-08-29 03:45 run was silently skipped
 * — task "Interactive only", nobody logged in — and two historical exit=1
 * runs alerted nobody. backup.log line 428, 465.)
 *
 * ALWAYS EXITS 0. The ping is telemetry about the backup, never a reason to
 * mark the backup itself failed — a down healthchecks endpoint must not turn
 * a good backup night into a red one. Failures are logged and nothing more.
 *
 * SKIPS SILENTLY-BUT-LOGGED when HEALTHCHECK_URL is unset, so the plumbing
 * can ship before the operator has created the check. The URL is a secret
 * (anyone holding it can fake liveness), so it lives in backup.env beside
 * the DB credentials, outside both the repo and OneDrive.
 */
const args = process.argv.slice(2);
const rcArg = args.indexOf("--rc");
const rc = rcArg !== -1 ? Number(args[rcArg + 1]) : NaN;

const url = (process.env.HEALTHCHECK_URL ?? "").trim();
if (!url) {
  console.log("notify: SKIPPED — HEALTHCHECK_URL not set (create a check and add it to backup.env to arm the dead-man's switch)");
  process.exit(0);
}
if (!Number.isInteger(rc)) {
  console.error("notify: --rc <exit code> is required; pinging /fail so a wiring bug cannot look like health");
}

const target = Number.isInteger(rc) && rc === 0 ? url : `${url.replace(/\/+$/, "")}/fail`;

// Three attempts, 10s apiece — a scheduler must never hang on telemetry.
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const res = await fetch(target, {
      method: "POST",
      body: `gnk-crm nightly backup rc=${Number.isInteger(rc) ? rc : "missing"}`,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      console.log(`notify: pinged ${rc === 0 ? "OK" : "FAIL"} (attempt ${attempt}, HTTP ${res.status})`);
      process.exit(0);
    }
    console.error(`notify: attempt ${attempt} got HTTP ${res.status}`);
  } catch (e) {
    console.error(`notify: attempt ${attempt} failed: ${e?.name === "TimeoutError" ? "timeout" : e?.message ?? e}`);
  }
}
console.error("notify: all attempts failed — the check will go stale and the service alarms on silence, which is the design");
process.exit(0);
