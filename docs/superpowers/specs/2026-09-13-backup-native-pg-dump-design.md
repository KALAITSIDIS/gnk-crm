# Backup capture without Docker — native pg_dump (design)

**Date:** 2026-09-13 · **Status:** design approved by the operator, implementation in progress
**Owner doc:** BACKUP_RESTORE §3.0 · HANDOFF §0 Backups row

## The failure this removes

`scripts/backup/capture.mjs` produced its three SQL files through
`npx supabase db dump`, which runs `pg_dump` inside a Docker container. The
nightly task runs at 03:45 under S4U (no signed-in user), and an S4U task
cannot start Docker Desktop. Measured 2026-09-13: the machine rebooted
2026-09-09 04:54, nobody started Docker again until 2026-09-13 13:45, and
every night in between ended `exit=1` with
`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`.
The same signature appeared 08-08 and 08-19/20. The dead-man switch reported
each failure correctly; it cannot make the backup happen.

## Decisions taken

| question | decision |
|---|---|
| How is the dump produced? | `pg_dump` / `pg_dumpall` spawned directly by Node. No cmd.exe, no npx, no container. |
| Where does `pg_dump` come from? | `scripts/backup/fetch-pg-tools.mjs` downloads the **theseus-rs `postgresql-binaries` 17.11.0** Windows zip (49 MB, SHA-256 published and verified while streaming), and extracts the client tools with bsdtar into `~/.gnk-crm/pgsql/17.11.0/bin` — next to `backup.env`, outside the repo and OneDrive. That archive is EnterpriseDB's official build with pgAdmin and docs stripped (their `build.yml` downloads get.enterprisedb.com and deletes those folders). Production is 17.6; pg_dump must be ≥ the server. The pin is one constant, `PG_TOOLS`. `PG_BIN` in `backup.env` overrides; PATH is the last resort. **The first choice, the npm package `@embedded-postgres/windows-x64`, was installed and inspected: it ships `initdb`, `pg_ctl` and `postgres` only — no `pg_dump`.** The one npm package that bundles a Windows `pg_dump` bundles PostgreSQL 14, which refuses to dump a 17 server. |
| What if none is found? | Exit **2** at startup ("refused to start") with a message naming the fix. No fallback to the CLI: two paths means the wrong one runs silently. |
| Output shape | **Byte-faithful to the CLI**, because the restore drills (§4d, §4e) were proven against that shape. The CLI's `dump_schema.sh`, `dump_data.sh` and `dump_role.sh` were extracted from the 2.115.0 binary and their sed rules are reproduced as pure functions. |
| Credentials | Parsed from `SUPABASE_DB_URL` into `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` for the child's environment, exactly as the CLI does. The password leaves the command line. |
| Verification | Unchanged. Every existing check in `capture.mjs` still runs on the new files. |

## What the CLI actually does (extracted, not assumed)

Schema (`--schema public,events_parts`): `pg_dump --schema-only
--quote-all-identifier --role postgres --schema=public|events_parts`, then
IF NOT EXISTS on CREATE SCHEMA/TABLE/SEQUENCE, OR REPLACE on CREATE
VIEW/FUNCTION/TRIGGER, comment out `\restrict`, `CREATE/ALTER PUBLICATION
supabase_realtime`, event triggers, foreign-data-wrapper ownership,
`ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin`, `COMMENT ON EXTENSION`,
`CREATE POLICY cron_job_`, `ALTER TABLE cron`, `SET transaction_timeout = 0`;
truncate `CREATE EXTENSION` for pg_tle/pgsodium/pgmq; then **delete every
line starting with `--`** (keep-comments is off).

Data (`--schema public,events_parts,auth,storage --data-only --use-copy`):
emit `SET session_replication_role = replica;` plus a blank line; `pg_dump
--data-only --quote-all-identifier --role postgres --exclude-table
auth.schema_migrations --exclude-table storage.migrations --exclude-table
supabase_functions.migrations --schema public|events_parts|auth|storage`;
comment out `\restrict`; append `RESET ALL;`. Comments are **kept** (a
multi-line record may begin with one).

Roles (`--role-only`): `pg_dumpall --roles-only --role postgres
--quote-all-identifier --no-role-passwords --no-comments`; comment out
`\restrict`; comment out CREATE/ALTER ROLE for the reserved roles
(`anon authenticated authenticator cli_login_.* dashboard_user pgbouncer
postgres service_role supabase_.* pgsodium_keyholder pgsodium_keyiduser
pgsodium_keymaker pgtle_admin`); drop ` NOSUPERUSER` / ` NOREPLICATION`;
un-comment `SET` of the allowed configs (`pgaudit.* pgrst.*
session_replication_role statement_timeout track_io_timing`); comment out
`GRANT ... TO` a reserved role; delete comment lines; `uniq`; append
`RESET ALL;`.

## Components

- `scripts/backup/pg-native.mjs` — pure functions, no I/O except
  `resolvePgTools`/`runPg`: `connEnvFromUrl`, `rewriteSchemaDump`,
  `rewriteDataDump`, `rewriteRolesDump`, the three argument builders,
  `resolvePgTools` (PG_BIN → fetched tools → PATH), and `runPg` (spawnSync
  wrapper: 1 GiB maxBuffer, stderr redacted of the password; the rewrite
  functions normalise CRLF to LF).
- `scripts/backup/fetch-pg-tools.mjs` — the pinned download, hash-verified,
  idempotent; `npm run backup:fetch-pg-tools`.
- `scripts/backup/pg-native.test.ts` — vitest (the config already includes
  `scripts/**/*.test.ts`). Fixtures are the real shapes pg_dump 17 emits,
  including the `\restrict` header, and the negative cases: a `CREATE TABLE`
  that must gain IF NOT EXISTS, a `transaction_timeout` line that must go, a
  CRLF input, a reserved-role `ALTER ROLE ... SET "statement_timeout"` that
  must survive while its `CREATE ROLE` must not.
- `scripts/backup/capture.mjs` — `cliArgs`/`dump` replaced by the native
  calls; startup check for `pg_dump`; everything from `verify` down untouched.
- `package.json` — the `backup:fetch-pg-tools` script. No new dependency.

## Proof

1. **Equivalence run** (one-off, 2026-09-13, Docker up): the CLI dumps and
   the native dumps of production taken back to back and diffed. Expected
   difference: only the random `\restrict` token in `data.sql`. Recorded in
   DECISIONS.
2. **Full capture** through `run-backup.cmd` exits 0 and promotes a verified
   set, with Docker Desktop **stopped**, which is the case that failed for
   five nights.
3. Unit tests green in CI on Linux, where no pg_dump exists (the tests spawn
   only `process.execPath`).

## Not in scope

Restore drills still use `psql` (now also available natively in the same
package, noted in the runbook); `npm run db:types` and local development still
use the Supabase CLI and Docker; the attested GitHub leg stays gated on the
operator's `GH_TOKEN`.
