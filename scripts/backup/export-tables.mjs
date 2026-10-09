/**
 * What export.mjs reads, and how it reads it. Kept apart from export.mjs, which
 * checks its environment and exits on import, so tests can load it.
 */

/**
 * Load order is irrelevant on restore (it runs with session_replication_role =
 * replica, so FKs are deferred), but keeping parents first makes a partial
 * restore readable if anyone ever does one by hand.
 */
export const TABLES = [
  "organizations", "profiles", "districts", "areas", "cyprus_config",
  "deal_stages", "reference_counters", "task_kinds", "unit_types", "contacts",
  "buyer_requirements", "properties", "property_media", "property_keys",
  "key_movements", "mandates", "leads", "interaction_notes", "deals", "offers", "viewings",
  "viewing_slips", "documents", "tasks", "price_lists", "price_list_items",
  "payment_plans", "price_history", "reservations", "reservation_installments",
  // 0142: which unit-type applications committed — ids and counts only; a
  // restore that loses it lets a retried submission apply a second time.
  "unit_type_applications",
  "share_links", "share_link_properties", "share_link_attempts",
  "public_listing_attempts", "public_enquiry_attempts",
  // 0095: the feed_token IS the portal's pull URL, so a restore that loses
  // this table points every enabled portal at a dead link.
  "portal_connections", "portal_listings",
  // 0101: the desk-alert outbox — ids, states and counters only, no person;
  // a restore that loses it loses which enquiries still owe the desk a word.
  "notification_jobs",
  "enquiry_alert_sweep_runs",
  "chain_checks", "events_chain_checkpoint",
  "events",
];

/**
 * Each exported table's PRIMARY KEY, columns in constraint order. A new table
 * in TABLES needs its key here (a unit test pins that the two agree) and the
 * key must be the real one (supabase/tests/backup-export-keys.test.ts compares
 * every entry with pg_constraint on a migrated database).
 *
 * @type {Record<string, string[]>}
 */
export const PRIMARY_KEYS = {
  organizations: ["id"],
  profiles: ["id"],
  districts: ["id"],
  areas: ["id"],
  cyprus_config: ["key"],
  deal_stages: ["id"],
  reference_counters: ["org_id", "district_code"],
  task_kinds: ["kind"],
  unit_types: ["id"],
  contacts: ["id"],
  buyer_requirements: ["id"],
  properties: ["id"],
  property_media: ["id"],
  property_keys: ["id"],
  key_movements: ["id"],
  mandates: ["id"],
  leads: ["id"],
  interaction_notes: ["id"],
  deals: ["id"],
  offers: ["id"],
  viewings: ["id"],
  viewing_slips: ["id"],
  documents: ["id"],
  tasks: ["id"],
  price_lists: ["id"],
  price_list_items: ["price_list_id", "unit_id"],
  payment_plans: ["id"],
  price_history: ["id"],
  reservations: ["id"],
  reservation_installments: ["id"],
  unit_type_applications: ["org_id", "operation_id"],
  share_links: ["id"],
  share_link_properties: ["share_link_id", "property_id"],
  share_link_attempts: ["ip_hash", "window_start"],
  public_listing_attempts: ["ip_hash", "window_start"],
  public_enquiry_attempts: ["ip_hash", "window_start"],
  portal_connections: ["id"],
  portal_listings: ["property_id", "portal"],
  notification_jobs: ["id"],
  enquiry_alert_sweep_runs: ["id"],
  chain_checks: ["org_id"],
  events_chain_checkpoint: ["org_id"],
  events: ["id", "occurred_at"],
};

export const PAGE = 1000;

/**
 * A value inside PostgREST's `or=(…)` list. Quoted always: `,` `.` `:` `(`
 * `)` are the list's own syntax, and a timestamp key carries three of them.
 */
const quote = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * The PostgREST `or` filter for rows strictly AFTER `last` in `key` order —
 * the lexicographic row comparison `(k1, k2, …) > (v1, v2, …)` spelled as
 * `k1 > v1 OR (k1 = v1 AND k2 > v2) OR …`, because PostgREST has no row
 * constructor. Values are compared by the database, in the same collation the
 * ORDER BY used, so the page boundary and the sort can never disagree.
 */
export function afterKeyFilter(key, last) {
  return key
    .map((col, i) => {
      const gt = `${col}.gt.${quote(last[col])}`;
      if (i === 0) return gt;
      return `and(${[...key.slice(0, i).map((c) => `${c}.eq.${quote(last[c])}`), gt].join(",")})`;
    })
    .join(",");
}

/**
 * Every row of `table`, in primary-key order, one page at a time — each page
 * starts strictly after the last key the previous page returned (keyset
 * paging), and the read ends on an EMPTY page.
 *
 * The export used `.range(from, from + 999)` with no ORDER BY and stopped at
 * the first short page. Each page is its own statement and the database keeps
 * working between them (the enquiry-alerts cron inserts, updates and, from
 * 2026-10-21, deletes every two minutes), so:
 *   - unordered, Postgres answers in physical order, and a row UPDATEd between
 *     pages moves past the offset already read: read twice, and its neighbour
 *     never — with the row count unchanged, so nothing downstream sees it;
 *   - ordered by offset, a DELETE between pages slides every later row down
 *     one place and the row at the boundary is skipped;
 *   - a server row cap below the page size (Supabase `max_rows`) returned a
 *     short first page, which the loop took for the end of the table.
 * Keyset paging reads every row that exists for the whole read exactly once,
 * whatever is inserted, updated or deleted around it — primary keys do not
 * change here (0132) — and an empty page is the only proof of the end.
 */
export async function readAllRows(sb, table, key = PRIMARY_KEYS[table], pageSize = PAGE) {
  if (!key?.length) {
    throw new Error(`${table}: no primary key in PRIMARY_KEYS — refusing to page it in an order nobody chose`);
  }
  const rows = [];
  let last = null;
  for (;;) {
    let q = sb.from(table).select("*");
    for (const col of key) q = q.order(col, { ascending: true });
    if (last) q = key.length === 1 ? q.gt(key[0], last[key[0]]) : q.or(afterKeyFilter(key, last));
    const { data, error } = await q.limit(pageSize);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data.length) return rows;
    rows.push(...data);
    last = data[data.length - 1];
  }
}
