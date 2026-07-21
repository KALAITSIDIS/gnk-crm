"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LEAD_STATUSES, LEAD_SCOPES } from "@/lib/validators/contacts";

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

const SCOPE_LABELS: Record<(typeof LEAD_SCOPES)[number], string> = {
  open: "Open",
  closed: "Closed",
  all: "All leads",
};

/**
 * Inbox scope. Leads are never deleted (doc 04), so without this the inbox
 * accumulates every converted/lost/spam lead forever.
 */
export function LeadsFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setStatus = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      // "open" is the default — keep it out of the URL
      if (value === "open") params.delete("status");
      else params.set("status", value);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams],
  );

  return (
    <Select value={searchParams.get("status") ?? "open"} onValueChange={setStatus}>
      <SelectTrigger className="h-9 w-auto min-w-32 text-[13px]" aria-label="Filter leads">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LEAD_SCOPES.map((s) => (
          <SelectItem key={s} value={s}>
            {SCOPE_LABELS[s]}
          </SelectItem>
        ))}
        <SelectSeparator />
        {LEAD_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {labelize(s)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
