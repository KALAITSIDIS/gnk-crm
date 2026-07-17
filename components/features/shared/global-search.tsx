"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, CalendarPlus, Inbox, Plus, Search, User } from "lucide-react";
import { searchEntities, type EntityOption } from "@/lib/actions/entity-search";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * Topbar global search (doc 05): fuzzy properties + contacts behind ⌘K, with
 * the quick-add shortcuts. Reuses the searchEntities action (RLS org-scoped).
 */

interface Results {
  properties: EntityOption[];
  contacts: EntityOption[];
}

const EMPTY: Results = { properties: [], contacts: [] };

const QUICK_ADD = [
  { href: "/properties/new", label: "New property", icon: Building2 },
  { href: "/contacts/new", label: "New contact", icon: User },
  { href: "/leads", label: "Lead inbox", icon: Inbox },
  { href: "/viewings", label: "Viewings", icon: CalendarPlus },
] as const;

export function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results>(EMPTY);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  // single open/close path so closing always clears the query state
  const setOpenAndReset = useCallback((v: boolean) => {
    setOpen(v);
    if (!v) {
      if (debounce.current) clearTimeout(debounce.current);
      setQuery("");
      setResults(EMPTY);
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpenAndReset(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpenAndReset]);

  const onQueryChange = (value: string) => {
    setQuery(value);
    if (debounce.current) clearTimeout(debounce.current);
    if (value.trim().length < 2) {
      setResults(EMPTY);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounce.current = setTimeout(async () => {
      const mySeq = ++seq.current;
      const [properties, contacts] = await Promise.all([
        searchEntities("property", value),
        searchEntities("contact", value),
      ]);
      if (mySeq !== seq.current) return; // a newer query superseded this one
      setResults({ properties, contacts });
      setSearching(false);
    }, 250);
  };

  const go = (href: string) => {
    setOpenAndReset(false);
    router.push(href);
  };

  const first =
    results.properties.length > 0
      ? `/properties/${results.properties[0].id}`
      : results.contacts.length > 0
        ? `/contacts/${results.contacts[0].id}`
        : null;

  const hasResults = results.properties.length > 0 || results.contacts.length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpenAndReset}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="hidden h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-3 transition-colors hover:border-brand-500/40 hover:text-text-2 sm:flex"
        >
          <Search className="size-4" />
          <span>Search properties, contacts…</span>
          <kbd className="ml-auto rounded border border-border bg-surface px-1.5 text-xs">⌘K</kbd>
        </button>
      </DialogTrigger>
      <DialogContent className="top-24 max-w-lg translate-y-0 p-4">
        <DialogHeader className="sr-only">
          <DialogTitle>Global search</DialogTitle>
          <DialogDescription>Search properties and contacts, or jump to quick actions.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && first) go(first);
            }}
            placeholder="Search properties, contacts…"
            className="pl-8"
          />
        </div>

        {hasResults ? (
          <div className="flex max-h-80 flex-col gap-3 overflow-y-auto">
            {results.properties.length > 0 ? (
              <div>
                <p className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-text-3">
                  Properties
                </p>
                <ul className="flex flex-col">
                  {results.properties.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => go(`/properties/${p.id}`)}
                        className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <Building2 className="size-4 shrink-0 text-text-3" />
                          <span className="truncate font-medium text-text-1">{p.label}</span>
                        </span>
                        <span className="shrink-0 text-xs text-text-3">{p.sublabel}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {results.contacts.length > 0 ? (
              <div>
                <p className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-text-3">
                  Contacts
                </p>
                <ul className="flex flex-col">
                  {results.contacts.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => go(`/contacts/${c.id}`)}
                        className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <User className="size-4 shrink-0 text-text-3" />
                          <span className="truncate font-medium text-text-1">{c.label}</span>
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-text-3">
                          {c.sublabel}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : query.trim().length >= 2 && !searching ? (
          <p className="px-1 text-sm text-text-3">No matches.</p>
        ) : null}

        <div>
          <p className="px-1 pb-1 text-xs font-medium uppercase tracking-wide text-text-3">
            Quick add
          </p>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_ADD.map(({ href, label, icon: Icon }) => (
              <button
                key={href}
                type="button"
                onClick={() => go(href)}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-text-2 hover:bg-surface-2"
              >
                <Plus className="size-3.5 text-text-3" />
                <Icon className="size-4 text-text-3" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
