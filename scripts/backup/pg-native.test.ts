import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXE,
  connEnvFromUrl,
  dataDumpArgs,
  defaultToolsDir,
  resolvePgTools,
  rewriteDataDump,
  rewriteRolesDump,
  rewriteSchemaDump,
  rolesDumpArgs,
  runPg,
  schemaDumpArgs,
} from "./pg-native.mjs";

/**
 * pg-native.mjs reproduces `supabase db dump` without the container. The
 * fixtures below are the REAL shapes pg_dump 17 emits (header, `\restrict`
 * meta-command, COPY blocks, pg_dumpall's role section), and the expected
 * outputs are what the CLI produced for the same input — checked against the
 * verified 2026-09-13 set and the CLI scripts extracted from the 2.115.0
 * binary. A rule that drifts fails here, not at restore time.
 */

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
const PG_DUMP_TAIL = [
  "--",
  "-- PostgreSQL database dump complete",
  "--",
  "",
  "\\unrestrict eRgqp6HOw5CK6sxG9j01BAeIvDIhXWTQbVI21UnQh9YDBeckfyeNRM7EpUBWC8o",
  "",
];
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
    const out = rewriteSchemaDump(
      lf([
        'CREATE SCHEMA "events_parts";',
        'CREATE SCHEMA "public";',
        'CREATE TABLE "public"."areas" (',
        'CREATE SEQUENCE "public"."events_id_seq1"',
        'CREATE VIEW "public"."v" AS',
        'CREATE FUNCTION "public"."f"() RETURNS void',
        'CREATE TRIGGER "trg_events_hash" BEFORE INSERT ON "public"."events"',
      ]),
    );
    expect(out).toBe(
      lf([
        'CREATE SCHEMA IF NOT EXISTS "events_parts";',
        'CREATE SCHEMA IF NOT EXISTS "public";',
        'CREATE TABLE IF NOT EXISTS "public"."areas" (',
        'CREATE SEQUENCE IF NOT EXISTS "public"."events_id_seq1"',
        'CREATE OR REPLACE VIEW "public"."v" AS',
        'CREATE OR REPLACE FUNCTION "public"."f"() RETURNS void',
        'CREATE OR REPLACE TRIGGER "trg_events_hash" BEFORE INSERT ON "public"."events"',
      ]),
    );
  });

  it("removes the platform objects a fresh project already owns, and keeps everything else", () => {
    const out = rewriteSchemaDump(
      lf([
        "CREATE PUBLICATION \"supabase_realtime\" WITH (publish = 'insert, update, delete, truncate');",
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
        "COMMENT ON EXTENSION \"pgsodium\" IS 'Pgsodium is a modern cryptography library for Postgres.';",
        'CREATE POLICY "cron_job_policy" ON "cron"."job" USING (("username" = CURRENT_USER));',
        'ALTER TABLE "cron"."job" ENABLE ROW LEVEL SECURITY;',
        'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";',
        'ALTER TYPE "public"."comm_channel" OWNER TO "postgres";',
        'CREATE POLICY "areas_select" ON "public"."areas" FOR SELECT USING (true);',
      ]),
    );
    expect(out).toBe(
      lf([
        'CREATE EXTENSION IF NOT EXISTS "pgsodium";',
        'CREATE EXTENSION IF NOT EXISTS "pg_tle";',
        'CREATE EXTENSION IF NOT EXISTS "pgmq";',
        'ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";',
        'ALTER TYPE "public"."comm_channel" OWNER TO "postgres";',
        'CREATE POLICY "areas_select" ON "public"."areas" FOR SELECT USING (true);',
      ]),
    );
  });

  it("deletes a column-0 comment inside a function body too — the CLI does, so a restore must not depend on one", () => {
    const out = rewriteSchemaDump(
      lf(['CREATE FUNCTION "public"."f"() RETURNS void AS $$', "-- explains nothing after restore", "  -- indented survives", "$$;"]),
    );
    expect(out).toBe(lf(['CREATE OR REPLACE FUNCTION "public"."f"() RETURNS void AS $$', "  -- indented survives", "$$;"]));
  });

  it("normalises CRLF, which a Windows pg_dump.exe may emit, to LF", () => {
    expect(rewriteSchemaDump('CREATE SCHEMA "public";\r\nSET row_security = off;\r\n')).toBe(
      'CREATE SCHEMA IF NOT EXISTS "public";\nSET row_security = off;\n',
    );
  });
});

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
    expect(rewriteDataDump('COPY "a"."b" ("c") FROM stdin;\r\n1\r\n\\.\r\n')).toBe(
      'SET session_replication_role = replica;\n\nCOPY "a"."b" ("c") FROM stdin;\n1\n\\.\nRESET ALL;\n',
    );
  });
});

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
    "ALTER ROLE \"anon\" SET \"statement_timeout\" TO '3s';",
    "ALTER ROLE \"authenticator\" SET \"pgrst.db_schemas\" TO 'public';",
    "ALTER ROLE \"postgres\" SET \"search_path\" TO '$user', 'public';",
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
    expect(rewriteRolesDump(dumpall)).toBe(
      lf([
        "",
        "SET default_transaction_read_only = off;",
        "",
        "SET client_encoding = 'UTF8';",
        "SET standard_conforming_strings = on;",
        "",
        'CREATE ROLE "reporting_ro";',
        'ALTER ROLE "reporting_ro" WITH INHERIT NOCREATEROLE NOCREATEDB LOGIN NOBYPASSRLS;',
        "",
        "ALTER ROLE \"anon\" SET \"statement_timeout\" TO '3s';",
        "ALTER ROLE \"authenticator\" SET \"pgrst.db_schemas\" TO 'public';",
        "",
        "RESET ALL;",
      ]),
    );
  });
});

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

describe("resolvePgTools", () => {
  const home = process.platform === "win32" ? "C:\\Users\\u" : "/home/u";
  const local = defaultToolsDir(home);

  it("honours PG_BIN first, and refuses to start if it is set but wrong", () => {
    const ok = resolvePgTools({
      env: { PG_BIN: "/opt/pg/bin" },
      home,
      exists: (p: string) => p === join("/opt/pg/bin", "pg_dump" + EXE),
      probe: () => false,
    });
    expect(ok).toMatchObject({
      ok: true,
      source: "PG_BIN (/opt/pg/bin)",
      pgDump: join("/opt/pg/bin", "pg_dump" + EXE),
      pgDumpall: join("/opt/pg/bin", "pg_dumpall" + EXE),
    });
    const bad = resolvePgTools({ env: { PG_BIN: "/nope" }, home, exists: () => false, probe: () => true });
    expect(bad).toMatchObject({ ok: false });
    expect(bad.reason).toMatch(/PG_BIN is set to \/nope/);
  });

  it("falls back to the fetched tools next to backup.env, then to PATH", () => {
    const fetched = resolvePgTools({ env: {}, home, exists: (p: string) => p === join(local, "pg_dump" + EXE), probe: () => false });
    expect(fetched).toMatchObject({ ok: true, source: local, pgDump: join(local, "pg_dump" + EXE) });
    const path = resolvePgTools({ env: {}, home, exists: () => false, probe: (n: string) => n === "pg_dump" + EXE });
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
    const r = runPg(
      process.execPath,
      ["-e", "process.stdout.write('a\\r\\nb\\n'); process.stderr.write('pw=hunter2\\n\\nboom\\n'); process.exit(3)"],
      { PGPASSWORD: "hunter2" },
    );
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
