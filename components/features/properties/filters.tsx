"use client";

import { useCallback, useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowDownUp, LayoutGrid, Search, TableProperties, X } from "lucide-react";
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
  clearedPropertiesQuery,
  FILTER_ALL,
  nextPropertiesQuery,
  ownWriteTracker,
  parsePropertyFilters,
  searchParamsRecord,
} from "@/lib/queries/properties-list";
import {
  MANDATE_FILTERS,
  MAX_BEDS_FILTER,
  PROPERTY_FILTER_KEYS,
  PROPERTY_KINDS,
  PROPERTY_SCOPES,
  PROPERTY_SORTS,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  TRANSACTION_TYPES,
  VISIBILITY_LEVELS,
  type PropertySort,
} from "@/lib/validators/properties";
import { rememberPropertiesListUrl } from "./remember-list-url";

export interface DistrictOption {
  id: string;
  name: string;
}
export interface AreaOption {
  id: string;
  districtId: string;
  name: string;
}

const ALL = FILTER_ALL;

/** The single-kind options; the default and "All kinds" are written out below. */
const KIND_LABEL: Record<(typeof PROPERTY_KINDS)[number], string> = {
  standalone: "Standalone listings",
  project: "Projects",
  phase: "Phases",
  unit: "Units only",
};

/** The sorts in words. Price names the price it orders by (see `propertySortColumn`). */
function sortLabel(sort: PropertySort, rent: boolean): string {
  const price = rent ? "Rent" : "Asking price";
  switch (sort) {
    case "newest":
      return "Newest first";
    case "updated":
      return "Recently updated";
    case "price_asc":
      return `${price}: low to high`;
    case "price_desc":
      return `${price}: high to low`;
    case "plot_asc":
      return "Plot: smallest first";
    case "plot_desc":
      return "Plot: largest first";
    case "score_asc":
      return "Quality score: lowest first";
    case "score_desc":
      return "Quality score: highest first";
    case "reference":
      return "Reference A–Z";
    case "reference_desc":
      return "Reference Z–A";
  }
}

type NumberKey = "beds" | "price_min" | "price_max" | "plot_min" | "plot_max" | "density_min";

interface NumberFilter {
  key: NumberKey;
  /** the accessible name — a placeholder is not one */
  label: string;
  placeholder: string;
  width: string;
  max?: number;
  step: number | "any";
  /** the land bounds point at the note that says what an unknown value does */
  land?: boolean;
}

/** Free numbers: committed on blur and on Enter, never per keystroke. */
const NUMBER_FILTERS: readonly NumberFilter[] = [
  { key: "beds", label: "Bedrooms at least", placeholder: "Beds ≥", width: "w-20", max: MAX_BEDS_FILTER, step: 1 },
  { key: "price_min", label: "Price from (€)", placeholder: "€ min", width: "w-24", step: "any" },
  { key: "price_max", label: "Price up to (€)", placeholder: "€ max", width: "w-24", step: "any" },
];

/** Land (A03): the plot area and building density the land panel records. */
const LAND_FILTERS: readonly NumberFilter[] = [
  { key: "plot_min", label: "Plot area from (m²)", placeholder: "Plot m² ≥", width: "w-28", step: "any", land: true },
  { key: "plot_max", label: "Plot area up to (m²)", placeholder: "Plot m² ≤", width: "w-28", step: "any", land: true },
  {
    key: "density_min",
    label: "Building density at least (%)",
    placeholder: "Density % ≥",
    width: "w-28",
    step: "any",
    land: true,
  },
];

const EVERY_NUMBER = [...NUMBER_FILTERS, ...LAND_FILTERS];

const LAND_NOTE_ID = "properties-land-filter-note";

const numberText = (value: number | undefined) => (value === undefined ? "" : String(value));

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * The properties list's filter bar. The URL is the state: every control
 * writes a parameter, and the page, the map and the CSV export read the same
 * ones through `parsePropertyFilters`.
 *
 * WHY THE REFS (A03). A navigation is a transition: until it commits, the URL
 * this component renders is the OLD one. Building each change from it lost
 * the change still in flight — pick a district and then a type before the
 * first answer, and the district was gone; a search fired 300 ms after typing
 * put back a select changed in that window; Clear followed by the pending
 * search brought the search back. So every change is composed from `latest`,
 * the newest URL this bar has asked for, and `ownWriteTracker` tells this
 * bar's own navigations landing apart from anyone else's (Back, a sortable
 * header, "Show all kinds", a page link), which become the new base and
 * re-sync the free-text inputs. The selects show the URL being asked for at
 * once (`useOptimistic`), not the old one until the answer.
 *
 * `router.replace`, not push: the filters refine one list, so Back leaves the
 * list rather than stepping back through every keystroke — and the URL you
 * come back to still holds them.
 */
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
  const urlQuery = searchParams.toString();

  const [isPending, startTransition] = useTransition();
  // the URL the controls show: the one being asked for, while it is in flight
  const [shownQuery, setShownQuery] = useOptimistic(urlQuery);
  const shownParams = new URLSearchParams(shownQuery);
  // what the server applies to it — a value it does not read shows the default
  const shown = parsePropertyFilters(searchParamsRecord(shownParams));

  const [tracker] = useState(ownWriteTracker);
  const latest = useRef(urlQuery);
  const settled = useRef(urlQuery);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchBox = useRef<HTMLInputElement | null>(null);
  const numberBoxes = useRef<Partial<Record<NumberKey, HTMLInputElement | null>>>({});
  // text typed and not yet sent: Clear is offered for it too
  const [searchDraft, setSearchDraft] = useState(false);

  const navigate = useCallback(
    (query: string) => {
      if (query === latest.current) return;
      latest.current = query;
      tracker.wrote(query);
      startTransition(() => {
        setShownQuery(query);
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [router, pathname, tracker, setShownQuery],
  );

  const setParams = useCallback(
    (updates: Record<string, string | undefined>, opts?: { keepPage?: boolean }) =>
      navigate(nextPropertiesQuery(latest.current, updates, opts)),
    [navigate],
  );

  // A URL settled: remember it for the record pages' "Properties" link, and
  // adopt it as the new base when somebody else put it there.
  useEffect(() => {
    rememberPropertiesListUrl(urlQuery ? `${pathname}?${urlQuery}` : pathname);
    if (urlQuery === settled.current) return;
    settled.current = urlQuery;
    if (tracker.settled(urlQuery)) return; // our own write landed; `latest` is already at or past it
    latest.current = urlQuery;
    const params = new URLSearchParams(urlQuery);
    const now = parsePropertyFilters(searchParamsRecord(params));
    // A search still being typed keeps its text: its debounce applies it on
    // top of this URL when it fires.
    if (!debounce.current && searchBox.current) searchBox.current.value = params.get("q") ?? "";
    for (const { key } of EVERY_NUMBER) {
      const box = numberBoxes.current[key];
      if (box) box.value = numberText(now[key]);
    }
  }, [urlQuery, pathname, tracker]);

  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

  const commitSearch = useCallback(
    (value: string) => {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = null;
      setSearchDraft(false);
      setParams({ q: value.trim() || undefined });
    },
    [setParams],
  );

  const onSearchChange = (value: string) => {
    setSearchDraft(true);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => commitSearch(value), 300);
  };

  /** A number as the server will read it: the box shows that, and the URL holds that. */
  const commitNumber = (key: NumberKey, raw: string) => {
    const text = numberText(parsePropertyFilters({ [key]: raw.trim() })[key]);
    const box = numberBoxes.current[key];
    if (box && box.value !== text) box.value = text;
    setParams({ [key]: text || undefined });
  };

  const clear = () => {
    // the pending search first, or it lands after Clear and brings itself back
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = null;
    setSearchDraft(false);
    if (searchBox.current) searchBox.current.value = "";
    for (const box of Object.values(numberBoxes.current)) if (box) box.value = "";
    // view and sort are how the list is shown, not filters — kept
    navigate(clearedPropertiesQuery(latest.current));
  };

  const districtAreas = areas.filter((a) => a.districtId === shown.district);
  const rawView = shownParams.get("view");
  // null is AUTO — cards on a phone, the table above it — so neither toggle
  // is lit until the person chooses; an explicit choice is kept everywhere.
  const view = rawView === "cards" || rawView === "table" ? rawView : null;
  const hasFilters = PROPERTY_FILTER_KEYS.some((k) => shownParams.has(k)) || searchDraft;
  const landBound =
    shown.plot_min !== undefined || shown.plot_max !== undefined || shown.density_min !== undefined;

  const selectClass = "h-9 w-auto min-w-28 text-[13px]";

  const numberInput = (f: NumberFilter) => (
    <Input
      key={f.key}
      ref={(el) => {
        numberBoxes.current[f.key] = el;
      }}
      type="number"
      inputMode="decimal"
      min={0}
      max={f.max}
      step={f.step}
      aria-label={f.label}
      aria-describedby={f.land ? LAND_NOTE_ID : undefined}
      placeholder={f.placeholder}
      defaultValue={numberText(shown[f.key])}
      onBlur={(e) => commitNumber(f.key, e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitNumber(f.key, e.currentTarget.value);
      }}
      className={`h-9 ${f.width} text-[13px]`}
    />
  );

  return (
    <div className="flex flex-col gap-2" aria-busy={isPending}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
          <Input
            ref={searchBox}
            type="search"
            defaultValue={searchParams.get("q") ?? ""}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitSearch(e.currentTarget.value);
            }}
            aria-label="Search properties by reference, title or address"
            placeholder="Search reference, title, address…"
            className="h-9 pl-8 text-[13px]"
          />
        </div>

        <Select value={shown.district ?? ALL} onValueChange={(v) => setParams({ district: v, area: undefined })}>
          <SelectTrigger className={selectClass} aria-label="District">
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
          value={shown.area ?? ALL}
          onValueChange={(v) => setParams({ area: v })}
          disabled={shown.district === undefined}
        >
          <SelectTrigger className={selectClass} aria-label="Area">
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

        <Select value={shown.type ?? ALL} onValueChange={(v) => setParams({ type: v })}>
          <SelectTrigger className={selectClass} aria-label="Property type">
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

        <Select value={shown.transaction ?? ALL} onValueChange={(v) => setParams({ transaction: v })}>
          <SelectTrigger className={selectClass} aria-label="Transaction">
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

        <Select value={shown.status ?? ALL} onValueChange={(v) => setParams({ status: v })}>
          <SelectTrigger className={selectClass} aria-label="Status">
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

        <Select value={shown.visibility ?? ALL} onValueChange={(v) => setParams({ visibility: v })}>
          <SelectTrigger className={selectClass} aria-label="Visibility">
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

        {/* Units are hidden unless asked for (audit finding 3) — one 60-unit
            project is 2.5 pages of the default list. The default option SAYS SO
            — and the list header counts the units it leaves out — rather than
            reading "All kinds": a default that silently removes rows is a trap,
            one the user can see and change is a choice. "All kinds" is its own
            option (F04), units included. ALL is the default (no parameter);
            "all" is a real value that travels in the URL. A value the server
            does not read shows the default, which is what the server applies. */}
        <Select value={shown.kind ?? ALL} onValueChange={(v) => setParams({ kind: v })}>
          <SelectTrigger className={selectClass} aria-label="Kind">
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Listings &amp; developments (no units)</SelectItem>
            <SelectItem value="all">All kinds</SelectItem>
            {PROPERTY_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={shown.mandate ?? ALL} onValueChange={(v) => setParams({ mandate: v })}>
          <SelectTrigger className={selectClass} aria-label="Mandate">
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

        {NUMBER_FILTERS.map(numberInput)}

        {/* Land & plot (A03): "Paphos, plots of 1,500–6,000 m², density 90%
            or more" as filters — on the list, the map and the export alike,
            which share the one predicate builder. */}
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">Land and plot</legend>
          {LAND_FILTERS.map(numberInput)}
        </fieldset>

        <Select
          value={shown.scope}
          onValueChange={(v) => setParams({ scope: v === "active" ? undefined : v })}
        >
          <SelectTrigger className={selectClass} aria-label="Active or archived">
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
          <Button variant="ghost" size="sm" onClick={clear} className="h-9 text-text-2">
            <X className="size-4" /> Clear
          </Button>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {/* The sort travels in the URL like a filter but Clear keeps it; the
              table's headers set it too. */}
          <Select value={shown.sort} onValueChange={(v) => setParams({ sort: v })}>
            <SelectTrigger className={selectClass} aria-label="Sort">
              <ArrowDownUp className="size-3.5 text-text-3" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROPERTY_SORTS.map((s) => (
                <SelectItem key={s} value={s}>
                  {sortLabel(s, shown.transaction === "rent")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* A08: the two toggles are one named group and each says whether it
              is the layout chosen. Under the automatic layout neither is
              pressed: nothing has been chosen yet (see `view` above). */}
          <div role="group" aria-label="Layout" className="flex items-center rounded-lg border border-border p-0.5">
            <Button
              variant={view === "table" ? "secondary" : "ghost"}
              size="icon"
              className="size-8"
              // the same rows shown another way: the page is kept
              onClick={() => setParams({ view: "table" }, { keepPage: true })}
              title="Table view"
              aria-label="Table view"
              aria-pressed={view === "table"}
            >
              <TableProperties className="size-4" />
            </Button>
            <Button
              variant={view === "cards" ? "secondary" : "ghost"}
              size="icon"
              className="size-8"
              onClick={() => setParams({ view: "cards" }, { keepPage: true })}
              title="Card view"
              aria-label="Card view"
              aria-pressed={view === "cards"}
            >
              <LayoutGrid className="size-4" />
            </Button>
          </div>
        </div>
      </div>
      <p id={LAND_NOTE_ID} className={landBound ? "text-xs text-text-3" : "sr-only"}>
        Plot and density bounds match only listings with that figure recorded — a listing with no
        plot area or density is left out, not counted as zero.
      </p>
    </div>
  );
}
