import Link from "next/link";
import { Download, Plus, Users } from "lucide-react";
import { ContactsFilters } from "@/components/features/contacts/filters";
import { StatusBadge } from "@/components/features/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatPhone } from "@/lib/services/phone";
import { createClient } from "@/lib/supabase/server";
import { CONTACTS_PAGE_SIZE } from "@/lib/validators/contacts";
import {
  applyContactListFilters,
  parseContactListFilters,
} from "@/lib/queries/contacts-list";
import { formatDateTime } from "@/lib/utils/format";

type SearchParams = { [key: string]: string | string[] | undefined };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const TEMP_TONES: Record<string, string> = {
  hot: "text-danger",
  warm: "text-warning",
  cold: "text-brand-500",
  inactive: "text-text-3",
  vip: "text-accent-500",
};

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const filters = parseContactListFilters(sp);
  const page = Math.max(1, Number(first(sp.page)) || 1);

  const supabase = await createClient();

  const { data: profileRows } = await supabase
    .from("profiles")
    .select("id, full_name, is_active")
    .order("full_name");
  const agentOptions = (profileRows ?? []).filter((p) => p.is_active);

  const base = supabase
    .from("contacts")
    .select(
      "id, display_name, contact_kind, phone_e164, email, contact_types, temperature, source, nationality, languages, assigned_agent_id, created_at, merged_into_id",
      { count: "exact" },
    );

  const from = (page - 1) * CONTACTS_PAGE_SIZE;
  const result = await applyContactListFilters(base, filters)
    .order("created_at", { ascending: false })
    .range(from, from + CONTACTS_PAGE_SIZE - 1);
  if (result.error && result.error.code !== "PGRST103") {
    throw new Error(`Contacts query failed: ${result.error.message}`);
  }
  const rows = result.data ?? [];
  const total = result.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / CONTACTS_PAGE_SIZE));

  // name map includes deactivated agents so their contacts don't read as unassigned
  const agentName = new Map(
    (profileRows ?? []).map((p) => [p.id, p.is_active ? p.full_name : `${p.full_name} (inactive)`]),
  );
  const pageParams = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      const val = first(v);
      if (val) params.set(k, val);
    }
    params.set("page", String(p));
    return `?${params.toString()}`;
  };

  // Export carries the active filters but not pagination — it is the whole
  // filtered set, not the current page. RLS scopes it to what this user can see.
  const exportHref = (() => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === "page") continue;
      const val = first(v);
      if (val) params.set(k, val);
    }
    const qs = params.toString();
    return `/contacts/export${qs ? `?${qs}` : ""}`;
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-1">Contacts</h1>
          <p className="text-sm text-text-2">
            {total} {filters.archived ? "archived " : ""}contact{total === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {total > 0 ? (
            <Button asChild variant="outline">
              {/* Plain anchor, not next/link: this is a file download, not a navigation. */}
              <a href={exportHref} download>
                <Download className="size-4" /> Export CSV
              </a>
            </Button>
          ) : null}
          <Button asChild>
            <Link href="/contacts/new">
              <Plus className="size-4" /> Add contact
            </Link>
          </Button>
        </div>
      </div>

      <ContactsFilters agents={agentOptions} />

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[10px] border border-border bg-surface py-16">
          <Users className="size-8 text-text-3" />
          <p className="text-sm text-text-2">
            {filters.archived
              ? "No archived contacts match."
              : "No contacts match — add the first one."}
          </p>
          {filters.archived ? null : (
            <Button asChild variant="outline" size="sm">
              <Link href="/contacts/new">
                <Plus className="size-4" /> Add contact
              </Link>
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Types</TableHead>
                <TableHead>Temp</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Added</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id} className="h-11 hover:bg-surface-2">
                  <TableCell className="font-medium">
                    <Link href={`/contacts/${c.id}`} className="text-brand-700 hover:underline">
                      {c.display_name}
                    </Link>
                    {filters.archived && c.merged_into_id ? (
                      <span className="ml-2 rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-3">
                        merged
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="tabular-nums text-[13px]">
                    {c.phone_e164 ? formatPhone(c.phone_e164) : "—"}
                  </TableCell>
                  <TableCell className="text-[13px]">{c.email ?? "—"}</TableCell>
                  <TableCell className="max-w-40 truncate text-[13px] text-text-2">
                    {(c.contact_types ?? []).map((t) => t.replace(/_/g, " ")).join(", ") || "—"}
                  </TableCell>
                  <TableCell>
                    <span className={`text-[13px] font-medium ${TEMP_TONES[c.temperature] ?? ""}`}>
                      {c.temperature}
                    </span>
                  </TableCell>
                  <TableCell className="text-[13px] text-text-2">
                    {c.source ? <StatusBadge status={c.source} /> : "—"}
                  </TableCell>
                  <TableCell className="text-[13px] text-text-2">
                    {c.assigned_agent_id ? (agentName.get(c.assigned_agent_id) ?? "—") : "—"}
                  </TableCell>
                  <TableCell className="text-[13px] text-text-3">
                    {formatDateTime(c.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-sm text-text-2">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={pageParams(page - 1)}>Previous</Link>
              </Button>
            ) : null}
            {page < totalPages ? (
              <Button asChild variant="outline" size="sm">
                <Link href={pageParams(page + 1)}>Next</Link>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
