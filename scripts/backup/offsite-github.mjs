#!/usr/bin/env node
/**
 * The ATTESTED off-machine backup leg (REL-01 residual, 2026-09-02).
 *
 *   node --env-file="C:\Users\user\.gnk-crm\backup.env" scripts/backup/offsite-github.mjs
 *   node ... offsite-github.mjs --repo OWNER/REPO --src <OFFSITE_DIR> --keep 7 [--auth keyring]
 *
 * WHY THIS EXISTS. offsite.mjs re-hashes the archive at OFFSITE_DIR — but
 * OFFSITE_DIR is a OneDrive folder ON THIS MACHINE, and its own header says
 * so: "Whether the file then reaches Microsoft's servers is OneDrive's job;
 * that is the one hop this machine cannot attest." Paused sync, a full quota
 * or a signed-out client means every verified copy is still in one building
 * and nothing alarms — which is REL-01's original defect wearing a green
 * checkmark (found by the 2026-09-01 artifact verification). This leg closes
 * the hop: it uploads the same nightly archive to a PRIVATE GitHub repo as a
 * release asset, RE-DOWNLOADS it from api.github.com, and compares SHA-256.
 * A hash match here is proof the bytes exist off-machine, not hope.
 *
 * DESTINATION. GH_BACKUP_REPO (default env) — a PRIVATE repo, never gnk-crm:
 * the code repo is PUBLIC and the archive holds auth.users bcrypt hashes,
 * signed viewing slips and evidence PDFs (BACKUP_RESTORE §3.3 sensitivity
 * block). The script refuses a public target outright, checked per run.
 *
 * AUTH. GH_TOKEN from backup.env (the S4U nightly cannot open the user's
 * keyring — same class as the Vercel/Supabase tokens, and the operator adds
 * it BY HAND, never through an agent). Until GH_TOKEN is set the leg SKIPS
 * with rc 0 — an unarmed leg must not fail nights (the offsite.mjs rule).
 * `--auth keyring` exists for interactive proof runs only: it lets a
 * logged-on session use gh's own keyring credential instead. The token is
 * never logged; gh reads it from the environment, not from argv.
 *
 * EXIT CODES (what the scheduler sees): 0 = uploaded, re-downloaded and
 * hash-verified (or SKIPPED: not yet armed); 1 = armed but something failed
 * — the night's rc goes non-zero, notify.mjs pings /fail, the dead-man
 * emails.
 *
 * RETENTION. Prunes only releases whose tag matches backup-YYYY-MM-DD,
 * oldest first beyond --keep (default 7) — the offsite.mjs pattern-scoped
 * prune, so nothing else in the repo is ever touched.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (n, d) => (args.indexOf(n) !== -1 ? args[args.indexOf(n) + 1] : d);

const repo = arg("--repo", process.env.GH_BACKUP_REPO ?? "");
const srcDir = arg("--src", process.env.OFFSITE_DIR ?? "");
const keep = Math.max(1, Number(arg("--keep", 7)) || 7);
const auth = arg("--auth", process.env.GH_TOKEN ? "env" : "");

const log = (m) => console.log(m);
const fail = (m) => {
  console.error(`offsite-gh: ${m}`);
  process.exitCode = 1;
};

if (!repo || !auth) {
  log(
    "offsite-gh: SKIPPED — armed only when GH_BACKUP_REPO and GH_TOKEN are both " +
      "in backup.env (the operator adds GH_TOKEN by hand; --auth keyring for an " +
      "interactive proof run)",
  );
  process.exit(0);
}
if (!srcDir || !existsSync(srcDir)) {
  fail(`--src / OFFSITE_DIR missing or not a directory: ${srcDir || "(unset)"}`);
  process.exit(1);
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** gh with trimmed output; stderr kept to the last lines, which never carry the token */
function gh(ghArgs, opts = {}) {
  const res = spawnSync("gh", ghArgs, { encoding: "utf8", ...opts });
  if (res.error) return { ok: false, out: "", err: String(res.error.message) };
  const err = (res.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
  return { ok: res.status === 0, out: (res.stdout ?? "").trim(), err };
}

// ---------- 0. the target must be PRIVATE, proven per run ----------
const vis = gh(["repo", "view", repo, "--json", "visibility", "--jq", ".visibility"]);
if (!vis.ok) {
  fail(`cannot read ${repo} (auth? repo exists?): ${vis.err}`);
  process.exit(1);
}
if (vis.out.toUpperCase() !== "PRIVATE") {
  fail(`${repo} is ${vis.out}, not PRIVATE — refusing to ship the archive there`);
  process.exit(1);
}

// ---------- 1. newest local archive, sidecar-verified before shipping ----------
const archives = readdirSync(srcDir)
  .filter((f) => /^gnk-backups-offsite-\d{4}-\d{2}-\d{2}\.tar\.gz$/.test(f))
  .sort();
if (archives.length === 0) {
  fail(`no gnk-backups-offsite-*.tar.gz in ${srcDir} — did offsite.mjs run?`);
  process.exit(1);
}
const name = archives[archives.length - 1];
const archive = join(srcDir, name);
const sidecar = `${archive}.sha256`;
if (!existsSync(sidecar)) {
  fail(`${name} has no .sha256 sidecar — refusing to ship an unverified archive`);
  process.exit(1);
}
const localDigest = sha256(archive);
const sidecarDigest = readFileSync(sidecar, "utf8").trim().split(/\s+/)[0];
if (localDigest !== sidecarDigest) {
  fail(`${name} does not match its sidecar (local ${localDigest.slice(0, 12)}… vs ${sidecarDigest.slice(0, 12)}…)`);
  process.exit(1);
}
log(`offsite-gh: shipping ${name} (${(readFileSync(archive).length / 1048576).toFixed(1)} MB, sha256 ${localDigest.slice(0, 12)}…)`);

// ---------- 2. upload as a release asset (idempotent via --clobber) ----------
const tag = `backup-${name.match(/(\d{4}-\d{2}-\d{2})/)[1]}`;
const exists = gh(["release", "view", tag, "--repo", repo, "--json", "tagName"]);
if (!exists.ok) {
  const created = gh([
    "release", "create", tag,
    "--repo", repo,
    "--title", tag,
    "--notes", `Nightly verified set, shipped ${new Date().toISOString()}. sha256 ${localDigest}`,
  ]);
  if (!created.ok) {
    fail(`release create ${tag} failed: ${created.err}`);
    process.exit(1);
  }
  log(`offsite-gh: release ${tag} created`);
}
const uploaded = gh(["release", "upload", tag, archive, sidecar, "--repo", repo, "--clobber"]);
if (!uploaded.ok) {
  fail(`asset upload to ${tag} failed: ${uploaded.err}`);
  process.exit(1);
}
log(`offsite-gh: uploaded ${name} + sidecar to ${repo}@${tag}`);

// ---------- 3. THE ATTESTATION: re-download from GitHub, compare hashes ----------
const stage = mkdtempSync(join(tmpdir(), "gnk-offsite-gh-"));
try {
  const dl = gh(["release", "download", tag, "--repo", repo, "--pattern", name, "--dir", stage]);
  if (!dl.ok) {
    fail(`re-download of ${tag} failed — upload NOT attested: ${dl.err}`);
    process.exit(1);
  }
  const remoteDigest = sha256(join(stage, name));
  if (remoteDigest !== localDigest) {
    fail(`ATTESTATION FAILED — GitHub's copy hashes ${remoteDigest.slice(0, 12)}…, local is ${localDigest.slice(0, 12)}…`);
    process.exit(1);
  }
  log(`offsite-gh: ATTESTED — the off-machine copy re-downloaded and hash-verified (${remoteDigest.slice(0, 12)}…)`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

// ---------- 4. retention: only our own dated tags, oldest first ----------
const list = gh(["release", "list", "--repo", repo, "--json", "tagName", "--jq", ".[].tagName"]);
if (list.ok) {
  const ours = list.out
    .split("\n")
    .filter((t) => /^backup-\d{4}-\d{2}-\d{2}$/.test(t))
    .sort();
  const prune = ours.slice(0, Math.max(0, ours.length - keep));
  for (const t of prune) {
    const del = gh(["release", "delete", t, "--repo", repo, "--yes", "--cleanup-tag"]);
    log(del.ok ? `offsite-gh: pruned ${t}` : `offsite-gh: prune of ${t} failed (kept): ${del.err}`);
  }
  log(`offsite-gh: retention keeps ${Math.min(ours.length, keep)} of ${ours.length} release(s)`);
} else {
  log(`offsite-gh: retention listing failed (upload already attested, not failing the night): ${list.err}`);
}
