"use client";

import type { ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Tabs } from "@/components/ui/tabs";

/**
 * The property page's tab strip, kept in step with `?tab=` (portal
 * integrations audit 2026-10-18, review).
 *
 * A Portals reason's "Fix" link is `?tab=media` (or details, marketing). An
 * uncontrolled `<Tabs defaultValue>` reads that once, at mount, so a Fix link
 * clicked from the Marketing tab of the SAME page changed the URL and left
 * the tab where it was. Here the URL is the state: the open tab is whatever
 * `?tab=` names (when it names one of `tabs`), and clicking a tab writes it
 * back with `history.replaceState` — Next keeps `useSearchParams` in step with
 * that, and no server round trip re-renders the page for a tab click.
 * Other query parameters (`?recorded=failed`) are kept.
 */
export function PropertyTabs({
  tabs,
  fallback,
  children,
}: {
  tabs: readonly string[];
  /** the server's reading of `?tab=` at render, so server and client agree on the first paint */
  fallback: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const fromUrl = params.get("tab");
  const value = fromUrl && tabs.includes(fromUrl) ? fromUrl : fallback;

  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        const query = new URLSearchParams(window.location.search);
        query.set("tab", next);
        // `null`, never `window.history.state`: Next's patched replaceState
        // passes a call whose data carries its own `__NA` marker straight
        // through WITHOUT syncing useSearchParams — the tab would not move.
        // Given null, it copies its state in itself and syncs.
        window.history.replaceState(null, "", `${pathname}?${query.toString()}`);
      }}
    >
      {children}
    </Tabs>
  );
}
