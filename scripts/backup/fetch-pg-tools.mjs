#!/usr/bin/env node
/**
 * Installs the pinned PostgreSQL client tools capture.mjs runs — pg_dump,
 * pg_dumpall, psql, pg_restore and their DLLs — into ~/.gnk-crm/pgsql/<ver>/bin,
 * next to backup.env and outside both the repo and OneDrive.
 *
 *   node scripts/backup/fetch-pg-tools.mjs [--dest <bin dir>] [--force]
 *
 * The pin (version, URL, SHA-256) is PG_TOOLS in pg-native.mjs — one place.
 * The archive is hashed while it streams and deleted on mismatch; nothing is
 * extracted from bytes that do not match the published sum. Idempotent: a
 * second run finds pg_dump and exits 0 without downloading.
 *
 * Windows only, on purpose: the task this serves runs on this Windows box.
 * Elsewhere, install postgresql-client from the package manager and set PG_BIN.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EXE, PG_TOOLS, defaultToolsDir } from "./pg-native.mjs";

const args = process.argv.slice(2);
const arg = (n, d) => (args.indexOf(n) !== -1 ? args[args.indexOf(n) + 1] : d);
const binDir = arg("--dest", defaultToolsDir());
const pgDump = join(binDir, "pg_dump" + EXE);

function report() {
  const v = spawnSync(pgDump, ["--version"], { encoding: "utf8", windowsHide: true });
  console.log(`${binDir}\n${(v.stdout || v.stderr || "").trim()}`);
  if (v.status !== 0) process.exit(1);
}

if (process.platform !== "win32") {
  console.error(
    "fetch-pg-tools.mjs pins the Windows build only. Install postgresql-client from your package manager and set PG_BIN in backup.env.",
  );
  process.exit(2);
}
if (existsSync(pgDump) && !args.includes("--force")) {
  console.log("already present (use --force to re-fetch)");
  report();
  process.exit(0);
}

mkdirSync(binDir, { recursive: true });
const zip = join(binDir, "..", "download.zip");
console.log(`downloading ${PG_TOOLS.url}`);
const res = await fetch(PG_TOOLS.url);
if (!res.ok || !res.body) {
  console.error(`download failed: HTTP ${res.status}`);
  process.exit(1);
}
const hash = createHash("sha256");
await pipeline(
  Readable.fromWeb(res.body),
  new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  }),
  createWriteStream(zip),
);
const got = hash.digest("hex");
if (got !== PG_TOOLS.sha256) {
  rmSync(zip, { force: true });
  console.error(`SHA-256 mismatch — expected ${PG_TOOLS.sha256}, got ${got}. Download deleted, nothing extracted.`);
  process.exit(1);
}
console.log(`sha256 ok, ${(statSync(zip).size / 1048576).toFixed(1)} MB`);

// bsdtar ships with Windows 10+ and reads zip archives. The `tar` on PATH under
// Git Bash is GNU tar, which does not, so the System32 one is named explicitly.
const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const members = ["pg_dump.exe", "pg_dumpall.exe", "psql.exe", "pg_restore.exe", "*.dll"].map(
  (m) => `${PG_TOOLS.archivePrefix}bin/${m}`,
);
const x = spawnSync(tar, ["-xf", zip, "-C", binDir, "--strip-components", "2", ...members], { encoding: "utf8", windowsHide: true });
if (x.status !== 0) {
  console.error(`extract failed (${x.status}): ${x.stderr}`);
  process.exit(1);
}
rmSync(zip, { force: true });
report();
