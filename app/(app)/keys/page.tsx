import { KeysFilters } from "@/components/features/keys/filters";
import { RegisterKeyDialog } from "@/components/features/keys/key-dialogs";
import {
  KeysRegister,
  type KeyRegisterRow,
} from "@/components/features/keys/keys-register";
import { Pager } from "@/components/features/shared/pager";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";
import { formatDateTime } from "@/lib/utils/format";
import { keyFiltersSchema, sanitizeSearchTerm, type KeyStatus } from "@/lib/validators/keys";
import {
  isRangeBeyondEnd,
  pageRange,
  pageSchema,
  totalPages as countPages,
} from "@/lib/validators/pagination";

export const dynamic = "force-dynamic";

const MOVEMENT_LINES: Record<string, (holder: string | null) => string> = {
  checkout: (holder) => `checked out to ${holder ?? "—"}`,
  return: () => "returned to office",
  transfer: (holder) => `handed to owner${holder ? ` (${holder})` : ""}`,
  mark_lost: (holder) => `marked lost${holder ? ` — last with ${holder}` : ""}`,
};

export default async function KeysPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const filters = keyFiltersSchema.parse({ status: first(sp.status), q: first(sp.q) });
  const page = pageSchema.parse(first(sp.page));
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // The text filter used to run client-side over every fetched row. Now the
  // register is paged, it has to run in the query or it would only ever search
  // the current page (audit 2026-07-22, PERF-2). The property REFERENCE lives
  // on a joined table, which PostgREST cannot reach from .or(), so resolve it
  // to ids first and fold those into the same disjunction.
  const term = filters.q ? sanitizeSearchTerm(filters.q) : "";
  let matchedPropertyIds: string[] = [];
  if (term) {
    const { data: matches } = await supabase
      .from("properties")
      .select("id")
      .ilike("reference", `%${term}%`)
      .limit(200);
    matchedPropertyIds = (matches ?? []).map((p) => p.id);
  }

  const applyFilters = <T extends { eq: (c: string, v: string) => T; or: (f: string) => T }>(
    q: T,
  ): T => {
    let out = q;
    if (filters.status !== "all") out = out.eq("status", filters.status);
    if (term) {
      const clauses = [
        `key_code.ilike.%${term}%`,
        `description.ilike.%${term}%`,
        `current_holder_name.ilike.%${term}%`,
      ];
      if (matchedPropertyIds.length) clauses.push(`property_id.in.(${matchedPropertyIds.join(",")})`);
      out = out.or(clauses.join(","));
    }
    return out;
  };

  const { from, to } = pageRange(page);
  const [keysRes, movementsRes, registeredRes, checkedOutRes] = await Promise.all([
    applyFilters(
      supabase
        .from("property_keys")
        .select(
          "id, key_code, description, status, current_holder_name, property_id, properties(reference)",
          { count: "exact" },
        ),
    )
      .order("created_at", { ascending: false })
      .range(from, to),
    supabase
      .from("key_movements")
      .select(
        `id, action, holder_name, note, occurred_at,
         property_keys(key_code, properties(reference)),
         actor:profiles!created_by(full_name)`,
      )
      .order("occurred_at", { ascending: false })
      .limit(30),
    // header describes the WHOLE register, never the filtered page
    supabase.from("property_keys").select("id", { count: "exact", head: true }),
    supabase
      .from("property_keys")
      .select("id", { count: "exact", head: true })
      .eq("status", "checked_out"),
  ]);
  // a stale ?page= past the end is an empty page, not a load failure
  const keyRows = unwrapRows(
    isRangeBeyondEnd(keysRes.error) ? { data: [], error: null } : keysRes,
    "keys",
  );
  const movementRows = unwrapRows(movementsRes, "key movements");

  const filteredTotal = keysRes.count ?? 0;
  const registeredCount = registeredRes.count ?? 0;
  const checkedOut = checkedOutRes.count ?? 0;
  const pageCount = countPages(filteredTotal);
  const isFiltered = filters.status !== "all" || Boolean(term);

  const keys: KeyRegisterRow[] = keyRows.map((k) => ({
    id: k.id,
    keyCode: k.key_code,
    description: k.description,
    status: k.status as KeyStatus,
    holderName: k.current_holder_name,
    propertyId: k.property_id,
    propertyRef: (k.properties as { reference: string } | null)?.reference ?? "—",
  }));

  const movements = movementRows.map((m) => {
    const key = m.property_keys as {
      key_code: string;
      properties: { reference: string } | null;
    } | null;
    return {
      id: m.id,
      action: m.action as string,
      holder: m.holder_name,
      note: m.note,
      at: m.occurred_at,
      keyCode: key?.key_code ?? "—",
      propertyRef: key?.properties?.reference ?? "—",
      actor: (m.actor as { full_name: string } | null)?.full_name ?? "—",
    };
  });

  const canEdit = profile.role === "admin" || profile.role === "listing_manager";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-1">Keys</h1>
          <p className="text-sm text-text-2">
            {registeredCount} registered · {checkedOut} out
          </p>
        </div>
        {canEdit ? <RegisterKeyDialog /> : null}
      </div>

      <KeysFilters />

      <KeysRegister
        keys={keys}
        canEdit={canEdit}
        emptyText={
          page > 1
            ? "Nothing on this page."
            : isFiltered
              ? "No keys match."
              : "No keys registered yet."
        }
      />

      <Pager
        page={page}
        pageCount={pageCount}
        total={filteredTotal}
        searchParams={sp}
        label={isFiltered ? "matching keys" : "keys"}
      />

      <section className="rounded-[10px] border border-border bg-surface p-5">
        <h2 className="mb-3 text-sm font-semibold text-text-1">Recent movements</h2>
        {movements.length === 0 ? (
          <p className="text-sm text-text-3">No movements yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {movements.map((m) => (
              <li key={m.id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                <span className="min-w-0 text-text-1">
                  <span className="font-mono text-xs font-semibold">{m.keyCode}</span>
                  <span className="mx-1.5 text-text-3">·</span>
                  {(MOVEMENT_LINES[m.action] ?? (() => m.action.replace(/_/g, " ")))(m.holder)}
                  <span className="ml-1.5 text-xs text-text-3">
                    {m.propertyRef} · by {m.actor}
                  </span>
                  {m.note ? <span className="block text-xs text-text-3">{m.note}</span> : null}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-text-3">
                  {formatDateTime(m.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
