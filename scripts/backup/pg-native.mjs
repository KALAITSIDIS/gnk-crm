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
