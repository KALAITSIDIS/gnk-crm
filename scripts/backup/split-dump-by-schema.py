#!/usr/bin/env python3
"""
Split a `supabase db dump` schema file into its public and non-public halves.

    python scripts/backup/split-dump-by-schema.py \
        --in  ../gnk-backups/2026-08-04/pg_dump.sql \
        --out ../gnk-backups/2026-08-06

Writes `<out>/pg_dump-public.sql` and `<out>/pg_dump-platform.sql`.

WHY THIS EXISTS — and why it is a workaround, not the answer
------------------------------------------------------------
The 2026-08-04 schema dump was taken with `--schema public,auth,storage`, which
BACKUP_RESTORE §4b.2 proved is fatal: `auth` and `storage` are owned by
`supabase_admin`, so the dump emits ownership statements no connectable role can
execute, and under ON_ERROR_STOP=1 psql dies on line 19 having created nothing.

The correct fix is to re-take it with `--schema public` (§7 step 2). That needs
the database password, so it is the operator's. This script recovers a usable
public-only file from the dump that already exists, for when that is blocked.

`pg_dump` normally marks every object with a `-- Name: …; Schema: …;` header,
which would make this trivial. **The Supabase CLI strips them** — there are zero
such headers in the file — so statements have to be classified by content.

CLASSIFICATION IS BY FIRST SCHEMA-QUALIFIED IDENTIFIER, which is sound here only
because the CLI quotes every identifier: objects appear as `"public"."contacts"`,
`"auth"."users"`, `"storage"."objects"`. A dump without quoted identifiers would
need a real parser.

DO NOT TRUST THE OUTPUT WITHOUT RESTORING IT. A splitter that drops one statement
produces a file that looks complete and restores a subtly incomplete schema —
exactly the class of silent failure this whole runbook exists to prevent. Verify
by restoring under ON_ERROR_STOP=1 and comparing object counts against the
source. The 2026-08-06 run is recorded in BACKUP_RESTORE §3.1.
"""
import argparse
import os
import re
import sys

PLATFORM = ("auth", "storage", "graphql", "graphql_public", "realtime",
            "supabase_functions", "supabase_migrations", "vault", "_realtime",
            "pgbouncer", "extensions", "net", "cron")


def split_statements(sql):
    """
    Yield complete SQL statements. Tracks dollar-quoted bodies ($$ … $$ and
    $tag$ … $tag$), single-quoted literals with '' escaping, and -- comments,
    because every one of them can legally contain a semicolon.
    """
    out, buf, i, n = [], [], 0, len(sql)
    dollar = None          # active dollar-quote tag, e.g. "$func$"
    in_str = False         # inside a '…' literal
    in_line_comment = False
    while i < n:
        ch = sql[i]
        if in_line_comment:
            buf.append(ch)
            if ch == "\n":
                in_line_comment = False
            i += 1
            continue
        if dollar:
            if sql.startswith(dollar, i):
                buf.append(dollar)
                i += len(dollar)
                dollar = None
                continue
            buf.append(ch)
            i += 1
            continue
        if in_str:
            buf.append(ch)
            if ch == "'":
                if i + 1 < n and sql[i + 1] == "'":   # '' escape
                    buf.append("'")
                    i += 2
                    continue
                in_str = False
            i += 1
            continue
        if ch == "-" and sql.startswith("--", i):
            in_line_comment = True
            buf.append(ch)
            i += 1
            continue
        if ch == "'":
            in_str = True
            buf.append(ch)
            i += 1
            continue
        m = re.match(r"\$[A-Za-z_0-9]*\$", sql[i:])
        if m:
            dollar = m.group(0)
            buf.append(dollar)
            i += len(dollar)
            continue
        if ch == ";":
            buf.append(ch)
            out.append("".join(buf).strip())
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return [s for s in out if s]


def classify(stmt):
    """Return 'public', 'platform', or 'preamble' for one statement."""
    body = re.sub(r"--[^\n]*\n", "\n", stmt)          # ignore comment text
    head = body.lstrip()

    # Schema-level statements name the schema directly rather than qualifying.
    m = re.match(r'(?is)\s*(CREATE\s+SCHEMA(\s+IF\s+NOT\s+EXISTS)?|ALTER\s+SCHEMA|COMMENT\s+ON\s+SCHEMA)\s+"?([A-Za-z_0-9]+)"?', head)
    if m:
        return "public" if m.group(3) == "public" else "platform"

    # SET / SELECT pg_catalog.set_config / other session setup.
    if re.match(r"(?is)\s*(SET|SELECT\s+pg_catalog\.set_config)\b", head):
        return "preamble"

    # Everything else: first quoted schema qualifier wins.
    q = re.search(r'"([A-Za-z_0-9]+)"\s*\.\s*"', body)
    if q:
        return "platform" if q.group(1) in PLATFORM else "public"

    # Unqualified GRANT/REVOKE/ALTER DEFAULT PRIVILEGES etc. — check for a bare
    # schema mention, else treat as public so nothing is silently dropped.
    b = re.search(r'(?is)\bON\s+SCHEMA\s+"?([A-Za-z_0-9]+)"?', body)
    if b:
        return "public" if b.group(1) == "public" else "platform"
    b = re.search(r'(?is)\bIN\s+SCHEMA\s+"?([A-Za-z_0-9]+)"?', body)
    if b:
        return "public" if b.group(1) == "public" else "platform"
    return "public"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="out", required=True)
    a = ap.parse_args()

    sql = open(a.src, encoding="utf-8").read()
    stmts = split_statements(sql)

    buckets = {"preamble": [], "public": [], "platform": []}
    for s in stmts:
        buckets[classify(s)].append(s)

    os.makedirs(a.out, exist_ok=True)
    header = (
        "-- DERIVED FILE — not a fresh pg_dump.\n"
        "-- Produced by scripts/backup/split-dump-by-schema.py from\n"
        f"--   {a.src}\n"
        "-- which was taken with the wrong --schema flag (BACKUP_RESTORE §4b.2).\n"
        "-- Superseded the moment a real `--schema public` dump exists (§7 step 2).\n\n"
    )
    pub = os.path.join(a.out, "pg_dump-public.sql")
    plat = os.path.join(a.out, "pg_dump-platform.sql")
    with open(pub, "w", encoding="utf-8", newline="\n") as f:
        f.write(header + "\n".join(buckets["preamble"] + buckets["public"]) + "\n")
    with open(plat, "w", encoding="utf-8", newline="\n") as f:
        f.write(header + "\n".join(buckets["preamble"] + buckets["platform"]) + "\n")

    total = len(stmts)
    print(f"statements parsed : {total}")
    for k in ("preamble", "public", "platform"):
        print(f"  {k:<9}: {len(buckets[k])}")
    assert sum(len(v) for v in buckets.values()) == total, "statement lost in split"
    print(f"\nwrote {pub}")
    print(f"wrote {plat}")

    leaked = [s for s in buckets["public"] if re.search(r'(?i)SET\s+ROLE|OWNER\s+TO\s+"?supabase_(admin|auth_admin|storage_admin)', s)]
    print(f"\nsupabase_admin ownership statements left in the public half: {len(leaked)}")
    for s in leaked[:5]:
        print("  " + s[:120].replace("\n", " "))
    return 1 if leaked else 0


if __name__ == "__main__":
    sys.exit(main())
