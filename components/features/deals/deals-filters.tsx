"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
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
import { ANY as ALL, FilterUrlWriter, type FilterUpdates } from "./filter-url-writer";

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
  // Each write is built on the latest URL this bar wrote, not the one last
  // rendered, so a change still on its way is carried too (FilterUrlWriter).
  const writer = useRef(new FilterUrlWriter(searchParams.toString()));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const go = (qs: string | null) => {
    if (qs !== null) router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  const push = (updates: FilterUpdates) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    go(writer.current.write(updates));
  };

  const later = (update: FilterUpdates) => {
    writer.current.queue(update);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => push({}), 400);
  };

  // The typed boxes are uncontrolled: what is typed stays in the box while a
  // render is on its way. They follow the URL only after a navigation that is
  // not this bar's own write (Back/Forward, a link), and never over a change
  // still waiting to be written — so a write that lands mid-typing, of this
  // field or another, never rewrites what is being typed (F05 review). Run
  // before paint, so the writer knows the URL on screen before any timer fires.
  const qBox = useRef<HTMLInputElement>(null);
  const fromBox = useRef<HTMLInputElement>(null);
  const toBox = useRef<HTMLInputElement>(null);
  const rendered = searchParams.toString();
  const urlQ = values.q ?? "";
  const urlFrom = values.closed_from ?? "";
  const urlTo = values.closed_to ?? "";
  useLayoutEffect(() => {
    const boxes = { q: qBox, closed_from: fromBox, closed_to: toBox };
    const moves = writer.current.observe(
      rendered,
      { q: urlQ, closed_from: urlFrom, closed_to: urlTo },
      {
        q: qBox.current?.value ?? "",
        closed_from: fromBox.current?.value ?? "",
        closed_to: toBox.current?.value ?? "",
      },
    );
    for (const [key, value] of Object.entries(moves)) {
      const box = boxes[key as keyof typeof boxes].current;
      if (box) box.value = value;
    }
  }, [rendered, urlQ, urlFrom, urlTo]);

  const onDate = (key: "closed_from" | "closed_to", value: string) => {
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
            ref={qBox}
            defaultValue={urlQ}
            onChange={(e) => later({ q: e.target.value.trim() || undefined })}
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
              timer.current = null;
              for (const box of [qBox, fromBox, toBox]) if (box.current) box.current.value = "";
              go(writer.current.clear());
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
            ref={fromBox}
            type="date"
            defaultValue={urlFrom}
            onChange={(e) => onDate("closed_from", e.target.value)}
            className="h-9 w-40 text-[13px]"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="deals-closed-to">Closed to</Label>
          <Input
            id="deals-closed-to"
            ref={toBox}
            type="date"
            defaultValue={urlTo}
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
