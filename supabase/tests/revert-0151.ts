import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0151 — its documented ROLLBACK, run as ONE transaction
 * (one execute_sql call, or a forward migration file): 0097's three
 * digest-taking portal functions come back with 0097's bodies and grants.
 * It re-opens the defect 0150/0151 closed (the stored digest is a credential;
 * anyone holding the token or the digest may write pull telemetry) and exists
 * only so an application rolled back past 0151's floor has functions to call.
 *
 * The statements are read from 0097 itself, from its first `create function`
 * to its self-check, so the bodies are 0097's byte for byte (the md5s below
 * are hosted's, read 2026-10-18, and equal the file's).
 *
 * Used by portal-feed-integrity.test.ts inside rolled-back transactions. Not a
 * test file: it registers no tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0151 = "0151_portal_digest_readers_dropped.sql";
export const readMigration0151 = () =>
  readFileSync(join(MIGRATIONS, MIGRATION_0151), "utf-8").replace(/\r\n/g, "\n");

/** md5(replace(prosrc, chr(13), '')) of 0097's three bodies — hosted's on 2026-10-18 = the file's. */
export const BODY_MD5_0097 = {
  "portal_connection_by_token(text,text)": "cc700ca2a19bdb771d54ef1be1460fa8",
  "portal_supplement(text)": "6f1e95e537ca667c117a648d13f2560c",
  "note_portal_pull(text,text,integer)": "b9d0fc542c0611069cf9daf080a9340d",
} as const;

function functionsOf0097(): string {
  const text = readFileSync(join(MIGRATIONS, "0097_portal_token_digest.sql"), "utf-8").replace(/\r\n/g, "\n");
  const start = text.indexOf("create function public.portal_connection_by_token");
  const end = text.indexOf("-- 3. Self-check");
  if (start < 0 || end < 0 || end < start) throw new Error("revert-0151: 0097's function block was not found");
  // up to the separator line above "-- 3. Self-check"
  return text.slice(start, text.lastIndexOf("-- ----", end));
}

export const REVERT_0151_SQL = ["set local lock_timeout = '5s';", functionsOf0097()].join("\n");
