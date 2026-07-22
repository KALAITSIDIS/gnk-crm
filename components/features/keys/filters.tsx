"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KEY_SCOPES } from "@/lib/validators/keys";

function labelize(v: string) {
  return v === "all" ? "All statuses" : v.replace(/_/g, " ");
}

/**
 * Key register filters (audit 2026-07-22, PERF-2).
 *
 * These were client-side `useState` over the whole fetched array. Once the
 * register is paginated that would only ever search the current page, so both
 * filters now live in the URL and are applied by the server query. Changing
 * either resets to page 1 — otherwise a narrower filter can strand you on a
 * page number that no longer exists.
 */
export function KeysFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlQuery = searchParams.get("q") ?? "";
  const [text, setText] = useState(urlQuery);

  // Keep the box in step with Back/Forward. Adjusted DURING RENDER (React's
  // sanctioned pattern for state that follows a prop) rather than in an
  // effect, which would re-render twice and trips react-hooks/set-state-in-effect.
  const [syncedQuery, setSyncedQuery] = useState(urlQuery);
  if (urlQuery !== syncedQuery) {
    setSyncedQuery(urlQuery);
    setText(urlQuery);
  }

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

  const push = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      params.delete("page"); // a changed filter always returns to page 1
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams],
  );

  const onText = (value: string) => {
    setText(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      push((p) => {
        const v = value.trim();
        if (v) p.set("q", v);
        else p.delete("q");
      });
    }, 300);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={searchParams.get("status") ?? "all"}
        onValueChange={(value) =>
          push((p) => {
            if (value === "all") p.delete("status");
            else p.set("status", value);
          })
        }
      >
        <SelectTrigger className="w-40" aria-label="Filter keys by status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {KEY_SCOPES.map((s) => (
            <SelectItem key={s} value={s} className="capitalize">
              {labelize(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        value={text}
        onChange={(e) => onText(e.target.value)}
        placeholder="Filter by code, property, holder…"
        aria-label="Search keys"
        className="w-64"
      />
    </div>
  );
}
