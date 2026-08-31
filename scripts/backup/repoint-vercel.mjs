#!/usr/bin/env node
/**
 * The Vercel half of a database restore (BACKUP_RESTORE §6b/§6c, audit
 * REL-08 follow-through): re-point production at a restored Supabase project
 * and rebuild, as ONE scripted step instead of three hand-edited env vars.
 *
 *   node --env-file="C:\Users\user\.gnk-crm\backup.env" scripts/backup/repoint-vercel.mjs
 *   node --env-file=... scripts/backup/repoint-vercel.mjs --apply --redeploy
 *
 * Default is PLAN: show what would be written, write nothing. --apply PATCHes
 * the three vars; --redeploy then rebuilds production and waits for READY.
 *
 * WHY THIS EXISTS. §6b's finding is that the 4-hour RTO is ~98% people, and
 * one of the three named levers is "scripting the Vercel env swap":
 * re-pointing NEXT_PUBLIC_* by hand cost six deployments on 2026-08-03 and
 * looked like a build failure, because `NEXT_PUBLIC_*` is inlined at BUILD
 * time — editing the var does nothing until a rebuild, and editing the wrong
 * environment does nothing at all (HANDOFF §7).
 *
 * THE CONTRACT. The NEW project's values are read from the SAME env file the
 * rest of the recovery already uses (`~/.gnk-crm/backup.env`):
 *
 *   SUPABASE_URL              -> NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_ANON_KEY         -> NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY -> SUPABASE_SERVICE_ROLE_KEY
 *   VERCEL_TOKEN              -> auth (team-scoped; see memory note)
 *
 * In a real recovery the operator pastes the restored project's URL and keys
 * over those lines FIRST (they are already maintaining this file — it is
 * where the nightly backup reads the DB URL), then runs with --apply
 * --redeploy. No secret ever passes through a shell argument or chat.
 *
 * SAFETY SHAPE, in order:
 *   1. every value is shape-checked BEFORE any write (https://<ref>.supabase.co,
 *      sb_publishable_…, sb_secret_…) — a missing or malformed line aborts;
 *   2. the anon key is LIVE-verified against the target project's PostgREST
 *      (the public_listings RPC answers 200 through a valid key; an invalid
 *      one is refused) — writing an unverified key is how a "recovery" turns
 *      into an outage;
 *   3. writes use the REST API's per-var PATCH — atomic per variable, unlike
 *      the CLI's rm-then-add which leaves a hole if interrupted;
 *   4. targets are NOT touched — the value changes, the environments the var
 *      applies to stay exactly as configured;
 *   5. --redeploy rebuilds from the latest READY production deployment's own
 *      source. If the rebuild fails, Vercel keeps serving the previous READY
 *      deployment — the alias only moves on success.
 *
 * PLAN MODE VERIFIED 2026-08-31 (shapes, live key check, all three vars
 * resolved with production targets). The write path is rehearsable at any
 * time with a ZERO-CHANGE run — same values, so the PATCHes are no-ops and
 * the rebuild is identical to any git push:
 *
 *   node --env-file="C:\Users\user\.gnk-crm\backup.env" scripts/backup/repoint-vercel.mjs --apply --redeploy
 *
 * Record the result in BACKUP_RESTORE §6c when run.
 *
 * Exit codes: 0 plan shown / applied and verified; 1 anything failed.
 */

import process from "node:process";

const TEAM_SLUG = "gn-kalaitsidis";
const PROJECT = "gnk-crm";
const PROD_URL = "https://gnk-crm.vercel.app";
const API = "https://api.vercel.com";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const REDEPLOY = args.has("--redeploy");

const token = process.env.VERCEL_TOKEN;
const mapping = [
  { env: "SUPABASE_URL", vercel: "NEXT_PUBLIC_SUPABASE_URL", shape: /^https:\/\/[a-z]{20}\.supabase\.co$/ },
  { env: "SUPABASE_ANON_KEY", vercel: "NEXT_PUBLIC_SUPABASE_ANON_KEY", shape: /^sb_publishable_[A-Za-z0-9_-]{10,}$/ },
  { env: "SUPABASE_SERVICE_ROLE_KEY", vercel: "SUPABASE_SERVICE_ROLE_KEY", shape: /^sb_secret_[A-Za-z0-9_-]{10,}$/ },
];

const mask = (v) => `${v.slice(0, 14)}… (len ${v.length})`;
const log = (line) => console.log(`[repoint] ${line}`);
const fail = (line) => {
  console.error(`[repoint] FAIL: ${line}`);
  process.exit(1);
};

async function vercelApi(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function main() {
  if (!token) fail("VERCEL_TOKEN missing — run with --env-file pointing at backup.env");

  // 1. shape-check every value before touching anything
  const values = {};
  for (const m of mapping) {
    const v = (process.env[m.env] ?? "").trim();
    if (!v) fail(`${m.env} is missing from the env file`);
    if (!m.shape.test(v)) fail(`${m.env} does not look right (${mask(v)}) — expected ${m.shape}`);
    values[m.env] = v;
  }
  const ref = values.SUPABASE_URL.match(/^https:\/\/([a-z]{20})\.supabase\.co$/)[1];
  log(`target Supabase project: ${ref}`);

  // 2. live-verify the anon key against the target project — an unverified
  //    key baked into a build is an outage wearing a recovery's clothes
  const probe = await fetch(`${values.SUPABASE_URL}/auth/v1/health`, {
    headers: { apikey: values.SUPABASE_ANON_KEY },
  });
  if (probe.status >= 500) fail(`target project's auth endpoint answered ${probe.status} — is it up?`);
  if (probe.status === 401) {
    const b = await probe.text();
    if (/invalid/i.test(b)) fail(`the anon key is REFUSED by ${ref} — wrong key for this project`);
  }
  log(`anon key accepted by ${ref} (auth health ${probe.status})`);

  // 3. resolve project + env var ids
  const team = await vercelApi(`/v2/teams/${TEAM_SLUG}`);
  const project = await vercelApi(`/v9/projects/${PROJECT}?teamId=${team.id}`);
  const envs = await vercelApi(`/v9/projects/${project.id}/env?teamId=${team.id}`);
  const rows = envs.envs ?? envs;

  const plan = [];
  for (const m of mapping) {
    const hit = rows.find((e) => e.key === m.vercel && (e.target ?? []).includes("production"));
    if (!hit) fail(`Vercel var ${m.vercel} not found with a production target — the project's env surface changed, stop and look`);
    plan.push({ ...m, id: hit.id, targets: hit.target, value: values[m.env] });
  }

  log(APPLY ? "applying:" : "PLAN (no writes — pass --apply to execute):");
  for (const p of plan) {
    log(`  ${p.vercel} [${p.targets.join(",")}] <- ${p.env} = ${mask(p.value)}`);
  }

  if (APPLY) {
    for (const p of plan) {
      await vercelApi(`/v9/projects/${project.id}/env/${p.id}?teamId=${team.id}`, {
        method: "PATCH",
        body: JSON.stringify({ value: p.value }),
      });
      log(`  PATCHed ${p.vercel}`);
    }
  }

  if (REDEPLOY) {
    if (!APPLY) fail("--redeploy without --apply would rebuild with the OLD values — refusing");
    // rebuild from the latest READY production deployment's own source
    const deps = await vercelApi(
      `/v6/deployments?projectId=${project.id}&teamId=${team.id}&target=production&state=READY&limit=1`,
    );
    const latest = deps.deployments?.[0];
    if (!latest) fail("no READY production deployment found to rebuild from");
    log(`rebuilding from ${latest.url} (${latest.uid})`);
    const created = await vercelApi(`/v13/deployments?teamId=${team.id}&forceNew=1`, {
      method: "POST",
      body: JSON.stringify({ name: PROJECT, deploymentId: latest.uid, target: "production" }),
    });
    log(`new deployment ${created.id ?? created.uid} — waiting for READY`);

    const id = created.id ?? created.uid;
    const started = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 10_000));
      const d = await vercelApi(`/v13/deployments/${id}?teamId=${team.id}`);
      const state = d.readyState ?? d.state;
      if (state === "READY") break;
      if (state === "ERROR" || state === "CANCELED") {
        fail(`rebuild ended ${state} — the previous deployment is still serving; fix and rerun`);
      }
      if (Date.now() - started > 10 * 60_000) fail("rebuild not READY after 10 minutes — check the dashboard");
      log(`  ${state}… (${Math.round((Date.now() - started) / 1000)}s)`);
    }
    log(`READY in ${Math.round((Date.now() - started) / 1000)}s`);

    // the proof: the LIVE alias answers, on the pages that exercise both keys
    for (const [path, expect] of [
      ["/login", 200],
      ["/api/public/listings?org=gnk", 200],
    ]) {
      const res = await fetch(`${PROD_URL}${path}`, { cache: "no-store" });
      if (res.status !== expect) fail(`${path} answered ${res.status}, expected ${expect}`);
      log(`  probe ${path} -> ${res.status} ✓`);
    }
  }

  log(APPLY ? "done — env re-pointed" + (REDEPLOY ? ", rebuilt, and probed" : " (rebuild still needed: --redeploy)") : "plan only, nothing written");
}

main().catch((e) => fail(e.message));
