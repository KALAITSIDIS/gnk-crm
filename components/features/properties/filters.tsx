"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LayoutGrid, Search, TableProperties, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MANDATE_FILTERS,
  PROPERTY_SCOPES,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  TRANSACTION_TYPES,
  VISIBILITY_LEVELS,
} from "@/lib/validators/properties";

export interface DistrictOption {
  id: string;
  name: string;
}
export interface AreaOption {
  id: string;
  districtId: string;
  name: string;
}

const ALL = "__all__";

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function PropertiesFilters({
  districts,
  areas,
}: {
  districts: DistrictOption[];
  areas: AreaOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setParams = useCallback(
    (updates: Record<string, string | undefined>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === "" || value === ALL) params.delete(key);
        else params.set(key, value);
      }
      params.delete("page"); // any filter change resets pagination
      router.replace(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams],
  );

  // debounced fuzzy search
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);
  const onSearchChange = (value: string) => {
    setSearch(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setParams({ q: value || undefined }), 300);
  };

  const district = searchParams.get("district") ?? ALL;
  const districtAreas = areas.filter((a) => a.districtId === district);
  const view = searchParams.get("view") === "cards" ? "cards" : "table";
  const hasFilters = [
    "q",
    "district",
    "area",
    "type",
    "transaction",
    "status",
    "visibility",
    "beds",
    "price_min",
    "price_max",
    "mandate",
    "scope",
  ].some((k) => searchParams.has(k));

  const selectClass = "h-9 w-auto min-w-28 text-[13px]";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search reference, title, address…"
            className="h-9 pl-8 text-[13px]"
          />
        </div>

        <Select value={district} onValueChange={(v) => setParams({ district: v, area: undefined })}>
          <SelectTrigger className={selectClass}>
            <SelectValue placeholder="District" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All districts</SelectItem>
            {districts.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={searchParams.get("area") ?? ALL}
          onValueChange={(v) => setParams({ area: v })}
          disabled={district === ALL}
        >
          <SelectTrigger className={selectClass}>
            <SelectValue placeholder="Area" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All areas</SelectItem>
            {districtAreas.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={searchParams.get("type") ?? ALL} onValueChange={(v) => setParams({ type: v })}>
          <SelectTrigger className={selectClass}>
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {PROPERTY_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {labelize(t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={searchParams.get("transaction") ?? ALL}
          onValueChange={(v) => setParams({ transaction: v })}
        >
          <SelectTrigger className={selectClass}>
            <SelectValue placeholder="Transaction" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Sale & rent</SelectItem>
            {TRANSACTION_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {labelize(t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={searchParams.get("status") ?? ALL}
          onValueChange={(v) => setParams({ status: v })}
        >
          <SelectTrigger className={selectClass}>
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {PROPERTY_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {labelize(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={searchParams.get("visibility") ?? ALL}
          onValueChange={(v) => setParams({ visibility: v })}
        >
          <SelectTrigger className={selectClass}>
            <SelectValue placeholder="Visibility" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All visibility</SelectItem>
            {VISIBILITY_LEVELS.map((v) => (
              <SelectItem key={v} value={v}>
                {labelize(v)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={searchParams.get("mandate") ?? ALL}
          onValueChange={(v) => setParams({ mandate: v })}
        >
          <SelectTrigger className={selectClass}>
            <SelectValue placeholder="Mandate" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any mandate</SelectItem>
            {MANDATE_FILTERS.map((m) => (
              <SelectItem key={m} value={m}>
                {labelize(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* key= remounts the uncontrolled inputs when the URL param changes
            (e.g. Clear), so they can't display a filter that's no longer set */}
        <Input
          key={`beds-${searchParams.get("beds") ?? ""}`}
          type="number"
          min={0}
          placeholder="Beds ≥"
          defaultValue={searchParams.get("beds") ?? ""}
          onBlur={(e) => setParams({ beds: e.target.value || undefined })}
          className="h-9 w-20 text-[13px]"
        />
        <Input
          key={`min-${searchParams.get("price_min") ?? ""}`}
          type="number"
          min={0}
          placeholder="€ min"
          defaultValue={searchParams.get("price_min") ?? ""}
          onBlur={(e) => setParams({ price_min: e.target.value || undefined })}
          className="h-9 w-24 text-[13px]"
        />
        <Input
          key={`max-${searchParams.get("price_max") ?? ""}`}
          type="number"
          min={0}
          placeholder="€ max"
          defaultValue={searchParams.get("price_max") ?? ""}
          onBlur={(e) => setParams({ price_max: e.target.value || undefined })}
          className="h-9 w-24 text-[13px]"
        />

        <Select
          value={searchParams.get("scope") ?? "active"}
          onValueChange={(v) => setParams({ scope: v === "active" ? undefined : v })}
        >
          <SelectTrigger className={selectClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROPERTY_SCOPES.map((s) => (
              <SelectItem key={s} value={s}>
                {s === "active" ? "Active" : s === "archived" ? "Archived" : "All"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              // the view toggle is a preference, not a filter — keep it
              router.replace(view === "cards" ? `${pathname}?view=cards` : pathname);
            }}
            className="h-9 text-text-2"
          >
            <X className="size-4" /> Clear
          </Button>
        ) : null}

        <div className="ml-auto flex items-center rounded-lg border border-border p-0.5">
          <Button
            variant={view === "table" ? "secondary" : "ghost"}
            size="icon"
            className="size-8"
            onClick={() => setParams({ view: undefined })}
            title="Table view"
          >
            <TableProperties className="size-4" />
          </Button>
          <Button
            variant={view === "cards" ? "secondary" : "ghost"}
            size="icon"
            className="size-8"
            onClick={() => setParams({ view: "cards" })}
            title="Card view"
          >
            <LayoutGrid className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
