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
}: {
  name: string;
  kind: EntityKind;
  label: string;
  initial?: EntityOption | null;
  placeholder?: string;
}) {
  const [selected, setSelected] = useState<EntityOption | null>(initial);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<EntityOption[]>([]);
  const [open, setOpen] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputId = `picker-${name}`;

  const onQueryChange = (value: string) => {
    setQuery(value);
    setOpen(true);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setOptions(await searchEntities(kind, value));
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
              setSelected(null);
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
          {open && options.length > 0 ? (
            <ul className="absolute z-20 mt-1 max-h-48 w-full divide-y divide-border overflow-y-auto rounded-lg border border-border bg-surface shadow-md">
              {options.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSelected(o);
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
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}
