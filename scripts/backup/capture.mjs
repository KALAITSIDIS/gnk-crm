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
 *   - The CLI emits NO `CREATE EXTENSION`, so the schema dump is given one and
 *     the result is checked: without it a restore into a fresh database dies on
 *     `type "public.geography" does not exist` (§4b.1, §4d).
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
// A legacy JWT service key fails every REST request with "Legacy API keys are
// disabled" (HANDOFF §2b, disabled 2026-08-03). The dumps would still succeed —
// they use the database password — so without this the run gets most of the way
// and then fails on Storage and the live count, which reads like a network fault.
// The local stack legitimately uses a demo JWT, so only guard hosted.
if (key_isLegacy(svcKey) && !apiUrl.includes("127.0.0.1") && !apiUrl.includes("localhost")) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is a legacy JWT key (starts 'eyJ'). Those were disabled 2026-08-03 — use the sb_secret_… key (§2b).");
  process.exit(2);
}
function key_isLegacy(k) { return k.startsWith("eyJ"); }

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

/**
 * THE EXTENSIONS THE SCHEMA CANNOT LOAD WITHOUT, and the reason each is here.
 *
 * `supabase db dump --schema public` emits ZERO `CREATE EXTENSION` statements.
 * Until this was fixed, every set in this repository failed to restore into a
 * fresh database: 112 errors rooted in `type "public.geography" does not exist`,
 * and `areas`, `districts`, `properties` and `viewing_slips` were never created
 * at all. Found in the 2026-08-05 drill (BACKUP_RESTORE §4b.1) and reproduced
 * UNCHANGED twenty-one days later in the §4d drill on 2026-08-26.
 *
 * It lived in the runbook as "enable the extensions by hand before restoring".
 * That is a step a human has to remember while the business is down, which is
 * exactly when it will be missed — so the dump now carries it.
 *
 * NOT included, deliberately: `pg_cron`. The scheduled jobs (8 as of 0063)
 * are absent after any restore because they live in `cron.job`, which no dump
 * here covers (§4b.4). Creating the extension would imply that gap is closed.
 * It is not.
 */
const REQUIRED_EXTENSIONS = [
  ["postgis", "properties.location and the area/district centroids are geography(point,4326)"],
  ["pg_trgm", "the gin_trgm_ops indexes behind contact and property search"],
  ["pgcrypto", "gen_random_uuid() column defaults"],
  ["uuid-ossp", "uuid_generate_v*() defaults on the older tables"],
];

/**
 * Marker in the dump -> the extension that must supply it. Used to CHECK the
 * list above still covers what the schema actually references, so that adding a
 * PostGIS column years from now cannot silently outrun this file.
 *
 * NOT EXHAUSTIVE, and it cannot be: it only knows the extensions the project
 * uses today. `INDEX_METHOD_GUARD` below is the broader net — an index built
 * with an access method Postgres does not ship is proof of an extension nobody
 * listed here.
 */
/*
 * QUOTE-TOLERANT ON PURPOSE. The CLI emits fully quoted, schema-qualified
 * identifiers — `"public"."geography"(Point,4326)`, `"public"."gin_trgm_ops"` —
 * so the obvious /public\.geography/ matches NOTHING. The first version of this
 * guard did exactly that, and passed a dump with postgis deliberately removed
 * from the list above: it reported "every check passed" on a set that could not
 * restore. Caught by RUNNING that negative case rather than trusting the regex,
 * which is the only reason this comment exists.
 */
const EXTENSION_MARKERS = [
  [/"?public"?\.\s*"?(geography|geometry)"?/i, "postgis"],
  [/"?(gin|gist)_trgm_ops"?|"?similarity"?\s*\(/i, "pg_trgm"],
  [/"?gen_random_uuid"?\s*\(|"?crypt"?\s*\(|"?digest"?\s*\(/i, "pgcrypto"],
  [/"?uuid_generate_v\d"?/i, "uuid-ossp"],
];

/** Access methods core Postgres ships. Anything else came from an extension. */
const INDEX_METHOD_GUARD = new Set(["btree", "hash", "gist", "gin", "brin", "spgist"]);

/** Lets the preamble be found again, by the checks below and by a human. */
const EXT_MARK = "-- gnk: extension preamble (added by scripts/backup/capture.mjs)";
const EXT_MARK_END = "-- gnk: end extension preamble";

/**
 * Splice the preamble in AFTER `CREATE SCHEMA IF NOT EXISTS "public"`, not at
 * the top of the file: on this project PostGIS installs INTO `public`, so the
 * schema has to exist first. Idempotent, so a re-run cannot double it.
 */
function addExtensionPreamble(file) {
  if (!file) return;
  const sql = readFileSync(file, "utf8");
  if (sql.includes(EXT_MARK)) return;

  const anchor = 'CREATE SCHEMA IF NOT EXISTS "public";';
  if (!sql.includes(anchor)) {
    problems.push(`schema: cannot place the extension preamble — '${anchor}' not found (§4b.1)`);
    return;
  }

  const body = [
    "",
    "",
    EXT_MARK,
    "--",
    "-- The CLI does not emit these and the schema below cannot load without them.",
    "-- See docs/BACKUP_RESTORE.md §4b.1 and §4d. Safe to re-run; safe on a target",
    "-- that already has them.",
    ...REQUIRED_EXTENSIONS.map(([n, why]) => `-- ${n}: ${why}`),
    "",
    ...REQUIRED_EXTENSIONS.map(([n]) =>
      `CREATE EXTENSION IF NOT EXISTS ${/^[a-z_]+$/.test(n) ? n : `"${n}"`} WITH SCHEMA "public";`),
    "",
    "-- NOTE: pg_cron is NOT here. The scheduled sweeps live in `cron.job`,",
    "-- which no dump in this set covers, so they are gone after a restore and",
    "-- must be recreated from the migrations (§4b.4).",
    EXT_MARK_END,
    "",
  ].join("\n");

  writeFileSync(file, sql.replace(anchor, anchor + body), { encoding: "utf8" });
  log(`  schema: extension preamble added (${REQUIRED_EXTENSIONS.map(([n]) => n).join(", ")})`);
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
/**
 * `events_parts` IS IN BOTH DUMPS SINCE 0063 (found 2026-08-29, the FIRST
 * capture against partitioned production). Migration 0063 moved the events
 * rows into monthly partitions living in the `events_parts` schema — the
 * parent `public.events` owns no rows of its own — so a `--schema public`
 * data dump silently contains ZERO events, and a schema dump without the
 * partition DDL restores into a database whose events table has no
 * partitions and refuses every insert. The verification below caught it
 * ("missing COPY public.events" + count mismatch) and refused to promote,
 * which is the system working; this is the fix.
 */
const schemaFile = dump("schema", ["--schema", "public,events_parts"], "pg_dump.sql");
addExtensionPreamble(schemaFile);
const dataFile = dump("data", ["--schema", "public,events_parts,auth,storage", "--data-only", "--use-copy"], "data.sql");
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

  // ---- the extension preamble, and whether it still covers what is used -----
  // A set without this restores into a fresh database as 112 errors and four
  // missing tables (§4b.1, §4d), so its absence makes the set untrustworthy
  // rather than merely imperfect.
  if (!schemaSql.includes(EXT_MARK)) {
    problems.push("schema: no CREATE EXTENSION preamble — restore into a fresh database WILL fail (§4b.1)");
  } else {
    const listed = REQUIRED_EXTENSIONS.map(([n]) => n);
    // Scan the SCHEMA ITSELF, never the preamble: its comment lines name
    // "geography" and "gin_trgm_ops", so a guard reading the whole file would
    // be satisfied by its own text and report coverage that is not there.
    const bodySql = schemaSql.includes(EXT_MARK_END)
      ? schemaSql.slice(0, schemaSql.indexOf(EXT_MARK)) +
        schemaSql.slice(schemaSql.indexOf(EXT_MARK_END) + EXT_MARK_END.length)
      : schemaSql;
    for (const [re, ext] of EXTENSION_MARKERS) {
      if (re.test(bodySql) && !listed.includes(ext)) {
        problems.push(`schema: uses ${ext} but the preamble does not create it (§4b.1)`);
      }
    }
    // The broader net: an index access method core Postgres does not ship is an
    // extension this file has never heard of. Catches the case the marker list
    // structurally cannot.
    for (const m of bodySql.matchAll(/USING\s+"?([a-z_]+)"?\s*\(/gi)) {
      const method = m[1].toLowerCase();
      if (!INDEX_METHOD_GUARD.has(method)) {
        problems.push(`schema: index access method "${method}" is not core Postgres — an extension is missing from REQUIRED_EXTENSIONS (§4b.1)`);
        break;
      }
    }
    log(`  schema: extension preamble present (${listed.join(", ")})`);
  }
}

const dataSql = read(dataFile);
let dumpedEvents = null;
if (!dataSql) problems.push("data: missing");
else {
  if (dataSql.length < 10_000) problems.push(`data: only ${dataSql.length} bytes — a partial write, not a dump`);
  if (!dataSql.startsWith("SET session_replication_role = replica;")) {
    problems.push("data: line 1 is not `SET session_replication_role = replica;` — restoring this re-mints every event hash (§5)");
  } else log("  data: session_replication_role = replica on line 1");
  for (const t of ['COPY "auth"."users"', 'COPY "storage"."objects"']) {
    if (!dataSql.includes(t)) problems.push(`data: missing ${t}`);
  }
  /**
   * Events are PARTITIONED since 0063: the parent `public.events` emits no
   * COPY at all — the rows arrive as one COPY block PER PARTITION in the
   * `events_parts` schema (that schema holds nothing else). Sum them; the
   * cross-check against the live count below is what catches a dump that
   * silently lost a partition.
   */
  const partSegs = dataSql.split('COPY "events_parts"."').slice(1);
  if (!partSegs.length) {
    problems.push('data: no COPY "events_parts".* blocks — the partitioned events data is MISSING (0063)');
  } else {
    dumpedEvents = 0;
    for (const seg of partSegs) {
      // each segment: <partition>" (cols) FROM stdin;\n<rows...>\n\. — an
      // empty partition has no row lines and contributes zero
      dumpedEvents += seg.split("\n\\.")[0].split("\n").slice(1).filter((l) => l.trim() !== "").length;
    }
    log(`  data: ${dumpedEvents} events in the dump across ${partSegs.length} partition(s)`);
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
