#!/usr/bin/env node
/**
 * One command that takes a COMPLETE, SELF-VERIFIED backup set.
 *
 *   SUPABASE_DB_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/backup/capture.mjs
 *
 *   --out <dir>   backup root (default ../gnk-backups)
 *   --force       overwrite today's folder if it already exists
 *   --skip-storage  database only (Storage rarely changes; see §2)
 *
 * Produces ../gnk-backups/<YYYY-MM-DD>/ containing pg_dump.sql, data.sql,
 * roles.sql, the Storage objects and table JSON from export.mjs, SHA256SUMS and
 * manifest.json — then CHECKS ITS OWN OUTPUT and exits non-zero if anything is
 * wrong. See docs/BACKUP_RESTORE.md §3.
 *
 * WHY THE VERIFICATION IS THE POINT
 * ---------------------------------
 * An unattended backup that silently produces a broken file is worse than no
 * backup, because it also produces confidence. Every failure mode below is one
 * this project has actually hit:
 *
 *   - `--schema public,auth,storage` on the SCHEMA dump emits ownership
 *     statements no role can execute; the restore dies at line 19 having created
 *     nothing (§4b.2). Checked: zero `supabase_admin` in the schema file.
 *   - `data.sql` must start `SET session_replication_role = replica;` or
 *     `trg_events_hash` re-mints every hash on restore and the chain then
 *     verifies against invented values (§5). Checked: literally line 1.
 *   - A failed `db dump` STILL CREATES the -f file, empty. A 0-byte pg_dump.sql
 *     in a backup folder reads as a backup. Checked: size floors, and partial
 *     output is deleted on failure.
 *   - A dump can be truncated without erroring. Checked: the row count inside
 *     data.sql's events COPY block against the LIVE count.
 *
 * CREDENTIALS come from the environment and are never logged, never written to
 * the output, and never echoed in an error. SUPABASE_DB_URL contains the
 * database password — see §3.1 on where that may and may not go.
 */
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
// The pooler needs the project ref in the username. Plain `postgres` fails as
// `password authentication failed for user "postgres"`, which reads like a wrong
// password and is not — it cost three attempts on 2026-08-06 (§3.1). Only applies
// to pooler hosts; a local stack legitimately uses the bare role.
if (dbUrl.includes("pooler.supabase.com") && /:\/\/postgres:/.test(dbUrl)) {
  console.error("SUPABASE_DB_URL targets the pooler with the bare user 'postgres'. It needs 'postgres.<project-ref>' (§3.1).");
  process.exit(2);
}

const stamp = new Date().toISOString().slice(0, 10);
const outDir = join(outRoot, stamp);
if (existsSync(outDir) && !force) {
  console.error(`${outDir} already exists. Re-run with --force to replace today's set.`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const sb = createClient(apiUrl, svcKey, { auth: { persistSession: false } });
const problems = [];
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const log = (s) => console.log(s);

/** Never let the connection string reach stdout, a log file or an exception. */
const redact = (s) => String(s ?? "").split(dbUrl).join("[DB_URL REDACTED]");

/**
 * The Supabase CLI is not a dependency here — `npx` fetches it — so it has to be
 * reached through the npx wrapper. On Windows that wrapper is `npx.cmd`, and
 * Node has refused to spawn `.cmd`/`.bat` directly since 18.20 (a command-
 * injection fix): it fails with status `null` and an EINVAL in `error`, which
 * looks exactly like the command not existing. Going through `cmd.exe /c` with a
 * real argument array works and, because nothing is string-concatenated, keeps
 * the quoting hazard out of it.
 *
 * The connection string is still an argv entry of the child, as it is when a
 * human types the command. That is not a regression, but it does mean the
 * password is briefly visible to anything that can enumerate process command
 * lines on this machine — worth knowing before scheduling this somewhere shared.
 */
function cliArgs(rest) {
  return process.platform === "win32"
    ? ["cmd.exe", ["/c", "npx.cmd", "supabase", ...rest]]
    : ["npx", ["supabase", ...rest]];
}

function dump(label, extraArgs, file) {
  const target = join(outDir, file);
  const [cmd, base] = cliArgs(["db", "dump", "--db-url", dbUrl, ...extraArgs, "-f", target]);
  const r = spawnSync(cmd, base, { encoding: "utf8", shell: false });
  if (r.status !== 0) {
    // A failed dump leaves an empty file behind; remove it so nothing downstream
    // mistakes it for output.
    if (existsSync(target) && statSync(target).size === 0) rmSync(target);
    const why = r.error ? r.error.message : redact(r.stderr).trim().split("\n").slice(-2).join(" ");
    problems.push(`${label}: exit ${r.status} — ${redact(why)}`);
    return null;
  }
  const bytes = statSync(target).size;
  log(`  ${label.padEnd(8)} ${String(bytes).padStart(8)} bytes`);
  return target;
}

log(`capture ${stamp} -> ${outDir}\n`);
log("dumps");
const schemaFile = dump("schema", ["--schema", "public"], "pg_dump.sql");
const dataFile = dump("data", ["--schema", "public,auth,storage", "--data-only", "--use-copy"], "data.sql");
const rolesFile = dump("roles", ["--role-only"], "roles.sql");

if (!skipStorage) {
  log("\nstorage + table json (export.mjs)");
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "export.mjs"), "--out", outRoot], {
    encoding: "utf8",
    env: { ...process.env },
  });
  if (r.status !== 0) problems.push(`export.mjs: exit ${r.status} — ${redact(r.stderr).trim().split("\n").slice(-2).join(" ")}`);
  else log("  ok");
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
  if (!dataSql.startsWith("SET session_replication_role = replica;")) {
    problems.push("data: line 1 is not `SET session_replication_role = replica;` — restoring this re-mints every event hash (§5)");
  } else log("  data: session_replication_role = replica on line 1");

  for (const t of ['COPY "auth"."users"', 'COPY "public"."events"', 'COPY "storage"."objects"']) {
    if (!dataSql.includes(t)) problems.push(`data: missing ${t}`);
  }
  // Count rows inside the events COPY block: everything up to the \. terminator.
  const m = dataSql.split('COPY "public"."events"')[1];
  if (m) {
    const block = m.split("\n\\.")[0].split("\n").slice(1);
    dumpedEvents = block.filter((l) => l.trim() !== "").length;
    log(`  data: ${dumpedEvents} events in the dump`);
  }
}

if (rolesFile && statSync(rolesFile).size < 50) problems.push("roles: implausibly small");

// Compare against the LIVE database — a truncated dump does not error.
const { count: liveEvents, error: cErr } = await sb.from("events").select("*", { count: "exact", head: true });
if (cErr) problems.push(`live count failed: ${cErr.message}`);
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

const files = walk(outDir).filter((f) => f !== "SHA256SUMS" && f !== "manifest.json").sort();
writeFileSync(
  join(outDir, "SHA256SUMS"),
  files.map((f) => `${sha256(readFileSync(join(outDir, f)))}  ${f}`).join("\n") + "\n",
  { encoding: "utf8" },
);

const manifest = {
  takenAt: new Date().toISOString(),
  source: apiUrl,
  files: files.length,
  bytes: files.reduce((a, f) => a + statSync(join(outDir, f)).size, 0),
  events: { inDump: dumpedEvents, live: liveEvents ?? null },
  storageIncluded: !skipStorage,
  verified: problems.length === 0,
  problems,
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));

log(`\n${files.length} files, ${(manifest.bytes / 1024).toFixed(0)} KB, SHA256SUMS written`);

/**
 * Retention. Nightly sets are ~250 KB, so a year is ~90 MB on a disk that runs
 * tight (HANDOFF §7). Deliberately timid, because pruning backups is the one
 * cleanup that can turn a bad night into a disaster:
 *
 *   - only ever considers folders THIS SCRIPT made, i.e. ones holding a
 *     manifest.json. The hand-rolled 2026-07-30 / 07-31 / 08-04 / 08-06 sets have
 *     no manifest and are therefore untouchable by it.
 *   - only prunes sets marked verified:true. A failed set is evidence about a
 *     failure and is kept until a human looks at it.
 *   - keeps the N most recent regardless.
 *
 * Off by default. The scheduled task passes --keep.
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
  const prune = managed.slice(0, Math.max(0, managed.length - keep));
  for (const d of prune) {
    rmSync(join(outRoot, d), { recursive: true, force: true });
    log(`  pruned ${d}`);
  }
  log(`  retention: ${managed.length - prune.length}/${managed.length} verified sets kept (--keep ${keep}); unmanaged sets untouched`);
}

if (problems.length) {
  console.error(`\nBACKUP NOT TRUSTWORTHY — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nmanifest.json records verified:false. Do not rely on this set.");
} else {
  log("\nverified — every check passed");
}

/**
 * Set exitCode rather than calling process.exit().
 *
 * process.exit() while supabase-js still holds a keep-alive socket trips a libuv
 * assertion on Windows — `!(handle->flags & UV_HANDLE_CLOSING)` — and the process
 * dies with 127 instead of the code we meant. A scheduler then records a crash
 * where it should record a clean "backup failed", which is the difference
 * between an alert someone acts on and one they learn to ignore.
 *
 * The unref'd timer is the belt: if a socket somehow never drains, exit anyway
 * rather than leaving a scheduled job hanging until its timeout.
 */
process.exitCode = problems.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 5000).unref();
