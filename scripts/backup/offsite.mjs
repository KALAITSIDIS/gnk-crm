#!/usr/bin/env node
/**
 * The automated off-site leg of the nightly backup (audit 2026-08-29, REL-01).
 *
 *   node --env-file=... scripts/backup/offsite.mjs [--src <gnk-backups root>]
 *                                                  [--dest <offsite dir>]
 *                                                  [--keep N]
 *
 *   --src   backup root (default D:\dev\TSOPOZIDIS\gnk-backups)
 *   --dest  offsite directory (default env OFFSITE_DIR)
 *   --keep  dated archives to keep at the destination (default 7)
 *
 * Exit codes, because a scheduler only ever sees the number:
 *   0  archive copied and verified at the destination (or SKIPPED: no
 *      destination configured — an unconfigured machine must not fail nights)
 *   1  configured but something failed — archive, verify, copy, or re-verify
 *
 * WHY THIS EXISTS. Until 2026-08-29 every backup set lived on ONE machine:
 * `gnk-backups/` on D:, the "offsite" tar beside it on the same D:, and a USB
 * that never left the building (BACKUP_RESTORE §3.3). Fire, theft or
 * ransomware plus any Supabase project loss would have been TOTAL loss of the
 * commission-evidence chain. This script makes the off-site copy a nightly
 * side effect instead of a standing chore.
 *
 * THE DESTINATION IS A SYNCED FOLDER (OneDrive), AND §3.3's OBJECTION TO THAT
 * IS REAL: sync propagates a local deletion or encryption. The design blunts
 * it rather than ignoring it — each night writes a NEW dated file (never
 * rewrites yesterday's), the destination copy is re-hashed after the copy,
 * retention deletes only what `--keep` says to, and OneDrive's own versioning
 * backstops a corrupted overwrite. The USB remains the second, offline copy.
 * The operator accepted this trade on 2026-08-29 (DECISIONS T-offsite).
 *
 * WHAT "VERIFIED" MEANS HERE, in order:
 *   1. the newest verified set's own SHA256SUMS re-checks on disk BEFORE
 *      archiving (a tar of corrupt files would "verify" at the destination);
 *   2. the produced tar LISTS cleanly and contains that newest set;
 *   3. the DESTINATION copy is re-read and its sha256 must equal the staged
 *      archive's — a checksum computed only on the source proves nothing
 *      about what arrived (§3.3).
 * Whether the file then reaches Microsoft's servers is OneDrive's job; that
 * is the one hop this machine cannot attest.
 *
 * No credential is read, logged, or written — the archive contents are
 * whatever capture.mjs already produced.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const args = process.argv.slice(2);
const arg = (n, d) => (args.indexOf(n) !== -1 ? args[args.indexOf(n) + 1] : d);

const srcRoot = arg("--src", "D:\\dev\\TSOPOZIDIS\\gnk-backups");
const dest = arg("--dest", process.env.OFFSITE_DIR ?? "");
const keep = Math.max(1, Number(arg("--keep", 7)) || 7);

const log = (m) => console.log(m);
const fail = (m) => { console.error(`offsite: ${m}`); process.exitCode = 1; };

if (!dest) {
  // Not an error: a machine without a destination configured must keep taking
  // local backups. The run-backup log line is the honest record of the skip.
  log("offsite: SKIPPED — no --dest and no OFFSITE_DIR in the environment");
  process.exit(0);
}
if (!existsSync(srcRoot)) { fail(`source not found: ${srcRoot}`); process.exit(1); }

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// ---------------------------------------------------------- newest verified --
const sets = readdirSync(srcRoot)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && existsSync(join(srcRoot, d, "manifest.json")))
  .filter((d) => {
    try { return JSON.parse(readFileSync(join(srcRoot, d, "manifest.json"), "utf8")).verified === true; }
    catch { return false; }
  })
  .sort();
if (!sets.length) { fail("no verified set to ship"); process.exit(1); }
const newest = sets[sets.length - 1];

// 1. The newest set must re-verify on disk before it is worth shipping.
const sums = readFileSync(join(srcRoot, newest, "SHA256SUMS"), "utf8")
  .split("\n").map((l) => l.trim()).filter(Boolean);
let checked = 0;
for (const line of sums) {
  const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
  if (!m) { fail(`unparseable SHA256SUMS line in ${newest}: ${line}`); process.exit(1); }
  const [, want, rel] = m;
  const p = join(srcRoot, newest, rel);
  if (!existsSync(p)) { fail(`${newest}/${rel} named in SHA256SUMS but missing`); process.exit(1); }
  if (sha256(p) !== want) { fail(`${newest}/${rel} does not match its recorded hash — NOT shipping a corrupt set`); process.exit(1); }
  checked++;
}
log(`offsite: newest verified set ${newest} re-verified on disk (${checked}/${sums.length} hashes OK)`);

// ------------------------------------------------------------------ archive --
// Whole-folder archive, per the §3.3 convention: one file, one checksum, and
// every retained set travels — so the destination is never a partial history.
const stamp = new Date().toISOString().slice(0, 10);
const name = `gnk-backups-offsite-${stamp}.tar.gz`;
const stage = mkdtempSync(join(tmpdir(), "gnk-offsite-"));
const staged = join(stage, name);

// The -f argument is RELATIVE with cwd pinned to the staging dir: a GNU tar
// on PATH (Git for Windows ships one) reads the colon in "C:\..." as a
// remote-host spec and dies with "Cannot write: Broken pipe" — measured on
// the first live run. -C paths are exempt from that parsing.
const tar = spawnSync("tar", ["-czf", name, "-C", dirname(srcRoot), basename(srcRoot)], { encoding: "utf8", cwd: stage });
if (tar.status !== 0) {
  fail(`tar exited ${tar.status}: ${(tar.stderr || "").trim().split("\n").slice(-3).join(" | ")}`);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}

// 2. The tar must list cleanly and contain the newest set.
const list = spawnSync("tar", ["-tzf", name], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: stage });
if (list.status !== 0 || !list.stdout.includes(`${newest}/manifest.json`)) {
  fail(`archive does not list cleanly or lacks ${newest}/manifest.json`);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}
const entries = list.stdout.split("\n").filter(Boolean).length;
const digest = sha256(staged);
writeFileSync(join(stage, `${name}.sha256`), `${digest}  ${name}\n`);
log(`offsite: ${name} — ${entries} entries, ${(statSync(staged).size / 1024 / 1024).toFixed(1)} MB, sha256 ${digest.slice(0, 16)}…`);

// --------------------------------------------------------------------- copy --
mkdirSync(dest, { recursive: true });
copyFileSync(staged, join(dest, name));
copyFileSync(join(stage, `${name}.sha256`), join(dest, `${name}.sha256`));
rmSync(stage, { recursive: true, force: true });

// 3. Verify AT the destination: re-read what landed, not what was sent.
const landed = sha256(join(dest, name));
if (landed !== digest) {
  fail(`destination copy hash mismatch — sent ${digest.slice(0, 16)}…, landed ${landed.slice(0, 16)}…`);
  process.exit(1);
}
log(`offsite: destination copy re-hashed OK at ${join(dest, name)}`);

// ---------------------------------------------------------------- retention --
// Only files THIS script names get pruned; the dated pattern is the manifest.
const dated = readdirSync(dest)
  .filter((f) => /^gnk-backups-offsite-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f))
  .sort();
for (const f of dated.slice(0, Math.max(0, dated.length - keep))) {
  rmSync(join(dest, f), { force: true });
  rmSync(join(dest, `${f}.sha256`), { force: true });
  log(`offsite: pruned ${f}`);
}
log(`offsite: retention keeps ${Math.min(dated.length, keep)} of ${dated.length} dated archives (--keep ${keep})`);
log("offsite: done — copied and verified at the destination");
