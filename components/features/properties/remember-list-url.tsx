"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { isPropertiesListPath, PROPERTIES_LIST_CONTEXT_KEY } from "@/lib/constants/list-context";

/**
 * Remember the list URL this tab settled on — view, page, sort and filters —
 * so a record page's "Properties" link can return to it (A03; the reading half
 * is the record page's back link). Per tab, in `sessionStorage`; only a value
 * `isPropertiesListPath` accepts is ever written.
 *
 * Storage can be absent or refuse (a private window, blocked site data, a
 * quota): the write is a convenience, so a refusal is swallowed and the back
 * link falls back to the bare list. Nothing here is read back on this page.
 */
export function rememberPropertiesListUrl(url: string): void {
  if (!isPropertiesListPath(url)) return;
  try {
    window.sessionStorage.setItem(PROPERTIES_LIST_CONTEXT_KEY, url);
  } catch {
    // storage unavailable: the back link uses the bare list
  }
}

/** The map page's writer; the list page's filter bar writes from its own settle effect. */
export function RememberPropertiesListUrl() {
  const pathname = usePathname();
  const query = useSearchParams().toString();
  useEffect(() => {
    rememberPropertiesListUrl(query ? `${pathname}?${query}` : pathname);
  }, [pathname, query]);
  return null;
}
