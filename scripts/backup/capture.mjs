#!/usr/bin/env node
/**
 * One command that takes a COMPLETE, SELF-VERIFIED backup set.
 *
 *   SUPABASE_DB_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/backup/capture.mjs
 *
 *   --out <dir>     backup root (default ../gnk-backups)
 *   --force         replace today's set if it already exists
 *   --skip-storage  database only
 *   --keep N        retention: keep N most recent verified sets
 *
 * Exit codes, because a scheduler only ever sees the number:
 *   0  verified set written
 *   1  a set was produced but is NOT trustworthy — destination left untouched
 *   2  refused to start (bad config, or today's set exists without --force)
 *
 * See docs/BACKUP_RESTORE.md §3.0.
 *
 * WHY IT STAGES INSTEAD OF WRITING IN PLACE
 * -----------------------------------------
 * An earlier version dumped straight into ../gnk-backups/<date>/ and, on
 * 2026-08-06, a failed run DESTROYED the verified set already sitting there: the
 * CLI created pg_dump.sql and roles.sql as 0-byte files (deleted by the cleanup,
 * taking the good ones with them) and wrote a 41-byte fragment over a good
 * 84 KB data.sql, which was too big to look empty. A backup tool that eats last
 * night's good backup when tonight's fails is worse than no backup tool.
 *
 * So: everything is written to a staging directory, verified there, and only
 * moved into place once every check passes. A failed run cannot touch the
 * destination — the worst it can do is leave a staging folder behind.
 *
 * WHAT IT VERIFIES, and the failure each check corresponds to — all real:
 *   - `--schema public,auth,storage` on the SCHEMA dump emits ownership
 *     statements no role can execute; restore dies at line 19 (§4b.2).
 *   - `data.sql` must start `SET session_replication_role = replica;` or
 *     `trg_events_hash` re-mints every hash on restore and the chain then
 *     verifies against invented values (§5).
 *   - A dump can be truncated without erroring — so the event count inside
 *     data.sql is compared against the LIVE count.
 *   - A failed `db dump` still creates its -f file. Size floors catch it.
 *
 * CREDENTIALS come from the environment, are never logged, never written to the
 * output and never echoed in an error.
 */
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const args = process.argv.slice(2);
const arg = (n, d) => (args.indexOf(n) !== -1 ? args[args.indexOf(n) + 1] : d);
const outRoot = arg("--out", "../gnk-backups");
const force = args.includes("--force");
const skipStorage = args.includes("--skip-storage");

const dbUrl = process.env.SUPABASE_DB_URL;
const apiUrl = process.env.SUPABASE_URL;
const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!dbUrl || !apiUrl || !svcKey) {
  console.error("Set SUPABASE_DB_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}

// Unedited template placeholders. Without this the run reaches the database and
// fails as `password authentication failed for user "postgres"` — a message that
// names no cause and sent an earlier session hunting a username bug that did not
// exist (§3.1).
for (const [name, val] of [["SUPABASE_DB_URL", dbUrl], ["SUPABASE_SERVICE_ROLE_KEY", svcKey]]) {
  if (/PASSWORD_HERE|SECRET_KEY_HERE|<[a-z-]+>/i.test(val)) {
    console.error(`${name} still contains a template placeholder — backup.env was created but not filled in.`);
    process.exit(2);
  }
}
// The pooler needs the project ref in the username. Only applies to pooler hosts;
// a local stack legitimately uses the bare role.
if (dbUrl.includes("pooler.supabase.com") && /:\/\/postgres:/.test(dbUrl)) {
  console.error("SUPABASE_DB_URL targets the pooler with the bare user 'postgres'. It needs 'postgres.<project-ref>' (§3.1).");
  process.exit(2);
}

const stamp = new Date().toISOString().slice(0, 10);
const finalDir = join(outRoot, stamp);
if (existsSync(finalDir) && !force) {
  console.error(`${finalDir} already exists. Re-run with --force to replace today's set.`);
  process.exit(2);
}

// export.mjs derives its own <root>/<stamp>, so the staging root is one level up
// from the staging directory and both tools land in the same place.
const stagingRoot = join(outRoot, `.staging-${process.pid}`);
const stageDir = join(stagingRoot, stamp);
rmSync(stagingRoot, { recursive: true, force: true });
// Sweep staging left by earlier failed runs. Kept for inspection at the time,
// but a nightly job that fails for a week would otherwise litter the backup
// directory with partial dumps — clutter is a hazard of its own mid-incident.
if (existsSync(outRoot)) {
  for (const d of readdirSync(outRoot).filter((n) => n.startsWith(".staging-") || n.includes(".replacing-"))) {
    rmSync(join(outRoot, d), { recursive: true, force: true });
  }
}
mkdirSync(stageDir, { recursive: true });

const sb = createClient(apiUrl, svcKey, { auth: { persistSession: false } });
const problems = [];
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const log = (s) => console.log(s);

/** Never let the connection string reach stdout, a log file or an exception. */
const redact = (s) => String(s ?? "").split(dbUrl).join("[DB_URL REDACTED]");

/**
 * The Supabase CLI is not a dependency here — `npx` fetches it — so it has to be
 * reached through the npx wrapper. On Windows that wrapper is `npx.cmd`, and Node
 * has refused to spawn `.cmd`/`.bat` directly since 18.20 (a command-injection
 * fix): it fails with status `null` and an EINVAL in `error`, which looks exactly
 * like the command not existing. `cmd.exe /c` with a real argument array works,
 * and because nothing is string-concatenated the quoting hazard stays out of it.
 *
 * The connection string is still an argv entry of the child, as it is when a
 * human types the command — so it is briefly visible to anything that can
 * enumerate process command lines on this machine.
 */
function cliArgs(rest) {
  return process.platform === "win32"
    ? ["cmd.exe", ["/c", "npx.cmd", "supabase", ...rest]]
    : ["npx", ["supabase", ...rest]];
}

function dump(label, extraArgs, file) {
  const target = join(stageDir, file);
  const [cmd, base] = cliArgs(["db", "dump", "--db-url", dbUrl, ...extraArgs, "-f", target]);
  const r = spawnSync(cmd, base, { encoding: "utf8", shell: false });
  if (r.status !== 0) {
    // Keep enough stderr to diagnose. Two lines proved useless on 2026-08-06:
    // the CLI's real cause sits above its generic "error running container"
    // trailer, so truncating from the end threw away the only useful part.
    const raw = r.error ? r.error.message : `${r.stderr ?? ""}\n${r.stdout ?? ""}`;
    const why = redact(raw)
      .replace(/\[[0-9;]*m/g, "")
      .split("\n").map((l) => l.trim()).filter(Boolean).slice(-12).join("\n      ");
    problems.push(`${label}: exit ${r.status}\n      ${why}`);
    return null;
  }
  log(`  ${label.padEnd(8)} ${String(statSync(target).size).padStart(8)} bytes`);
  return target;
}

log(`capture ${stamp}  ->  ${finalDir}`);
log(`staging in ${stagingRoot}\n`);
log("dumps");
const schemaFile = dump("schema", ["--schema", "public"], "pg_dump.sql");
const dataFile = dump("data", ["--schema", "public,auth,storage", "--data-only", "--use-copy"], "data.sql");
const rolesFile = dump("roles", ["--role-only"], "roles.sql");

if (!skipStorage) {
  log("\nstorage + table json (export.mjs)");
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "export.mjs"), "--out", stagingRoot], {
    encoding: "utf8",
    env: { ...process.env },
  });
  if (r.status !== 0) {
    problems.push(`export.mjs: exit ${r.status}\n      ${redact(`${r.stderr ?? ""}`).split("\n").map((l) => l.trim()).filter(Boolean).slice(-6).join("\n      ")}`);
  } else log("  ok");
}

// ---------------------------------------------------------------- verification
log("\nverify");
const read = (f) => (f && existsSync(f) ? readFileSync(f, "utf8") : null);

const schemaSql = read(schemaFile);
if (!schemaSql) problems.push("schema: missing");
else {
  if (schemaSql.length < 50_000) problems.push(`schema: only ${schemaSql.length} bytes — suspiciously small`);
  const owners = (schemaSql.match(/supabase_admin/g) ?? []).length;
  if (owners) problems.push(`schema: ${owners} supabase_admin ownership statements — wrong --schema flag (§4b.2)`);
  if (!schemaSql.includes('CREATE SCHEMA IF NOT EXISTS "public"')) problems.push("schema: no CREATE SCHEMA public");
  log(`  schema: ${owners === 0 ? "no supabase_admin ownership" : "OWNERSHIP PRESENT"}`);
}

const dataSql = read(dataFile);
let dumpedEvents = null;
if (!dataSql) problems.push("data: missing");
else {
  if (dataSql.length < 10_000) problems.push(`data: only ${dataSql.length} bytes — a partial write, not a dump`);
  if (!dataSql.startsWith("SET session_replication_role = replica;")) {
    problems.push("data: line 1 is not `SET session_replication_role = replica;` — restoring this re-mints every event hash (§5)");
  } else log("  data: session_replication_role = replica on line 1");
  for (const t of ['COPY "auth"."users"', 'COPY "public"."events"', 'COPY "storage"."objects"']) {
    if (!dataSql.includes(t)) problems.push(`data: missing ${t}`);
  }
  const m = dataSql.split('COPY "public"."events"')[1];
  if (m) {
    dumpedEvents = m.split("\n\\.")[0].split("\n").slice(1).filter((l) => l.trim() !== "").length;
    log(`  data: ${dumpedEvents} events in the dump`);
  }
}

if (rolesFile && statSync(rolesFile).size < 50) problems.push("roles: implausibly small");

const { count: liveEvents, error: cErr } = await sb.from("events").select("*", { count: "exact", head: true });
if (cErr) problems.push(`live count failed: ${cErr.message || "no response — check SUPABASE_URL and the service key"}`);
else {
  log(`  live:  ${liveEvents} events in production`);
  if (dumpedEvents !== null && dumpedEvents !== liveEvents) {
    problems.push(`EVENT COUNT MISMATCH: dump has ${dumpedEvents}, production has ${liveEvents}`);
  }
}

// ------------------------------------------------------------ checksums + list
const walk = (dir, base = dir) =>
  readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full).split(sep).join("/")];
  });

const files = walk(stageDir).filter((f) => f !== "SHA256SUMS" && f !== "manifest.json").sort();
writeFileSync(
  join(stageDir, "SHA256SUMS"),
  files.map((f) => `${sha256(readFileSync(join(stageDir, f)))}  ${f}`).join("\n") + "\n",
  { encoding: "utf8" },
);
writeFileSync(
  join(stageDir, "manifest.json"),
  JSON.stringify({
    takenAt: new Date().toISOString(),
    source: apiUrl,
    files: files.length,
    bytes: files.reduce((a, f) => a + statSync(join(stageDir, f)).size, 0),
    events: { inDump: dumpedEvents, live: liveEvents ?? null },
    storageIncluded: !skipStorage,
    verified: problems.length === 0,
    problems,
  }, null, 1),
);

// -------------------------------------------------------------------- promote
if (problems.length) {
  console.error(`\nBACKUP NOT TRUSTWORTHY — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\nDESTINATION NOT TOUCHED. ${existsSync(finalDir) ? `The existing ${stamp} set is intact.` : `No ${stamp} set was created.`}`);
  console.error(`Partial output left for inspection: ${stageDir}`);
} else {
  // Promote. The previous set is moved aside first and only deleted once the new
  // one is in place, so an interruption mid-swap still leaves a complete set.
  const parked = `${finalDir}.replacing-${process.pid}`;
  if (existsSync(finalDir)) renameSync(finalDir, parked);
  try {
    renameSync(stageDir, finalDir);
  } catch {
    // Cross-device or a locked handle (OneDrive does this): copy, then continue.
    cpSync(stageDir, finalDir, { recursive: true });
    rmSync(stageDir, { recursive: true, force: true });
  }
  if (existsSync(parked)) rmSync(parked, { recursive: true, force: true });
  rmSync(stagingRoot, { recursive: true, force: true });

  const total = files.reduce((a, f) => a + statSync(join(finalDir, f)).size, 0);
  log(`\n${files.length} files, ${(total / 1024).toFixed(0)} KB, SHA256SUMS written`);

  /**
   * Retention. Deliberately timid, because pruning backups is the one cleanup
   * that turns a bad night into a disaster: only folders this script made (they
   * have a manifest.json), only ones marked verified:true, keeping the N most
   * recent. The hand-rolled historical sets have no manifest and are untouchable.
   */
  const keep = Number(arg("--keep", 0));
  if (keep > 0) {
    const managed = readdirSync(outRoot)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && existsSync(join(outRoot, d, "manifest.json")))
      .filter((d) => {
        try { return JSON.parse(readFileSync(join(outRoot, d, "manifest.json"), "utf8")).verified === true; }
        catch { return false; }
      })
      .sort();
    for (const d of managed.slice(0, Math.max(0, managed.length - keep))) {
      rmSync(join(outRoot, d), { recursive: true, force: true });
      log(`  pruned ${d}`);
    }
    log(`  retention: kept ${Math.min(managed.length, keep)} of ${managed.length} verified sets (--keep ${keep}); unmanaged sets untouched`);
  }
  log("\nverified — every check passed");
}

/**
 * Set exitCode rather than calling process.exit(): exiting while supabase-js
 * still holds a keep-alive socket trips a libuv assertion on Windows and the
 * process dies with 127 instead of the code we meant, so a scheduler records a
 * crash where it should record a clean failure. The unref'd timer is the belt,
 * so a stuck socket cannot hang a scheduled job.
 */
process.exitCode = problems.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 5000).unref();
