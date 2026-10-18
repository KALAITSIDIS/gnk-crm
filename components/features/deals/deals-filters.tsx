"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { EntityPicker } from "@/components/features/shared/entity-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { EntityOption } from "@/lib/actions/entity-search";
import { DEAL_LIST_FILTER_KEYS, DEAL_TYPES, type DealListFilters } from "@/lib/queries/deals-list";
import { DEAL_LIST_STATUSES, isDayKey, type DealListStatus } from "@/lib/validators/deals";

const ALL = "__all__";

const STATUS_LABELS: Record<DealListStatus, string> = {
  open: "Open",
  won: "Won",
  lost: "Lost",
  closed: "Closed (won or lost)",
};

/**
 * The /deals register's filter bar (F05). Every filter lives in the URL — the
 * server applies it to the query (and the export applies the same one), and a
 * change always returns to page 1. `values` are the filters as the SERVER
 * parsed them, so a junk value in the URL shows as "any", the way the list
 * treats it. Text and dates write after a short pause, so typing does not
 * reload the list on every keystroke.
 */
export function DealsFilters({
  agents,
  values,
  property,
  contact,
}: {
  agents: { id: string; full_name: string }[];
  values: DealListFilters;
  /** the chosen property / contact, resolved by the page (null when none is chosen) */
  property: EntityOption | null;
  contact: EntityOption | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Typed fields (the search, the dates) write after a 400 ms pause. Every
  // change made during it is kept, and any change written sooner — a select,
  // a picker — carries the waiting ones with it, so none is lost to the other.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Record<string, string | undefined>>({});
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const push = useCallback(
    (updates: Record<string, string | undefined>) => {
      if (timer.current) clearTimeout(timer.current);
      const all = { ...pending.current, ...updates };
      pending.current = {};
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(all)) {
        if (value === undefined || value === "" || value === ALL) params.delete(key);
        else params.set(key, value);
      }
      params.delete("page"); // a changed filter always returns to page 1
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams],
  );

  const later = (update: Record<string, string | undefined>) => {
    pending.current = { ...pending.current, ...update };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => push({}), 400);
  };

  // Local copies of the typed fields, each kept in step with ITS value in the
  // URL (Back/Forward, Clear). Adjusted DURING RENDER (React's pattern for
  // state that follows a prop), as the keys filter does, rather than in an
  // effect — and only when that one value changed, so a reload caused by
  // another filter never rewrites what is being typed.
  const urlQ = values.q ?? "";
  const urlFrom = values.closed_from ?? "";
  const urlTo = values.closed_to ?? "";
  const [text, setText] = useState(urlQ);
  const [from, setFrom] = useState(urlFrom);
  const [to, setTo] = useState(urlTo);
  const [synced, setSynced] = useState({ q: urlQ, from: urlFrom, to: urlTo });
  if (synced.q !== urlQ || synced.from !== urlFrom || synced.to !== urlTo) {
    // the URL holds the search trimmed: "Maria " written as "Maria" is not a change to undo
    if (synced.q !== urlQ && text.trim() !== urlQ) setText(urlQ);
    if (synced.from !== urlFrom) setFrom(urlFrom);
    if (synced.to !== urlTo) setTo(urlTo);
    setSynced({ q: urlQ, from: urlFrom, to: urlTo });
  }

  const onDate = (key: "closed_from" | "closed_to", value: string) => {
    (key === "closed_from" ? setFrom : setTo)(value);
    // a half-typed date is no date yet: only a whole day, or a cleared box, filters
    if (value === "" || isDayKey(value)) later({ [key]: value || undefined });
  };

  const hasFilters = DEAL_LIST_FILTER_KEYS.some((k) => searchParams.has(k));
  const selectClass = "h-9 w-auto min-w-32 text-[13px]";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
          <Input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              later({ q: e.target.value.trim() || undefined });
            }}
            placeholder="Search deal title or reference…"
            aria-label="Search deals"
            maxLength={200}
            className="h-9 pl-8 text-[13px]"
          />
        </div>

        <Select value={values.type ?? ALL} onValueChange={(v) => push({ type: v })}>
          <SelectTrigger className={selectClass} aria-label="Filter deals by type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {DEAL_TYPES.map((t) => (
              <SelectItem key={t} value={t} className="capitalize">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={values.status ?? ALL} onValueChange={(v) => push({ status: v })}>
          <SelectTrigger className={selectClass} aria-label="Filter deals by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any status</SelectItem>
            {DEAL_LIST_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={values.agent ?? ALL} onValueChange={(v) => push({ agent: v })}>
          <SelectTrigger className={selectClass} aria-label="Filter deals by agent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any agent</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.full_name}
              </SelectItem>
            ))}
            {/* a filtered agent who is no longer active still shows as chosen */}
            {values.agent && !agents.some((a) => a.id === values.agent) ? (
              <SelectItem value={values.agent}>Inactive or unknown agent</SelectItem>
            ) : null}
          </SelectContent>
        </Select>

        {hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (timer.current) clearTimeout(timer.current);
              pending.current = {};
              setText("");
              setFrom("");
              setTo("");
              router.replace(pathname);
            }}
            className="h-9 text-text-2"
          >
            <X className="size-4" /> Clear filters
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-64">
          <EntityPicker
            // a new chosen id (Back/Forward, Clear) remounts the picker with it
            key={`property-${values.property ?? "none"}`}
            name="property"
            kind="property"
            label="Property"
            initial={property}
            placeholder="Search reference or title…"
            emptyHint="Archived and withdrawn listings are not offered — search the deal title for their reference."
            onChange={(o) => push({ property: o?.id })}
          />
        </div>
        <div className="w-full sm:w-64">
          <EntityPicker
            key={`contact-${values.contact ?? "none"}`}
            name="contact"
            kind="contact"
            label="Buyer or seller"
            initial={contact}
            placeholder="Search name, phone, email…"
            onChange={(o) => push({ contact: o?.id })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="deals-closed-from">Closed from</Label>
          <Input
            id="deals-closed-from"
            type="date"
            value={from}
            onChange={(e) => onDate("closed_from", e.target.value)}
            className="h-9 w-40 text-[13px]"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="deals-closed-to">Closed to</Label>
          <Input
            id="deals-closed-to"
            type="date"
            value={to}
            onChange={(e) => onDate("closed_to", e.target.value)}
            className="h-9 w-40 text-[13px]"
          />
        </div>
      </div>
      {values.closed_from || values.closed_to ? (
        <p className="text-xs text-text-3">
          Closed dates are Cyprus days, both ends included. A date range lists won and lost deals only.
        </p>
      ) : null}
    </div>
  );
}
