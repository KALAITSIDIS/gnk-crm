#!/usr/bin/env node
/**
 * Logical backup: every public table + every storage object, to a dated folder.
 * See docs/BACKUP_RESTORE.md.
 *
 *   node scripts/backup/export.mjs --out ../gnk-backups
 *
 * Credentials come from the environment and are never written to the output:
 *   SUPABASE_URL              e.g. https://<ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY service key for that project
 *
 * ⚠ THIS IS NOT A CHAIN-FAITHFUL BACKUP OF `events`. USE `pg_dump` FOR THAT.
 *
 * Proven in the 2026-07-24 drill: PostgREST hands jsonb to JavaScript, and
 * JavaScript numbers have no notion of scale, so a payload stored as
 * `{"to": 510000.00}` comes back as `{"to": 510000}`. `verify_events_chain`
 * hashes `payload::text`, so that single character difference breaks the hash —
 * and because the chain is sequential, ONE corrupted payload invalidates every
 * event after it. The restored database looks complete and reports its chain as
 * FAILED, which is indistinguishable from tampering.
 *
 * There is no way around this through PostgREST: the raw text of a jsonb column
 * cannot be selected over the REST API. `supabase db dump` (pg_dump) preserves
 * it exactly and is therefore the PRIMARY backup.
 *
 * What this script is genuinely for:
 *   - Storage. A database dump contains NO bucket objects on any plan
 *     (BACKUP_RESTORE §1.2) — the signed viewing slips, evidence PDFs and KYC
 *     scans live only here, and this is the only thing that captures them.
 *   - A readable, greppable snapshot of the business tables.
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const outRoot = args[args.indexOf("--out") + 1] ?? "../gnk-backups";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

/**
 * A legacy JWT service key fails every request with "Legacy API keys are
 * disabled" (HANDOFF §2b — the pair was disabled 2026-08-03). Caught here rather
 * than 26 tables later, because the failure otherwise surfaces as an unhandled
 * rejection whose exit code is 3221226505 and means nothing to a scheduler.
 */
if (key.startsWith("eyJ")) {
  console.error(
    "SUPABASE_SERVICE_ROLE_KEY is a legacy JWT key (starts 'eyJ'). Those were disabled\n" +
      "2026-08-03 and every request returns 401. Use the sb_secret_… key instead.",
  );
  process.exit(1);
}

/**
 * Load order is irrelevant on restore (it runs with session_replication_role =
 * replica, so FKs are deferred), but keeping parents first makes a partial
 * restore readable if anyone ever does one by hand.
 */
const TABLES = [
  "organizations", "profiles", "districts", "areas", "cyprus_config",
  "deal_stages", "reference_counters", "contacts", "properties",
  "property_media", "property_keys", "key_movements", "mandates", "leads",
  "deals", "offers", "viewings", "viewing_slips", "documents", "tasks",
  "price_lists", "price_list_items", "payment_plans", "price_history",
  "chain_checks", "events",
];

const BUCKETS = ["documents", "signatures", "media"];

const sb = createClient(url, key, { auth: { persistSession: false } });
const stamp = new Date().toISOString().slice(0, 10);
const outDir = join(outRoot, stamp);
mkdirSync(join(outDir, "data"), { recursive: true });

const started = Date.now();
const manifest = { takenAt: new Date().toISOString(), source: url, tables: {}, buckets: {} };

for (const table of TABLES) {
  // Page through: a table larger than the PostgREST cap would otherwise be
  // silently truncated, which is the one thing a backup must never do.
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from(table).select("*").range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  writeFileSync(join(outDir, "data", `${table}.json`), JSON.stringify(rows));
  manifest.tables[table] = rows.length;
  console.log(`${table.padEnd(20)} ${rows.length}`);
}

for (const bucket of BUCKETS) {
  let count = 0;
  let bytes = 0;
  // storage.list is per-prefix, so walk the tree
  const walk = async (prefix) => {
    const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) throw new Error(`${bucket}/${prefix}: ${error.message}`);
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        await walk(path); // folder
        continue;
      }
      const { data: blob, error: dlErr } = await sb.storage.from(bucket).download(path);
      if (dlErr) throw new Error(`${bucket}/${path}: ${dlErr.message}`);
      const file = join(outDir, "storage", bucket, path);
      mkdirSync(dirname(file), { recursive: true });
      const buf = Buffer.from(await blob.arrayBuffer());
      writeFileSync(file, buf);
      count += 1;
      bytes += buf.length;
    }
  };
  await walk("");
  manifest.buckets[bucket] = { objects: count, bytes };
  console.log(`bucket:${bucket.padEnd(13)} ${count} objects, ${bytes} bytes`);
}

manifest.seconds = Math.round((Date.now() - started) / 100) / 10;
// Recorded in the artefact itself so nobody later mistakes this for a complete
// backup on the strength of the row counts alone.
manifest.chainFaithful = false;
manifest.warning =
  "events payloads lose numeric scale through JSON (510000.00 -> 510000), which breaks " +
  "verify_events_chain. Restore the events table from a pg_dump, not from this file.";
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(`\nwrote ${outDir} in ${manifest.seconds}s`);
console.warn(
  "\n⚠ Storage and table snapshot only. `events` is NOT chain-faithful here —\n" +
    "  take a pg_dump for that (docs/BACKUP_RESTORE.md §3.1).",
);
