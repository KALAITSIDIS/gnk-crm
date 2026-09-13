# Backup capture without Docker — native pg_dump — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `scripts/backup/capture.mjs` produces its three SQL files with a native `pg_dump`/`pg_dumpall`, byte-faithful to what `supabase db dump` produced, so the 03:45 task no longer depends on Docker Desktop being up.

**Architecture:** A new pure module `scripts/backup/pg-native.mjs` holds the CLI's rewrite rules (extracted from the 2.115.0 binary), the connection-URL → `PG*` env mapping, the argument builders, a tool resolver and a spawn wrapper. `capture.mjs` calls it instead of `npx supabase`. A fetch script installs the pinned, SHA-256-verified PostgreSQL 17.11 Windows client tools into `~/.gnk-crm/pgsql/17.11.0/bin` (outside the repo, next to `backup.env`); the pin lives in one place, `PG_TOOLS`.

**Tech Stack:** Node 24 (`node:child_process`, `node:crypto`, global `fetch`), vitest (config already includes `scripts/**/*.test.ts`), bsdtar (`C:\Windows\System32\tar.exe`) for zip extraction.

**Spec:** `docs/superpowers/specs/2026-09-13-backup-native-pg-dump-design.md`

**Branch:** `feat/backup-native-pg-dump` (already created from `main`).

---

## File map

| file | responsibility |
|---|---|
| `scripts/backup/pg-native.mjs` (create) | `PG_TOOLS` pin, `RESERVED_ROLES`, `ALLOWED_CONFIGS`, `connEnvFromUrl`, `rewriteSchemaDump`, `rewriteDataDump`, `rewriteRolesDump`, `schemaDumpArgs`, `dataDumpArgs`, `rolesDumpArgs`, `resolvePgTools`, `runPg`, `EXE`, `defaultToolsDir` |
| `scripts/backup/pg-native.test.ts` (create) | vitest for every pure function and for `runPg` against `process.execPath` |
| `scripts/backup/fetch-pg-tools.mjs` (create) | download pin → verify SHA-256 → extract client tools with bsdtar → print version |
| `scripts/backup/capture.mjs` (modify) | startup resolver check (exit 2), `dump()` through `runPg` + rewrite; verification untouched |
| `package.json` (modify) | `backup:fetch-pg-tools` script |
| `docs/BACKUP_RESTORE.md`, `HANDOFF.md`, `docs/DECISIONS.md` (modify) | the record |
| `~/.gnk-crm/backup.env.example` (machine-local, modify) | document optional `PG_BIN` |

---

### Task 1: `connEnvFromUrl` — the password leaves the command line

**Files:**
- Create: `scripts/backup/pg-native.mjs`
- Test: `scripts/backup/pg-native.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// scripts/backup/pg-native.test.ts
import { describe, expect, it } from "vitest";
import { connEnvFromUrl } from "./pg-native.mjs";

describe("connEnvFromUrl", () => {
  it("maps the session-pooler URL the runbook prescribes (§3.1) to PG* variables, decoding the password", () => {
    const env = connEnvFromUrl(
      "postgresql://postgres.yjgirvzgoiywdojnpkpd:p%40ss%3Aw%2Frd@aws-0-eu-central-1.pooler.supabase.com:5432/postgres",
    );
    expect(env).toEqual({
      PGHOST: "aws-0-eu-central-1.pooler.supabase.com",
      PGPORT: "5432",
      PGUSER: "postgres.yjgirvzgoiywdojnpkpd",
      PGPASSWORD: "p@ss:w/rd",
      PGDATABASE: "postgres",
    });
  });

  it("defaults the port to 5432 and the database to postgres, and passes sslmode through", () => {
    const env = connEnvFromUrl("postgres://u:p@127.0.0.1?sslmode=require");
    expect(env.PGPORT).toBe("5432");
    expect(env.PGDATABASE).toBe("postgres");
    expect(env.PGSSLMODE).toBe("require");
  });

  it("strips the brackets libpq does not want around an IPv6 host", () => {
    expect(connEnvFromUrl("postgresql://u:p@[::1]:54322/postgres").PGHOST).toBe("::1");
  });

  it("refuses anything that is not a postgres URL, naming the variable", () => {
    expect(() => connEnvFromUrl("not a url")).toThrow(/SUPABASE_DB_URL/);
    expect(() => connEnvFromUrl("https://example.com/")).toThrow(/postgresql:\/\//);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/dev/TSOPOZIDIS/gnk-crm && npx vitest run scripts/backup/pg-native.test.ts`
Expected: FAIL — cannot resolve `./pg-native.mjs`

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/backup/pg-native.mjs
/**
 * Native pg_dump for the nightly capture — the piece that used to run inside a
 * Docker container through `npx supabase db dump`.
 *
 * WHY: the 03:45 task runs under S4U (no signed-in user) and cannot start
 * Docker Desktop. After the 2026-09-09 reboot every night failed for five
 * nights with `failed to connect to the docker API` (DECISIONS T-native-dump,
 * BACKUP_RESTORE §3.0). pg_dump itself needs no container.
 *
 * WHAT: the CLI is not a thin wrapper. Its dump_schema.sh / dump_data.sh /
 * dump_role.sh — extracted from the 2.115.0 binary and reproduced below rule
 * for rule — rewrite pg_dump's output so that it restores into a fresh Supabase
 * project: IF NOT EXISTS / OR REPLACE, platform objects commented out, the
 * reserved roles filtered. The restore drills (§4d, §4e) were proven against
 * THAT shape, so this file reproduces it byte for byte rather than "close
 * enough". Verified 2026-09-13 by diffing both dumpers against production.
 *
 * Everything here except resolvePgTools/runPg is a pure function of a string,
 * and pg-native.test.ts runs them against the real shapes pg_dump 17 emits.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The one definition of which client tools this project runs and where they come from. */
export const PG_TOOLS = {
  version: "17.11.0",
  // theseus-rs repackages EnterpriseDB's official Windows build with pgAdmin and
  // docs removed (its build.yml downloads get.enterprisedb.com and deletes
  // pgsql/doc pgsql/pgAdmin*): same bits, 49 MB instead of 330 MB, and a
  // published SHA-256. Production is 17.6; pg_dump must be >= the server.
  url: "https://github.com/theseus-rs/postgresql-binaries/releases/download/17.11.0/postgresql-17.11.0-x86_64-pc-windows-msvc.zip",
  sha256: "85829f743e2697c55f1a5e8b210c53b90dd1f578448fc01cb9c4dc9e0a8e3827",
  archivePrefix: "postgresql-17.11.0-x86_64-pc-windows-msvc/",
};

export const EXE = process.platform === "win32" ? ".exe" : "";

/** Where fetch-pg-tools.mjs installs and resolvePgTools looks: next to backup.env, outside the repo. */
export function defaultToolsDir(home = homedir()) {
  return join(home, ".gnk-crm", "pgsql", PG_TOOLS.version, "bin");
}

/**
 * The CLI hands pg_dump the connection as PGHOST/PGPORT/PGUSER/PGPASSWORD/
 * PGDATABASE rather than as a URL on the command line. Same here: the password
 * is then in the child's environment, not in anything that enumerates process
 * command lines. sslmode is the only query parameter honoured.
 */
export function connEnvFromUrl(dbUrl) {
  let u;
  try {
    u = new URL(dbUrl);
  } catch {
    throw new Error("SUPABASE_DB_URL is not a valid URL");
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") {
    throw new Error("SUPABASE_DB_URL must start with postgresql://");
  }
  const env = {
    PGHOST: u.hostname.replace(/^\[(.*)\]$/, "$1"),
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
  };
  const sslmode = u.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/backup/pg-native.test.ts`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add scripts/backup/pg-native.mjs scripts/backup/pg-native.test.ts
git commit -m "backup: connEnvFromUrl — the database password leaves the command line"
```

---

### Task 2: `rewriteSchemaDump` — the CLI's schema rules, rule for rule

**Files:**
- Modify: `scripts/backup/pg-native.mjs`
- Test: `scripts/backup/pg-native.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `scripts/backup/pg-native.test.ts` (extend the import line to `import { connEnvFromUrl, rewriteSchemaDump } from "./pg-native.mjs";`):

```ts
/** The head pg_dump 17.6+ emits. `\restrict` is a psql meta-command, not a comment, until the CLI makes it one. */
const PG_DUMP_HEAD = [
  "--",
  "-- PostgreSQL database dump",
  "--",
  "",
  "\\restrict eRgqp6HOw5CK6sxG9j01BAeIvDIhXWTQbVI21UnQh9YDBeckfyeNRM7EpUBWC8o",
  "",
  "-- Dumped from database version 17.6",
  "-- Dumped by pg_dump version 17.11",
  "",
  "SET statement_timeout = 0;",
  "SET lock_timeout = 0;",
  "SET idle_in_transaction_session_timeout = 0;",
  "SET transaction_timeout = 0;",
  "SET client_encoding = 'UTF8';",
  "SET standard_conforming_strings = on;",
  "SELECT pg_catalog.set_config('search_path', '', false);",
  "SET check_function_bodies = false;",
  "SET xmloption = content;",
  "SET client_min_messages = warning;",
  "SET row_security = off;",
  "",
];
const PG_DUMP_TAIL = ["--", "-- PostgreSQL database dump complete", "--", "", "\\unrestrict eRgqp6HOw5CK6sxG9j01BAeIvDIhXWTQbVI21UnQh9YDBeckfyeNRM7EpUBWC8o", ""];
const lf = (lines: string[]) => lines.join("\n") + "\n";

describe("rewriteSchemaDump", () => {
  it("turns pg_dump's header into the three blank lines the CLI leaves, and drops the pg17-only transaction_timeout", () => {
    const out = rewriteSchemaDump(lf([...PG_DUMP_HEAD, ...PG_DUMP_TAIL]));
    expect(out.split("\n").slice(0, 4)).toEqual(["", "", "", "SET statement_timeout = 0;"]);
    expect(out).not.toContain("transaction_timeout");
    expect(out).not.toContain("restrict");
    expect(out).not.toMatch(/^--/m);
  });

  it("rewrites CREATE into the re-runnable forms the restore drills depend on (§4d, §4e)", () => {
    const out = rewriteSchemaDump(lf([
      'CREATE SCHEMA "events_parts";',
      'CREATE SCHEMA "public";',
      'CREATE TABLE "public"."areas" (',
      'CREATE SEQUENCE "public"."events_id_seq1"',
      'CREATE VIEW "public"."v" AS',
      'CREATE FUNCTION "public"."f"() RETURNS void',
      'CREATE TRIGGER "trg_events_hash" BEFORE INSERT ON "public"."events"',
    ]));
    expect(out).toBe(lf([
      'CREATE SCHEMA IF NOT EXISTS "events_parts";',
      'CREATE SCHEMA IF NOT EXISTS "public";',
      'CREATE TABLE IF NOT EXISTS "public"."areas" (',
      'CREATE SEQUENCE IF NOT EXISTS "public"."events_id_seq1"',
      'CREATE OR REPLACE VIEW "public"."v" AS',
      'CREATE OR REPLACE FUNCTION "public"."f"() RETURNS void',
      'CREATE OR REPLACE TRIGGER "trg_events_hash" BEFORE INSERT ON "public"."events"',
    ]));
  });

  it("removes the platform objects a fresh project already owns, and keeps everything else", () => {
    const out = rewriteSchemaDump(lf([
      'CREATE PUBLICATION "supabase_realtime" WITH (publish = \'insert, update, delete, truncate\');',
      'ALTER PUBLICATION "supabase_realtime_messages_publication" OWNER TO "supabase_admin";',
      'CREATE EVENT TRIGGER "issue_pg_net_access" ON ddl_command_end',
      "         WHEN TAG IN ('CREATE EXTENSION')",
      '   EXECUTE FUNCTION "extensions"."grant_pg_net_access"();',
      'ALTER EVENT TRIGGER "issue_pg_net_access" OWNER TO "supabase_admin";',
      'ALTER FOREIGN DATA WRAPPER "postgres_fdw" OWNER TO "supabase_admin";',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";',
      'GRANT ALL ON FOREIGN DATA WRAPPER "postgres_fdw" TO "postgres" WITH GRANT OPTION;',
      'CREATE EXTENSION IF NOT EXISTS "pgsodium" WITH SCHEMA "pgsodium";',
      'CREATE EXTENSION IF NOT EXISTS "pg_tle" WITH SCHEMA "pgtle";',
      'CREATE EXTENSION IF NOT EXISTS "pgmq" WITH SCHEMA "pgmq";',
      'COMMENT ON EXTENSION "pgsodium" IS \'Pgsodium is a modern cryptography library for Postgres.\';',
      'CREATE POLICY "cron_job_policy" ON "cron"."job" USING (("username" = CURRENT_USER));',
      'ALTER TABLE "cron"."job" ENABLE ROW LEVEL SECURITY;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";',
      'ALTER TYPE "public"."comm_channel" OWNER TO "postgres";',
      'CREATE POLICY "areas_select" ON "public"."areas" FOR SELECT USING (true);',
    ]));
    expect(out).toBe(lf([
      'CREATE EXTENSION IF NOT EXISTS "pgsodium";',
      'CREATE EXTENSION IF NOT EXISTS "pg_tle";',
      'CREATE EXTENSION IF NOT EXISTS "pgmq";',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";',
      'ALTER TYPE "public"."comm_channel" OWNER TO "postgres";',
      'CREATE POLICY "areas_select" ON "public"."areas" FOR SELECT USING (true);',
    ]));
  });

  it("deletes a column-0 comment inside a function body too — the CLI does, so a restore must not depend on one", () => {
    const out = rewriteSchemaDump(lf(['CREATE FUNCTION "public"."f"() RETURNS void AS $$', "-- explains nothing after restore", "  -- indented survives", "$$;"]));
    expect(out).toBe(lf(['CREATE OR REPLACE FUNCTION "public"."f"() RETURNS void AS $$', "  -- indented survives", "$$;"]));
  });

  it("normalises CRLF, which a Windows pg_dump.exe may emit, to LF", () => {
    expect(rewriteSchemaDump('CREATE SCHEMA "public";\r\nSET row_security = off;\r\n')).toBe('CREATE SCHEMA IF NOT EXISTS "public";\nSET row_security = off;\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/backup/pg-native.test.ts`
Expected: FAIL — `rewriteSchemaDump` is not exported

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/backup/pg-native.mjs`:

```js
// ----------------------------------------------------------------- line model
/**
 * sed works on newline-terminated lines and `d` removes the line WITH its
 * newline. Model that exactly: a trailing "\n" is a terminator, not an empty
 * last line, or every dump would gain or lose a blank line at the end.
 */
function toLines(text) {
  const lf = text.replace(/\r\n/g, "\n");
  const lines = lf.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
const fromLines = (lines) => (lines.length ? lines.join("\n") + "\n" : "");
const applyRules = (line, rules) => rules.reduce((l, [re, repl]) => l.replace(re, repl), line);
const isComment = (line) => line.startsWith("--");

// ------------------------------------------------------------ dump_schema.sh
/**
 * supabase-cli 2.115.0, dump_schema.sh, in order. `-- $&` is sed's `-- &`:
 * comment the line out; the CLI then deletes every comment line because
 * `--keep-comments` is off (EXTRA_SED="/^--/d"), so "commented" means "gone".
 *
 * Two rules from the script are deliberately absent:
 *   GRANT/REVOKE ... ON ... "(EXCLUDED_SCHEMAS)" — the CLI fills
 *   EXCLUDED_SCHEMAS only when no --schema is given; capture.mjs always gives
 *   one, so the pattern was `""` and could match nothing.
 */
const SCHEMA_RULES = [
  [/^\\(un)?restrict .*$/, "-- $&"],
  [/^CREATE SCHEMA "/, 'CREATE SCHEMA IF NOT EXISTS "'],
  [/^CREATE TABLE "/, 'CREATE TABLE IF NOT EXISTS "'],
  [/^CREATE SEQUENCE "/, 'CREATE SEQUENCE IF NOT EXISTS "'],
  [/^CREATE VIEW "/, 'CREATE OR REPLACE VIEW "'],
  [/^CREATE FUNCTION "/, 'CREATE OR REPLACE FUNCTION "'],
  [/^CREATE TRIGGER "/, 'CREATE OR REPLACE TRIGGER "'],
  [/^CREATE PUBLICATION "supabase_realtime/, "-- $&"],
  [/^CREATE EVENT TRIGGER /, "-- $&"],
  [/^         WHEN TAG IN /, "-- $&"],
  [/^   EXECUTE FUNCTION /, "-- $&"],
  [/^ALTER EVENT TRIGGER /, "-- $&"],
  [/^ALTER PUBLICATION "supabase_realtime_/, "-- $&"],
  [/^ALTER FOREIGN DATA WRAPPER (.+) OWNER TO /, "-- $&"],
  [/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/, "-- $&"],
  [/^GRANT ALL ON FOREIGN DATA WRAPPER (.+) TO "postgres" WITH GRANT OPTION/, "-- $&"],
  [/^(CREATE EXTENSION IF NOT EXISTS "pg_tle").+/, "$1;"],
  [/^(CREATE EXTENSION IF NOT EXISTS "pgsodium").+/, "$1;"],
  [/^(CREATE EXTENSION IF NOT EXISTS "pgmq").+/, "$1;"],
  [/^COMMENT ON EXTENSION (.+)/, "-- $&"],
  [/^CREATE POLICY "cron_job_/, "-- $&"],
  [/^ALTER TABLE "cron"/, "-- $&"],
  [/^SET transaction_timeout = 0;/, "-- $&"],
];

/** `supabase db dump --schema ...` minus the container. */
export function rewriteSchemaDump(text) {
  return fromLines(toLines(text).map((l) => applyRules(l, SCHEMA_RULES)).filter((l) => !isComment(l)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/backup/pg-native.test.ts`
Expected: 9 passed

- [ ] **Step 5: Commit**

```bash
git add scripts/backup/pg-native.mjs scripts/backup/pg-native.test.ts
git commit -m "backup: rewriteSchemaDump — the CLI's dump_schema.sh rules, natively"
```

---

### Task 3: `rewriteDataDump`

**Files:**
- Modify: `scripts/backup/pg-native.mjs`
- Test: `scripts/backup/pg-native.test.ts`

- [ ] **Step 1: Write the failing test**

Append (extend the import with `rewriteDataDump`):

```ts
describe("rewriteDataDump", () => {
  it("puts the replica line first, keeps comments (a multi-line record may start with one), neuters restrict, ends with RESET ALL", () => {
    const body = [
      ...PG_DUMP_HEAD,
      "--",
      "-- Data for Name: users; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin",
      "--",
      "",
      'COPY "auth"."users" ("instance_id", "id") FROM stdin;',
      "00000000-0000-0000-0000-000000000000\t1c7f",
      "\\.",
      "",
      ...PG_DUMP_TAIL,
    ];
    const out = rewriteDataDump(lf(body));
    expect(out.startsWith("SET session_replication_role = replica;\n\n--\n-- PostgreSQL database dump\n--\n\n-- \\restrict ")).toBe(true);
    expect(out).toContain("-- Data for Name: users;");
    expect(out).toContain('COPY "auth"."users" ("instance_id", "id") FROM stdin;\n00000000-0000-0000-0000-000000000000\t1c7f\n\\.\n');
    expect(out.endsWith("-- \\unrestrict eRgqp6HOw5CK6sxG9j01BAeIvDIhXWTQbVI21UnQh9YDBeckfyeNRM7EpUBWC8o\n\nRESET ALL;\n")).toBe(true);
  });

  it("normalises CRLF, which would otherwise land inside COPY rows", () => {
    expect(rewriteDataDump("COPY \"a\".\"b\" (\"c\") FROM stdin;\r\n1\r\n\\.\r\n")).toBe('SET session_replication_role = replica;\n\nCOPY "a"."b" ("c") FROM stdin;\n1\n\\.\nRESET ALL;\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/backup/pg-native.test.ts`
Expected: FAIL — `rewriteDataDump` is not exported

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/backup/pg-native.mjs`:

```js
// -------------------------------------------------------------- dump_data.sh
const RESTRICT_RULE = [[/^\\(un)?restrict .*$/, "-- $&"]];

/**
 * `supabase db dump --data-only --use-copy`. Comments are KEPT here — the
 * script says why: a multi-line record may begin with one. The first line is
 * what stops `trg_events_hash` re-minting every hash on restore (§5), and
 * capture.mjs verifies it is line 1.
 */
export function rewriteDataDump(text) {
  const body = fromLines(toLines(text).map((l) => applyRules(l, RESTRICT_RULE)));
  return "SET session_replication_role = replica;\n\n" + body + "RESET ALL;\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/backup/pg-native.test.ts`
Expected: 11 passed

- [ ] **Step 5: Commit**

```bash
git add scripts/backup/pg-native.mjs scripts/backup/pg-native.test.ts
git commit -m "backup: rewriteDataDump — replica line first, comments kept, RESET ALL last"
```

---

### Task 4: `rewriteRolesDump`

**Files:**
- Modify: `scripts/backup/pg-native.mjs`
- Test: `scripts/backup/pg-native.test.ts`

- [ ] **Step 1: Write the failing test**

Append (extend the import with `rewriteRolesDump`):

```ts
describe("rewriteRolesDump", () => {
  const dumpall = lf([
    "--",
    "-- PostgreSQL database cluster dump",
    "--",
    "",
    "\\restrict AbC",
    "",
    "SET default_transaction_read_only = off;",
    "",
    "SET client_encoding = 'UTF8';",
    "SET standard_conforming_strings = on;",
    "",
    "--",
    "-- Roles",
    "--",
    "",
    'CREATE ROLE "anon";',
    'ALTER ROLE "anon" WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;',
    'CREATE ROLE "supabase_storage_admin";',
    'ALTER ROLE "supabase_storage_admin" WITH NOSUPERUSER NOINHERIT CREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS;',
    'CREATE ROLE "cli_login_postgres";',
    'CREATE ROLE "reporting_ro";',
    'ALTER ROLE "reporting_ro" WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS;',
    "",
    "--",
    "-- User Configurations",
    "--",
    "",
    'ALTER ROLE "anon" SET "statement_timeout" TO \'3s\';',
    'ALTER ROLE "authenticator" SET "pgrst.db_schemas" TO \'public\';',
    'ALTER ROLE "postgres" SET "search_path" TO \'$user\', \'public\';',
    "",
    "--",
    "-- Role memberships",
    "--",
    "",
    'GRANT "anon" TO "authenticator" WITH INHERIT TRUE GRANTED BY "supabase_admin";',
    'GRANT "reporting_ro" TO "supabase_admin" WITH INHERIT TRUE GRANTED BY "postgres";',
    "",
    "",
    "--",
    "-- PostgreSQL database cluster dump complete",
    "--",
    "",
    "\\unrestrict AbC",
    "",
  ]);

  it("keeps only what a fresh project will accept: allowed SETs on reserved roles, and custom roles whole", () => {
    expect(rewriteRolesDump(dumpall)).toBe(lf([
      "",
      "SET default_transaction_read_only = off;",
      "",
      "SET client_encoding = 'UTF8';",
      "SET standard_conforming_strings = on;",
      "",
      'CREATE ROLE "reporting_ro";',
      'ALTER ROLE "reporting_ro" WITH INHERIT NOCREATEROLE NOCREATEDB LOGIN NOBYPASSRLS;',
      "",
      'ALTER ROLE "anon" SET "statement_timeout" TO \'3s\';',
      'ALTER ROLE "authenticator" SET "pgrst.db_schemas" TO \'public\';',
      "",
      "RESET ALL;",
    ]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/backup/pg-native.test.ts`
Expected: FAIL — `rewriteRolesDump` is not exported

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/backup/pg-native.mjs`:

```js
// -------------------------------------------------------------- dump_role.sh
/** The launcher's `Uc6` — roles supautils refuses to CREATE or ALTER. Regex fragments, joined with `|`. */
export const RESERVED_ROLES = [
  "anon", "authenticated", "authenticator", "cli_login_.*", "dashboard_user", "pgbouncer", "postgres",
  "service_role", "supabase_.*", "pgsodium_keyholder", "pgsodium_keyiduser", "pgsodium_keymaker", "pgtle_admin",
];
/** The launcher's `Nc6` — the only per-role settings a reserved role may carry across. */
export const ALLOWED_CONFIGS = ["pgaudit.*", "pgrst.*", "session_replication_role", "statement_timeout", "track_io_timing"];

const reserved = RESERVED_ROLES.join("|");
const allowed = ALLOWED_CONFIGS.join("|");
const ROLE_RULES = [
  [/^\\(un)?restrict .*$/, "-- $&"],
  [new RegExp(`^CREATE ROLE "(${reserved})"`), "-- $&"],
  [new RegExp(`^ALTER ROLE "(${reserved})"`), "-- $&"],
  [/ (NOSUPERUSER|NOREPLICATION)/g, ""],
  [new RegExp(`^-- (.* SET "(${allowed})" .*)`), "$1"],
  [new RegExp(`GRANT ".*" TO "(${reserved})"`), "-- $&"],
];

/** `supabase db dump --role-only`: comment lines gone, then `uniq` (adjacent duplicates, blank runs included). */
export function rewriteRolesDump(text) {
  const kept = toLines(text).map((l) => applyRules(l, ROLE_RULES)).filter((l) => !isComment(l));
  const uniq = kept.filter((l, i) => i === 0 || l !== kept[i - 1]);
  return fromLines(uniq) + "RESET ALL;\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/backup/pg-native.test.ts`
Expected: 12 passed

- [ ] **Step 5: Commit**

```bash
git add scripts/backup/pg-native.mjs scripts/backup/pg-native.test.ts
git commit -m "backup: rewriteRolesDump — reserved roles out, allowed settings kept, uniq"
```

---

### Task 5: argument builders

**Files:**
- Modify: `scripts/backup/pg-native.mjs`
- Test: `scripts/backup/pg-native.test.ts`

- [ ] **Step 1: Write the failing test**

Append (extend the import with `schemaDumpArgs, dataDumpArgs, rolesDumpArgs`):

```ts
describe("argument builders mirror the CLI's pg_dump invocations", () => {
  it("schema: schema-only, quoted identifiers, SET ROLE postgres, one --schema per name", () => {
    expect(schemaDumpArgs(["public", "events_parts"])).toEqual([
      "--schema-only", "--quote-all-identifiers", "--role", "postgres", "--schema", "public", "--schema", "events_parts",
    ]);
  });
  it("data: data-only, the three platform migration tables excluded (they exist on the target already)", () => {
    expect(dataDumpArgs(["public", "auth"])).toEqual([
      "--data-only", "--quote-all-identifiers", "--role", "postgres",
      "--exclude-table", "auth.schema_migrations", "--exclude-table", "storage.migrations", "--exclude-table", "supabase_functions.migrations",
      "--schema", "public", "--schema", "auth",
    ]);
  });
  it("roles: pg_dumpall flags, no passwords (the connecting role cannot read them anyway)", () => {
    expect(rolesDumpArgs()).toEqual(["--roles-only", "--role", "postgres", "--quote-all-identifiers", "--no-role-passwords", "--no-comments"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/backup/pg-native.test.ts`
Expected: FAIL — `schemaDumpArgs` is not exported

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/backup/pg-native.mjs`:

```js
// ------------------------------------------------------------- the commands
/**
 * The CLI joins the schema list with `|` into one pg_dump pattern; one
 * `--schema` per name is the same set and needs no pattern knowledge.
 * `--role postgres` is the CLI's SET ROLE after connecting — through the
 * session pooler the user is `postgres.<ref>` and the role is still postgres.
 */
const schemaFlags = (schemas) => schemas.flatMap((s) => ["--schema", s]);

export function schemaDumpArgs(schemas) {
  return ["--schema-only", "--quote-all-identifiers", "--role", "postgres", ...schemaFlags(schemas)];
}

export function dataDumpArgs(schemas) {
  return [
    "--data-only", "--quote-all-identifiers", "--role", "postgres",
    "--exclude-table", "auth.schema_migrations",
    "--exclude-table", "storage.migrations",
    "--exclude-table", "supabase_functions.migrations",
    ...schemaFlags(schemas),
  ];
}

export function rolesDumpArgs() {
  return ["--roles-only", "--role", "postgres", "--quote-all-identifiers", "--no-role-passwords", "--no-comments"];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/backup/pg-native.test.ts`
Expected: 15 passed

- [ ] **Step 5: Commit**

```bash
git add scripts/backup/pg-native.mjs scripts/backup/pg-native.test.ts
git commit -m "backup: the three pg_dump argument lists, mirrored from the CLI scripts"
```

---

### Task 6: `resolvePgTools` and `runPg`

**Files:**
- Modify: `scripts/backup/pg-native.mjs`
- Test: `scripts/backup/pg-native.test.ts`

- [ ] **Step 1: Write the failing test**

Append (extend the import with `resolvePgTools, runPg, EXE, defaultToolsDir`; add `import { join } from "node:path";` at the top):

```ts
describe("resolvePgTools", () => {
  const home = process.platform === "win32" ? "C:\\Users\\u" : "/home/u";
  const local = defaultToolsDir(home);

  it("honours PG_BIN first, and refuses to start if it is set but wrong", () => {
    const ok = resolvePgTools({ env: { PG_BIN: "/opt/pg/bin" }, home, exists: (p) => p === join("/opt/pg/bin", "pg_dump" + EXE), probe: () => false });
    expect(ok).toMatchObject({ ok: true, source: "PG_BIN (/opt/pg/bin)", pgDump: join("/opt/pg/bin", "pg_dump" + EXE), pgDumpall: join("/opt/pg/bin", "pg_dumpall" + EXE) });
    const bad = resolvePgTools({ env: { PG_BIN: "/nope" }, home, exists: () => false, probe: () => true });
    expect(bad).toMatchObject({ ok: false });
    expect(bad.reason).toMatch(/PG_BIN is set to \/nope/);
  });

  it("falls back to the fetched tools next to backup.env, then to PATH", () => {
    const fetched = resolvePgTools({ env: {}, home, exists: (p) => p === join(local, "pg_dump" + EXE), probe: () => false });
    expect(fetched).toMatchObject({ ok: true, source: local, pgDump: join(local, "pg_dump" + EXE) });
    const path = resolvePgTools({ env: {}, home, exists: () => false, probe: (n) => n === "pg_dump" + EXE });
    expect(path).toMatchObject({ ok: true, source: "PATH", pgDump: "pg_dump", pgDumpall: "pg_dumpall" });
  });

  it("names the fix when nothing is found", () => {
    const none = resolvePgTools({ env: {}, home, exists: () => false, probe: () => false });
    expect(none.ok).toBe(false);
    expect(none.reason).toContain("fetch-pg-tools.mjs");
    expect(none.reason).toContain("PG_BIN");
  });
});

describe("runPg", () => {
  it("returns the exit code, raw stdout, and a stderr tail with the password redacted", () => {
    const r = runPg(process.execPath, ["-e", "process.stdout.write('a\\r\\nb\\n'); process.stderr.write('pw=hunter2\\n\\nboom\\n'); process.exit(3)"], { PGPASSWORD: "hunter2" });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("a\r\nb\n");
    expect(r.stderrTail).toBe("pw=[REDACTED]\n      boom");
  });
  it("reports a missing binary as a failure, not a crash", () => {
    const r = runPg("definitely-not-a-binary-9f3a", ["--version"], {});
    expect(r.status).not.toBe(0);
    expect(r.stderrTail).toMatch(/ENOENT/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/backup/pg-native.test.ts`
Expected: FAIL — `resolvePgTools` is not exported

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/backup/pg-native.mjs`:

```js
// ------------------------------------------------------------- the binaries
function probePath(name) {
  const r = spawnSync(name, ["--version"], { encoding: "utf8", windowsHide: true });
  return r.status === 0;
}

/**
 * Where pg_dump comes from, in order: PG_BIN from backup.env (an operator
 * override), the tools fetch-pg-tools.mjs installed next to backup.env, then
 * PATH. No fallback to the Supabase CLI: two paths means the wrong one runs
 * silently, and the point of this file is that ONE path runs at 03:45.
 */
export function resolvePgTools({ env = process.env, home = homedir(), exists = existsSync, probe = probePath } = {}) {
  const tools = (dir) => ({
    pgDump: join(dir, "pg_dump" + EXE),
    pgDumpall: join(dir, "pg_dumpall" + EXE),
    psql: join(dir, "psql" + EXE),
  });
  if (env.PG_BIN) {
    const t = tools(env.PG_BIN);
    if (exists(t.pgDump)) return { ok: true, source: `PG_BIN (${env.PG_BIN})`, ...t };
    return { ok: false, reason: `PG_BIN is set to ${env.PG_BIN} but pg_dump${EXE} is not there.` };
  }
  const local = defaultToolsDir(home);
  if (exists(join(local, "pg_dump" + EXE))) return { ok: true, source: local, ...tools(local) };
  if (probe("pg_dump" + EXE)) return { ok: true, source: "PATH", pgDump: "pg_dump", pgDumpall: "pg_dumpall", psql: "psql" };
  return {
    ok: false,
    reason:
      `pg_dump not found. Run  node scripts/backup/fetch-pg-tools.mjs  (installs the PostgreSQL ${PG_TOOLS.version} ` +
      `client tools into ${local}), or set PG_BIN in backup.env to a directory that has pg_dump${EXE}.`,
  };
}

/**
 * spawnSync with the two things the dumps need: a buffer big enough for a
 * database (the default 1 MiB would truncate data.sql silently — the size
 * floors in capture.mjs would catch it, but "caught" is not "worked"), and a
 * stderr that can be logged. The password is scrubbed from stderr; the URL
 * never reaches the child at all.
 */
export function runPg(cmd, args, connEnv, { maxBuffer = 1024 ** 3 } = {}) {
  const r = spawnSync(cmd, args, { env: { ...process.env, ...connEnv }, maxBuffer, windowsHide: true });
  const secrets = [connEnv.PGPASSWORD].filter(Boolean);
  const scrub = (s) => secrets.reduce((acc, sec) => acc.split(sec).join("[REDACTED]"), String(s ?? ""));
  const stderr = scrub(r.error ? r.error.message : (r.stderr ?? "").toString("utf8"));
  return {
    status: r.error ? (r.status ?? -1) : r.status,
    stdout: r.stdout ? r.stdout.toString("utf8") : "",
    stderrTail: stderr.split("\n").map((l) => l.trim()).filter(Boolean).slice(-12).join("\n      "),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/backup/pg-native.test.ts`
Expected: 20 passed

- [ ] **Step 5: Run typecheck and lint, since `scripts/**` may be in scope**

Run: `npm run typecheck && npx eslint scripts/backup/pg-native.mjs scripts/backup/pg-native.test.ts`
Expected: no errors. If tsc complains about importing `./pg-native.mjs` from the test, add `scripts/backup/pg-native.d.ts` declaring the exports (`export function connEnvFromUrl(dbUrl: string): Record<string, string>;` etc.) rather than loosening tsconfig.

- [ ] **Step 6: Commit**

```bash
git add scripts/backup/pg-native.mjs scripts/backup/pg-native.test.ts
git commit -m "backup: resolvePgTools + runPg — one path to the binaries, fail loudly otherwise"
```

---

### Task 7: `fetch-pg-tools.mjs`

**Files:**
- Create: `scripts/backup/fetch-pg-tools.mjs`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Write the script**

```js
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
  console.error("fetch-pg-tools.mjs pins the Windows build only. Install postgresql-client from your package manager and set PG_BIN in backup.env.");
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
  new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); } }),
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
const members = ["pg_dump.exe", "pg_dumpall.exe", "psql.exe", "pg_restore.exe", "*.dll"].map((m) => `${PG_TOOLS.archivePrefix}bin/${m}`);
const x = spawnSync(tar, ["-xf", zip, "-C", binDir, "--strip-components", "2", ...members], { encoding: "utf8", windowsHide: true });
if (x.status !== 0) {
  console.error(`extract failed (${x.status}): ${x.stderr}`);
  process.exit(1);
}
rmSync(zip, { force: true });
report();
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts`, after `"check:csp-nonce"`:

```json
"backup:fetch-pg-tools": "node scripts/backup/fetch-pg-tools.mjs",
```

- [ ] **Step 3: Prove the refusal paths without downloading**

Run: `PG_BIN=/nope node scripts/backup/fetch-pg-tools.mjs --dest "$TEMP/pgtools-test/bin" --force` is NOT the test — it would download. Instead:

Run: `node -e "import('./scripts/backup/fetch-pg-tools.mjs')" --help` — not needed either. The script's only offline-testable branch is "already present": create an empty `pg_dump.exe` in a temp dir and run with `--dest` there; expect `already present` then a non-zero exit from `report()` because the empty file is not a program. Run:

```bash
mkdir -p "$TEMP/pgtools-fake/bin" && : > "$TEMP/pgtools-fake/bin/pg_dump.exe" && node scripts/backup/fetch-pg-tools.mjs --dest "$TEMP/pgtools-fake/bin"; echo "exit=$?"
```
Expected: prints `already present`, then the path, then `exit=1`.

- [ ] **Step 4: Commit**

```bash
git add scripts/backup/fetch-pg-tools.mjs package.json
git commit -m "backup: fetch-pg-tools — pinned, hash-verified PostgreSQL 17.11 client tools next to backup.env"
```

---

### Task 8: `capture.mjs` uses the native dumps

**Files:**
- Modify: `scripts/backup/capture.mjs:49-53` (imports), `:88-95` (startup checks), `:127-143` (`cliArgs` block), `:244-280` (`dump` and its three calls)

- [ ] **Step 1: Imports**

After line 53 (`import { join, relative, sep } from "node:path";`) add:

```js
import {
  connEnvFromUrl, dataDumpArgs, resolvePgTools, rewriteDataDump, rewriteRolesDump, rewriteSchemaDump,
  rolesDumpArgs, runPg, schemaDumpArgs,
} from "./pg-native.mjs";
```

- [ ] **Step 2: Startup check — refuse to start (exit 2) without pg_dump**

After the pooler check (the block ending `process.exit(2);` at line 95) and BEFORE `const stamp = ...`, add:

```js
/**
 * NATIVE pg_dump SINCE 2026-09-13. The dumps used to run inside a Docker
 * container through `npx supabase db dump`; the 03:45 task runs under S4U and
 * cannot start Docker Desktop, so every night after a reboot failed until a
 * human signed in (five nights, 2026-09-09..13). pg-native.mjs reproduces the
 * CLI's output byte for byte with a plain pg_dump. No tools -> exit 2, the
 * "refused to start" code, with the fix named; the dead-man switch reports it.
 */
const pg = resolvePgTools();
if (!pg.ok) {
  console.error(pg.reason);
  process.exit(2);
}
let connEnv;
try {
  connEnv = connEnvFromUrl(dbUrl);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
```

- [ ] **Step 3: Replace the `cliArgs` block (lines 127-143, the comment and the function) with**

```js
// The Supabase CLI is no longer involved (see the startup check above). The
// connection reaches pg_dump as PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE in
// the child's environment — no cmd.exe, no npx, and nothing on a command line
// that a process-list enumerator could read.
```

- [ ] **Step 4: Replace `dump()` (lines 244-261) with**

```js
function dump(label, cmd, cmdArgs, rewrite, file) {
  const target = join(stageDir, file);
  const r = runPg(cmd, cmdArgs, connEnv);
  if (r.status !== 0) {
    // Keep enough stderr to diagnose: pg_dump's real cause is its last lines.
    problems.push(`${label}: exit ${r.status}\n      ${redact(r.stderrTail)}`);
    return null;
  }
  writeFileSync(target, rewrite(r.stdout), { encoding: "utf8" });
  log(`  ${label.padEnd(8)} ${String(statSync(target).size).padStart(8)} bytes`);
  return target;
}
```

- [ ] **Step 5: Replace the three calls (lines 277-280) with**

```js
const schemaFile = dump("schema", pg.pgDump, schemaDumpArgs(["public", "events_parts"]), rewriteSchemaDump, "pg_dump.sql");
addExtensionPreamble(schemaFile);
const dataFile = dump("data", pg.pgDump, dataDumpArgs(["public", "events_parts", "auth", "storage"]), rewriteDataDump, "data.sql");
const rolesFile = dump("roles", pg.pgDumpall, rolesDumpArgs(), rewriteRolesDump, "roles.sql");
```

Also add `log(\`  via ${pg.source}\`);` right after `log("dumps");` (line 265) so the log names which binaries ran.

- [ ] **Step 6: Update the file's header comment**

In the header (lines 41-44) the bullet "The CLI emits NO `CREATE EXTENSION`" stays true; change "A failed `db dump` still creates its -f file. Size floors catch it." to "A failed dump can still leave a file (the CLI did, as 0 bytes). Size floors catch it."

- [ ] **Step 7: Prove the exit-2 path**

Run:
```bash
cd D:/dev/TSOPOZIDIS/gnk-crm && PG_BIN=/nope node --env-file="$HOME/.gnk-crm/backup.env" scripts/backup/capture.mjs --out "$TEMP/capture-test"; echo "exit=$?"
```
Expected: `PG_BIN is set to /nope but pg_dump.exe is not there.` and `exit=2`; `$TEMP/capture-test` does not exist (refused before staging).

- [ ] **Step 8: Unit suite + lint + typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green (1353+ unit; the new file adds 20).

- [ ] **Step 9: Commit**

```bash
git add scripts/backup/capture.mjs
git commit -m "backup: capture.mjs dumps with native pg_dump — the container is gone"
```

---

### Task 9: fetch the tools (operator permission) and prove equivalence against the CLI

**Files:** none (scratch only)

- [ ] **Step 1: With the operator's yes, fetch**

Run: `npm run backup:fetch-pg-tools`
Expected: `downloading https://github.com/theseus-rs/...`, `sha256 ok, 49.1 MB`, then `C:\Users\user\.gnk-crm\pgsql\17.11.0\bin` and `pg_dump (PostgreSQL) 17.11`.

- [ ] **Step 2: Native dumps into scratch**

Write `<scratch>/native-dumps.mjs`:

```js
import { writeFileSync } from "node:fs";
import { connEnvFromUrl, dataDumpArgs, resolvePgTools, rewriteDataDump, rewriteRolesDump, rewriteSchemaDump, rolesDumpArgs, runPg, schemaDumpArgs } from "D:/dev/TSOPOZIDIS/gnk-crm/scripts/backup/pg-native.mjs";
const out = process.argv[2];
const pg = resolvePgTools(); if (!pg.ok) { console.error(pg.reason); process.exit(2); }
const env = connEnvFromUrl(process.env.SUPABASE_DB_URL);
for (const [label, cmd, args, rewrite, file] of [
  ["schema", pg.pgDump, schemaDumpArgs(["public", "events_parts"]), rewriteSchemaDump, "pg_dump.sql"],
  ["data", pg.pgDump, dataDumpArgs(["public", "events_parts", "auth", "storage"]), rewriteDataDump, "data.sql"],
  ["roles", pg.pgDumpall, rolesDumpArgs(), rewriteRolesDump, "roles.sql"],
]) {
  const t0 = Date.now(); const r = runPg(cmd, args, env);
  if (r.status !== 0) { console.log(`${label}: exit ${r.status}\n${r.stderrTail}`); continue; }
  writeFileSync(`${out}/${file}`, rewrite(r.stdout)); console.log(`${label}: ok ${rewrite(r.stdout).length} bytes in ${Date.now() - t0}ms`);
}
```

Run: `node --env-file="$HOME/.gnk-crm/backup.env" <scratch>/native-dumps.mjs <scratch>/native`

- [ ] **Step 3: Diff against the CLI reference taken earlier today (`<scratch>/ref/`)**

Run: `for f in pg_dump.sql data.sql roles.sql; do echo "== $f"; diff <scratch>/ref/$f <scratch>/native/$f | head -20; done`
Expected: `pg_dump.sql` and `roles.sql` identical (no output). `data.sql` differs in exactly three lines: `-- Dumped by pg_dump version 17.6` → `17.11`, and the two random `\restrict`/`\unrestrict` tokens. Anything else is a defect in a rewrite rule — fix the rule, add the shape to the tests, re-run.

- [ ] **Step 4: Record the result in the spec's Proof section** (edit the spec: replace "Expected difference: only the random `\restrict` token" with the measured three-line difference).

---

### Task 10: full capture with Docker Desktop stopped

- [ ] **Step 1: With the operator's yes, stop Docker Desktop**

Run (PowerShell): `Stop-Process -Name "Docker Desktop" -Force; Stop-Process -Name "com.docker.backend" -Force -ErrorAction SilentlyContinue; wsl --shutdown`
Then: `docker ps` must fail with the named-pipe error.

- [ ] **Step 2: Run the real job**

Run (PowerShell): `& "C:\Users\user\.gnk-crm\run-backup.cmd"; $LASTEXITCODE`
Expected: `0`, and the log's new run shows `via C:\Users\user\.gnk-crm\pgsql\17.11.0\bin`, `verified — every check passed`, `notify: pinged OK`, `exit=0`.

- [ ] **Step 3: Restart Docker Desktop**

Run (PowerShell): `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`; the local Supabase stack does not auto-start — say so in the report.

---

### Task 11: the record

**Files:**
- Modify: `docs/BACKUP_RESTORE.md` §3.0 (after the flags paragraph, ~line 191) and §3.1 (before the three commands, ~line 415), the nightly-task block (~line 232-245)
- Modify: `HANDOFF.md` §0 `Backups` row and §7 (the "Docker Desktop is sometimes fully down" trap, line ~1350)
- Modify: `docs/DECISIONS.md` — append `## T-native-dump — the nightly dump no longer needs a container (2026-09-13)`
- Modify: `docs/superpowers/specs/2026-09-13-backup-native-pg-dump-design.md` — decision row: npm package → pinned fetch (the npm package shipped no pg_dump; measured)
- Modify: `~/.gnk-crm/backup.env.example` — add a commented `PG_BIN=` block

- [ ] **Step 1: BACKUP_RESTORE §3.0 — add after "Flags: `--out`, `--force` ..." paragraph**

```markdown
**Native `pg_dump` since 2026-09-13 — Docker is not involved.** The three
SQL files come from `pg_dump`/`pg_dumpall` spawned directly
(`scripts/backup/pg-native.mjs`), reproducing `supabase db dump`'s output byte
for byte (its `dump_*.sh` rewrite rules were extracted from the 2.115.0 binary
and are unit-tested against the real shapes). The binaries are the pinned
PostgreSQL 17.11 Windows client tools in `~/.gnk-crm/pgsql/17.11.0/bin`,
installed by `npm run backup:fetch-pg-tools` (SHA-256 verified; the pin is
`PG_TOOLS` in `pg-native.mjs`). `PG_BIN` in `backup.env` overrides. No tools
→ exit 2 with the fix named. Why: the 03:45 task runs under S4U and cannot
start Docker Desktop, so after the 2026-09-09 reboot five nights in a row
failed with `failed to connect to the docker API` (DECISIONS T-native-dump).
```

- [ ] **Step 2: BACKUP_RESTORE §3.1 — add before "Three dumps, because they cover different things"**

```markdown
> **The `npx.cmd supabase db dump` commands below need Docker Desktop
> running.** They remain correct for a hand-taken set, but the automated path
> no longer uses them (§3.0). A hand-taken set without Docker:
> `PG_BIN=$HOME/.gnk-crm/pgsql/17.11.0/bin node --env-file=$HOME/.gnk-crm/backup.env scripts/backup/capture.mjs --out ../gnk-backups --force`
> — same files, same verification.
```

- [ ] **Step 3: BACKUP_RESTORE nightly-task block — add a line after `Log      :`**

```
Tools    : ~/.gnk-crm/pgsql/17.11.0/bin (pg_dump 17.11, native since 2026-09-13; no Docker)
```

- [ ] **Step 4: HANDOFF §0 Backups row — prepend**

`✅ **Docker-free since 2026-09-13** (native pg_dump, DECISIONS T-native-dump; five nights 09-09..13 had failed because an S4U task cannot start Docker Desktop — last good set before the fix 2026-09-08, gap closed by a manual run 2026-09-13 14:10). ` then the existing text.

- [ ] **Step 5: HANDOFF §7 — after "Docker Desktop is sometimes fully down, not just flaky."**

```markdown
- **…and since 2026-09-13 that no longer touches the nightly backup**: capture.mjs
  dumps with a native pg_dump (BACKUP_RESTORE §3.0). Docker still matters for
  `supabase start`, `db:types` and the RLS suite — nothing that runs at 03:45.
```

- [ ] **Step 6: DECISIONS entry (append)**

```markdown
## T-native-dump — the nightly dump no longer needs a container (2026-09-13)

**What was found.** `~/.gnk-crm/backup.log` showed five consecutive `exit=1`
nights, 2026-09-09 to 09-13, each `notify: pinged FAIL`, each with the same
cause: `failed to connect to the docker API at
npipe:////./pipe/dockerDesktopLinuxEngine`. The machine had rebooted 09-09
04:54; nobody started Docker Desktop again until 09-13 13:45. `capture.mjs`
produced its dumps through `npx supabase db dump`, which runs pg_dump inside
a container, and the 03:45 task runs under S4U — a logon type that cannot
start a per-user GUI app. The dead-man switch did its job (healthchecks.io
DOWN from 09-09); it cannot do the backup's.

**What was done.** `scripts/backup/pg-native.mjs` reproduces the CLI's
output with a plain `pg_dump`/`pg_dumpall`. Not "roughly": the CLI's
`dump_schema.sh`, `dump_data.sh` and `dump_role.sh` were extracted from the
2.115.0 binary, including the two lists the launcher fills in (reserved
roles, allowed per-role configs), and reproduced rule for rule as pure
functions with a real-shape test suite. Proof: the CLI dumps and the native
dumps of production were taken back to back and diffed — schema and roles
identical, data differing only in the `Dumped by pg_dump version` line and
the two random `\restrict` tokens. Then the real job ran with Docker Desktop
stopped and exited 0.

**Where pg_dump comes from, and the wrong turn.** The first choice was the
npm package `@embedded-postgres/windows-x64` (reproducible, CI-skippable).
Installed and inspected, it ships `initdb`, `pg_ctl` and `postgres` only —
no client tools. The one npm package that bundles a Windows `pg_dump` bundles
PostgreSQL 14, which refuses to dump a 17.6 server. So: the theseus-rs
`postgresql-binaries` 17.11.0 Windows zip, which is EnterpriseDB's official
build with pgAdmin and docs stripped (their build.yml downloads
get.enterprisedb.com and deletes those folders), 49 MB, SHA-256 published.
`fetch-pg-tools.mjs` downloads it, hashes it while streaming, refuses on
mismatch, and extracts the client tools with bsdtar into
`~/.gnk-crm/pgsql/17.11.0/bin` — next to `backup.env`, outside the repo and
outside OneDrive. The pin is one constant, `PG_TOOLS`. A wrong `PG_BIN` or
no tools at all is exit 2, the refused-to-start code, with the fix named.

**Smaller facts worth keeping.** The CLI passes the connection as
`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`, never as a URL on the command
line; so does the native path now, which closes the "briefly visible to
anything that enumerates process command lines" wart the old comment owned
up to. `spawnSync`'s default `maxBuffer` is 1 MiB and would have truncated
`data.sql` silently; it is 1 GiB here. The `tar` on PATH under Git Bash is
GNU tar and cannot read zip; `C:\Windows\System32\tar.exe` is bsdtar and can.
```

- [ ] **Step 7: backup.env.example (machine-local) — append**

```
# --- Native pg_dump (added 2026-09-13) ------------------------------------
# capture.mjs runs pg_dump directly (no Docker). It looks in
# ~/.gnk-crm/pgsql/17.11.0/bin (installed by `npm run backup:fetch-pg-tools`),
# then PATH. Set PG_BIN only to point at a different PostgreSQL bin directory.
# PG_BIN=
```

- [ ] **Step 8: Commit**

```bash
git add docs/BACKUP_RESTORE.md HANDOFF.md docs/DECISIONS.md docs/superpowers/specs/2026-09-13-backup-native-pg-dump-design.md docs/superpowers/plans/2026-09-13-backup-native-pg-dump.md
git commit -m "docs: the nightly dump no longer needs a container (T-native-dump)"
```

---

### Task 12: ship it before 03:45

- [ ] **Step 1: Push the branch, let CI run**

Run: `git push -u origin feat/backup-native-pg-dump`, then watch the `checks` and `rls` workflows with `gh run list --branch feat/backup-native-pg-dump --limit 2` until both are green.

- [ ] **Step 2: Merge to main and push**

```bash
git checkout main && git merge --no-ff feat/backup-native-pg-dump -m "Merge: the nightly dump no longer needs a container" && git push origin main
```

- [ ] **Step 3: Confirm the working tree the task will use**

Run: `git branch --show-current` → `main`; `git status --short` → empty; `ls ~/.gnk-crm/pgsql/17.11.0/bin/pg_dump.exe` → present. The task runs whatever is checked out in `D:\dev\TSOPOZIDIS\gnk-crm` at 03:45 — leaving a branch checked out would run the branch.

- [ ] **Step 4: Verify the deploy did not break** — this change touches no app code; `vercel` will still redeploy on push. `gh run list` green and `https://gn-kalaitsidis.vercel.app/` READY is enough.
