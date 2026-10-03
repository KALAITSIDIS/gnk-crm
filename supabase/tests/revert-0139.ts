import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 0139's ten keys and the way back to 0138's catalogue, shared by the test
 * files that need them: contact-links-org-isolation.test.ts (0139's own
 * replays) and viewing-parent-org-isolation.test.ts (0123's), which must take
 * 0139 off first: 0139's ten keys depend on 0123's contacts_org_id_id_key,
 * which 0123's revert drops (2BP01 otherwise). 0126's revert is independent
 * of 0139.
 *
 * 0139 KEEPS every key's name, so a revert cannot tell 0138 from 0139 by name:
 * it detects 0139 by DEFINITION (leads_contact_id_fkey has two key columns).
 *
 * Not a test file: it registers no tests. Never pointed at hosted.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATION_0139 = join(here, "..", "migrations", "0139_contact_links_org_isolation.sql");
export const readMigration0139 = () => readFileSync(MIGRATION_0139, "utf8");

/** The ten links: table, column, the constraint (name kept), its delete rule, the index 0139 adds. */
export const LINKS_0139 = [
  { table: "leads", column: "contact_id", key: "leads_contact_id_fkey", del: "a", index: "leads_org_contact_idx" },
  { table: "deals", column: "buyer_contact_id", key: "deals_buyer_contact_id_fkey", del: "a", index: "deals_org_buyer_contact_idx" },
  { table: "deals", column: "seller_contact_id", key: "deals_seller_contact_id_fkey", del: "a", index: "deals_org_seller_contact_idx" },
  { table: "offers", column: "contact_id", key: "offers_contact_id_fkey", del: "a", index: "offers_org_contact_idx" },
  { table: "share_links", column: "contact_id", key: "share_links_contact_id_fkey", del: "a", index: "share_links_org_contact_idx" },
  { table: "buyer_requirements", column: "contact_id", key: "buyer_requirements_contact_id_fkey", del: "c", index: "buyer_requirements_org_contact_idx" },
  { table: "mandates", column: "owner_contact_id", key: "mandates_owner_contact_id_fkey", del: "a", index: "mandates_org_owner_contact_idx" },
  { table: "properties", column: "owner_contact_id", key: "properties_owner_contact_id_fkey", del: "a", index: "properties_org_owner_contact_idx" },
  { table: "properties", column: "developer_contact_id", key: "properties_developer_contact_id_fkey", del: "a", index: "properties_org_developer_contact_idx" },
  { table: "contacts", column: "merged_into_id", key: "contacts_merged_into_id_fkey", del: "a", index: "contacts_org_merged_into_idx" },
] as const;

/**
 * 0138's catalogue for 0139's objects, inside the caller's transaction: each
 * key back to its original single-column definition under the same name
 * (buyer_requirements' with ON DELETE CASCADE), the ten indexes gone. NOT the
 * hosted rollback as it stands: it has no lock_timeout and no up-front LOCK
 * (0139's header says how to wrap it). A no-op
 * on a database still at 0138 — detected by definition, not by name — so the
 * earlier files can run it unconditionally.
 */
export const REVERT_0139_SQL = `
  do $rev$
  begin
    if not exists (select 1 from pg_constraint
                    where conname = 'leads_contact_id_fkey' and conrelid = 'public.leads'::regclass
                      and array_length(conkey, 1) = 2) then
      return;
    end if;
${LINKS_0139.map(
  (l) => `    alter table public.${l.table}
      drop constraint ${l.key},
      add constraint ${l.key} foreign key (${l.column}) references public.contacts(id)${l.del === "c" ? " on delete cascade" : ""};
    drop index if exists public.${l.index};`,
).join("\n")}
  end $rev$;
`;
