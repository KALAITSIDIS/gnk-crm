"use client";

import { useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { searchEntities, type EntityKind, type EntityOption } from "@/lib/actions/entity-search";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * EntityPicker (doc 06): async combobox for contact / property / agent.
 * Search by name/phone/reference; shows initials bubble + secondary line.
 * The hidden input carries the selected id ("" = unset) so it drops straight
 * into ActionSectionForm posts; clearing removes the link on save.
 */
export function EntityPicker({
  name,
  kind,
  label,
  initial = null,
  placeholder = "Search…",
  contactTypes,
  hint,
  emptyHint,
  onChange,
}: {
  name: string;
  kind: EntityKind;
  label: string;
  initial?: EntityOption | null;
  placeholder?: string;
  /** Narrows a `contact` search to these contact_types (audit finding 12). */
  contactTypes?: readonly string[];
  /** Small line under the field — say what the search is narrowed to. */
  hint?: string;
  /** Shown inside the "no matches" row — point at the way out (e.g. create). */
  emptyHint?: string;
  /** Fires when the selection changes (choose or clear) — for dependent UI. */
  onChange?: (option: EntityOption | null) => void;
}) {
  const [selected, setSelected] = useState<EntityOption | null>(initial);
  const choose = (option: EntityOption | null) => {
    setSelected(option);
    onChange?.(option);
  };
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<EntityOption[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Newest query wins: a slow earlier search must not overwrite a later one. */
  const seq = useRef(0);
  const inputId = `picker-${name}`;

  const onQueryChange = (value: string) => {
    setQuery(value);
    setOpen(true);
    if (debounce.current) clearTimeout(debounce.current);
    if (!value.trim()) {
      setOptions([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const mine = ++seq.current;
    debounce.current = setTimeout(async () => {
      const found = await searchEntities(kind, value, contactTypes);
      if (mine !== seq.current) return;
      setOptions(found);
      setSearching(false);
    }, 300);
  };

  const initials = (text: string) =>
    text
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase();

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <input type="hidden" name={name} value={selected?.id ?? ""} />
      {selected ? (
        <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-surface px-2.5">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-semibold text-brand-700">
            {initials(selected.label)}
          </span>
          <span className="truncate text-sm font-medium text-text-1">{selected.label}</span>
          {selected.sublabel ? (
            <span className="truncate text-xs text-text-3">{selected.sublabel}</span>
          ) : null}
          <button
            type="button"
            onClick={() => {
              choose(null);
              setQuery("");
              setOptions([]);
            }}
            className="ml-auto rounded p-0.5 text-text-3 hover:bg-surface-2 hover:text-text-1"
            aria-label={`Clear ${label}`}
          >
            <X className="size-4" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
          <Input
            id={inputId}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onFocus={() => query && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder={placeholder}
            autoComplete="off"
            className="pl-8"
          />
          {/* A dropdown that renders ONLY on hits is indistinguishable from a
              broken search — the agent cannot tell "still looking", "nothing
              here" and "this field is dead" apart. All three states show
              (found by the 2026-09-01 browser-agent session). */}
          {open && query.trim() ? (
            <ul className="absolute z-20 mt-1 max-h-48 w-full divide-y divide-border overflow-y-auto rounded-lg border border-border bg-surface shadow-md">
              {searching ? (
                <li className="px-3 py-2 text-sm text-text-3">Searching…</li>
              ) : options.length === 0 ? (
                <li className="px-3 py-2 text-sm text-text-3">
                  No matches for “{query.trim()}”.
                  {emptyHint ? <span className="block text-xs">{emptyHint}</span> : null}
                </li>
              ) : (
                options.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      choose(o);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2"
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-[10px] font-semibold text-brand-700">
                      {initials(o.label)}
                    </span>
                    <span className="truncate font-medium text-text-1">{o.label}</span>
                    {o.sublabel ? (
                      <span className="ml-auto shrink-0 text-xs text-text-3">{o.sublabel}</span>
                    ) : null}
                  </button>
                </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
      )}
      {hint ? <p className="text-xs text-text-3">{hint}</p> : null}
    </div>
  );
}
