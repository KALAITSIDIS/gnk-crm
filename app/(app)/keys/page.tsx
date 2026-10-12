import { KeysFilters } from "@/components/features/keys/filters";
import { RegisterKeyDialog } from "@/components/features/keys/key-dialogs";
import {
  KeysRegister,
  type KeyRegisterRow,
} from "@/components/features/keys/keys-register";
import { Pager } from "@/components/features/shared/pager";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { unwrapCount, unwrapRows } from "@/lib/supabase/unwrap";
import { formatDateTime } from "@/lib/utils/format";
import { type KeyStatus } from "@/lib/validators/keys";
import {
  applyKeyListFilters,
  parseKeyFilters,
  withKeySearchEmbed,
} from "@/lib/queries/keys-list";
import {
  isRangeBeyondEnd,
  pageRange,
  pageSchema,
  totalPages as countPages,
} from "@/lib/validators/pagination";
import { ExportCsvButton } from "@/components/features/shared/export-csv-button";

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
  // a search the register cannot run (longer than the box allows) is refused
  // in words: no key query at all — never the unfiltered register, never a
  // truncated search (T-keys-search-length)
  const { filters, refusal } = parseKeyFilters(sp);
  const page = pageSchema.parse(first(sp.page));
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // The text filter runs in the query (paged register — a client-side filter
  // would search one page only, PERF-2), the property REFERENCE included, in
  // this one request. Shared with the export route. T-key-reference-search
  const { from, to } = pageRange(page);
  const keysQuery = filters
    ? applyKeyListFilters(
        supabase
          .from("property_keys")
          .select(
            withKeySearchEmbed(
              "id, key_code, description, status, current_holder_name, property_id, properties(reference)",
              filters,
            ),
            { count: "exact" },
          ),
        filters,
      )
        .order("created_at", { ascending: false })
        // `id` breaks created_at ties: without a unique last key each offset page
        // may order tied keys differently, repeating some and skipping others.
        // Same order as the CSV export. (A key registered between two page loads
        // still shifts the pages — each is its own request.) T-list-page-order
        .order("id")
        .range(from, to)
    : null;
  const [keysRes, movementsRes, registeredRes, checkedOutRes] = await Promise.all([
    keysQuery,
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
  const keyRows = keysRes
    ? unwrapRows(isRangeBeyondEnd(keysRes.error) ? { data: [], error: null } : keysRes, "keys")
    : [];
  const movementRows = unwrapRows(movementsRes, "key movements");

  const filteredTotal = keysRes?.count ?? 0;
  // a count that could not be read is a load failure, never "0 registered"
  // (which would also hide Export) — T-keys-header-counts
  const registeredCount = unwrapCount(registeredRes, "key count");
  const checkedOut = unwrapCount(checkedOutRes, "checked-out key count");
  const pageCount = countPages(filteredTotal);
  const isFiltered = !filters || filters.status !== "all" || Boolean(filters.q);

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

  // Export carries the active status/search filters but not pagination.
  const keysExportHref = (() => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === "page") continue;
      const val = first(v);
      if (val) params.set(k, val);
    }
    const qs = params.toString();
    return `/keys/export${qs ? `?${qs}` : ""}`;
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-1">Keys</h1>
          <p className="text-sm text-text-2">
            {registeredCount} registered · {checkedOut} out
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Carries the active filters — none for a refused search, whose
              export would only be refused too. */}
          {registeredCount > 0 && !refusal ? <ExportCsvButton href={keysExportHref} /> : null}
          {canEdit ? <RegisterKeyDialog /> : null}
        </div>
      </div>

      <KeysFilters />

      <KeysRegister
        keys={keys}
        canEdit={canEdit}
        emptyText={
          refusal ??
          (page > 1
            ? "Nothing on this page."
            : isFiltered
              ? "No keys match."
              : "No keys registered yet.")
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
