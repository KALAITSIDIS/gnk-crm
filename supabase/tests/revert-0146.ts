import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BODY_0137_MD5 } from "./revert-0137";

/**
 * The way back from 0146 to 0137's public share page and 0023 / 0100's share
 * link policies — 0146's documented ROLLBACK: resolve_share_link() recreated
 * with 0137's exact text and grants, sliced from 0137's own file so it cannot
 * drift from what 0137 applied (local and hosted both hashed 466cf76e… on
 * 2026-10-14), and the three policies' WITH CHECKs restated as 0023 / 0100
 * wrote them (each deparses to the text 0146's preflight pins — the replay in
 * share-link-tenant-binding.test.ts is the proof).
 *
 * ALTER POLICY takes ACCESS EXCLUSIVE on both tables, so the text takes them
 * first, share_links before share_link_properties (0146's order). ONE
 * transaction (it uses `set local`). If 0147 has landed, revert it FIRST: this
 * text restores the insert check's bare helper call, which 0147's schema-wide
 * guard (rls_bare_helper_calls) and its restore-pack row report.
 *
 * Used by share-link-tenant-binding.test.ts to replay 0146 over 0137's body
 * and to prove the rollback restores the leak — always inside a rolled-back
 * transaction. Not a test file: it registers no tests. Never pointed at
 * hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf-8").replace(/\r\n/g, "\n");

export const MIGRATION_0146 = "0146_share_link_tenant_binding.sql";
export const readMigration0146 = () => read(MIGRATION_0146);

export const SIG_0146 = "public.resolve_share_link(text)";
/** md5 of 0137's prosrc (carriage returns ignored) — 0146's preflight guard, and what the rollback restores. */
export { BODY_0137_MD5 };
/** md5 of 0146's prosrc — its postflight's pin. */
export const BODY_0146_MD5 = "e592f596582022c927e1df28742e3140";
/** 0041's ACL, which 0146 keeps exactly. */
export const ACL_0041 = "{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}";

/**
 * 0146's seven edits to 0137's function text, [0137's text, 0146's text] — each unique in the body. Reversing them on
 * 0146's body must give 0137's byte for byte; that is the "change nothing else" proof.
 */
export const EDITS_0146: readonly (readonly [string, string])[] = [
  [
    "    select * into v_project from properties where id = v_target;\n",
    "    -- 0146: the target is a property of the link's own organisation, or none\n    select * into v_project from properties where id = v_target and org_id = v_link.org_id;\n",
  ],
  [
    "      select * into v_pl from price_lists where id = v_link.price_list_id;\n",
    "      -- 0146: only a price list of the link's own organisation is read\n      select * into v_pl from price_lists where id = v_link.price_list_id and org_id = v_link.org_id;\n",
  ],
  [
    "       where p.id = v_target\n      union all\n",
    "       where p.id = v_target\n         -- 0146: the walk starts inside the link's own organisation...\n         and p.org_id = v_link.org_id\n      union all\n",
  ],
  [
    "         and c.visibility <> 'archived'\n    )\n",
    "         and c.visibility <> 'archived'\n         -- 0146: ...and stays there: another organisation's row hung under ours is not walked\n         and c.org_id = v_link.org_id\n    )\n",
  ],
  [
    "                 on pli.price_list_id = v_link.price_list_id\n",
    "                 -- 0146: the lines of the list read above, never of the link's raw id\n                 on pli.price_list_id = v_pl.id\n",
  ],
  [
    "  select count(*) into v_count\n    from share_link_properties where share_link_id = v_link.id;\n",
    "  -- 0146: every linked row of the link's own organisation, archived ones\n  -- included (the page reports the shortfall); another organisation's is not\n  select count(*) into v_count\n    from share_link_properties slp\n   where slp.share_link_id = v_link.id\n     and exists (select 1 from properties p\n                  where p.id = slp.property_id and p.org_id = v_link.org_id);\n",
  ],
  [
    "        join properties pr on pr.id = slp.property_id\n",
    "        -- 0146: only the link's own organisation's properties are shown\n        join properties pr on pr.id = slp.property_id and pr.org_id = v_link.org_id\n",
  ],
];

/** The three policies' checks, as pg_get_expr renders them under `"$user", public, extensions` — before and after 0146. */
export const POLICIES_0146 = {
  share_link_properties_insert: {
    table: "share_link_properties",
    before: "(EXISTS ( SELECT 1\n   FROM share_links s\n  WHERE ((s.id = share_link_properties.share_link_id) AND (s.org_id = current_org_id()))))",
    after:
      "((EXISTS ( SELECT 1\n   FROM share_links s\n  WHERE ((s.id = share_link_properties.share_link_id) AND (s.org_id = ( SELECT current_org_id() AS current_org_id))))) AND (EXISTS ( SELECT 1\n   FROM properties p\n  WHERE ((p.id = share_link_properties.property_id) AND (p.org_id = ( SELECT current_org_id() AS current_org_id))))))",
  },
  share_links_insert: {
    table: "share_links",
    before: "((org_id = ( SELECT current_org_id() AS current_org_id)) AND (created_by = ( SELECT auth.uid() AS uid)))",
    after:
      "((org_id = ( SELECT current_org_id() AS current_org_id)) AND (created_by = ( SELECT auth.uid() AS uid)) AND ((price_list_id IS NULL) OR (EXISTS ( SELECT 1\n   FROM price_lists pl\n  WHERE ((pl.id = share_links.price_list_id) AND (pl.org_id = ( SELECT current_org_id() AS current_org_id)))))))",
  },
  share_links_update: {
    table: "share_links",
    before: "(org_id = ( SELECT current_org_id() AS current_org_id))",
    after:
      "((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((price_list_id IS NULL) OR (EXISTS ( SELECT 1\n   FROM price_lists pl\n  WHERE ((pl.id = share_links.price_list_id) AND (pl.org_id = ( SELECT current_org_id() AS current_org_id)))))))",
  },
} as const;
/** share_links_update's USING, which 0146 does not touch (0100's). */
export const SHARE_LINKS_UPDATE_USING =
  "((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((created_by = ( SELECT auth.uid() AS uid)) OR (( SELECT current_role_gnk() AS current_role_gnk) = 'admin'::user_role)))";

/** 0137's function statement and grants, from 0137's file. */
export function fn0137(): string {
  const s = read("0137_share_link_opened_own_org.sql");
  const start = s.indexOf("create or replace function resolve_share_link(");
  const endMark = "grant  execute on function resolve_share_link(text) to anon, authenticated, service_role;";
  const end = s.indexOf(endMark, start);
  if (start < 0 || end < 0) throw new Error("revert-0146: 0137's resolve_share_link text was not found");
  return s.slice(start, end + endMark.length);
}

/** 0146's function statement and grants, from 0146's file (for the text-level check). */
export function fn0146(): string {
  const s = readMigration0146();
  const start = s.indexOf("create or replace function resolve_share_link(");
  const endMark = "grant  execute on function resolve_share_link(text) to anon, authenticated, service_role;";
  const end = s.indexOf(endMark, start);
  if (start < 0 || end < 0) throw new Error("revert-0146: 0146's resolve_share_link text was not found");
  return s.slice(start, end + endMark.length);
}

export const REVERT_0146_SQL = () =>
  [
    "set local lock_timeout = '5s';",
    "lock table public.share_links, public.share_link_properties in access exclusive mode;",
    // 0023's check, as 0023 wrote it
    `alter policy share_link_properties_insert on public.share_link_properties
  with check (exists (select 1 from share_links s
                       where s.id = share_link_properties.share_link_id and s.org_id = current_org_id()));`,
    // 0100's hoisted checks, as 0100 wrote them
    `alter policy share_links_insert on public.share_links
  with check (((org_id = (select current_org_id())) AND (created_by = (select auth.uid()))));`,
    `alter policy share_links_update on public.share_links
  with check ((org_id = (select current_org_id())));`,
    fn0137(),
  ].join("\n\n");
