"use client";

import Link from "next/link";
import { createContext, useContext, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Tabs } from "@/components/ui/tabs";
import { isPropertyTab, propertyTabHref, type PropertyTab } from "@/lib/services/property-tabs";

/**
 * The property page's Tabs root, kept in step with `?tab=`.
 *
 * Two reviews of 2026-10-18 found the same defect from two sides. A Portals
 * reason's "Fix" link (`?tab=media`, details, marketing) and the readiness
 * panel's "fix it here" links (F03) are on the page itself, and an
 * uncontrolled `<Tabs defaultValue>` reads `?tab=` once, at mount: a link on
 * the same page changed the URL and left the tab where it was.
 *
 * Here the URL is the state: the open tab is whatever `?tab=` names (when it
 * names a tab — lib/services/property-tabs.ts holds the one list), else the
 * server's reading of it (`initialTab`, so server and client agree on the
 * first paint). Clicking a tab writes it back with `history.replaceState` —
 * Next keeps `useSearchParams` in step with that, and no server round trip
 * re-renders the page for a tab click. Other query parameters
 * (`?recorded=failed`) are kept. A plain `<Link href="?tab=…">` on the page
 * (the Portals card) therefore moves the tab too; a `TabLink` (below) does it
 * without a navigation and moves focus.
 *
 * Anything may sit inside the root (it is a plain div): the summary strip and
 * the readiness panel do, above the strip, so their links share this state.
 */
const TabContext = createContext<((tab: PropertyTab) => void) | null>(null);

export function PropertyTabs({
  initialTab,
  children,
}: {
  /** the server's reading of `?tab=` at render (propertyTabFrom) */
  initialTab: PropertyTab;
  children: ReactNode;
}) {
  // Both hooks answer null outside the app router (a unit render, a page
  // rendered by hand): the tab is then the server's reading, and a click
  // writes against the live location.
  const pathname = usePathname();
  const params = useSearchParams();
  const fromUrl = params?.get("tab") ?? null;
  const value: PropertyTab = isPropertyTab(fromUrl) ? fromUrl : initialTab;

  const select = (next: PropertyTab) => {
    const query = new URLSearchParams(window.location.search);
    query.set("tab", next);
    // `null`, never `window.history.state`: Next's patched replaceState
    // passes a call whose data carries its own `__NA` marker straight
    // through WITHOUT syncing useSearchParams — the tab would not move.
    // Given null, it copies its state in itself and syncs.
    window.history.replaceState(null, "", `${pathname ?? window.location.pathname}?${query.toString()}`);
  };

  return (
    <TabContext.Provider value={select}>
      <Tabs
        value={value}
        onValueChange={(next) => {
          if (isPropertyTab(next)) select(next);
        }}
      >
        {children}
      </Tabs>
    </TabContext.Provider>
  );
}

/**
 * A link to one of this property's tabs. A real href (`?tab=`) — it opens in a
 * new tab, survives a reload and works before hydration — and, clicked in
 * place, it switches the tab and moves focus to its trigger, so a keyboard
 * reader lands where the fix is and the next Tab enters that panel.
 */
export function TabLink({
  propertyId,
  tab,
  title,
  className,
  children,
}: {
  propertyId: string;
  tab: PropertyTab;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const select = useContext(TabContext);
  return (
    <Link
      href={propertyTabHref(propertyId, tab)}
      title={title}
      className={className}
      onClick={(e) => {
        // outside PropertyTabs, or a modified click (new tab, new window):
        // the href does the work
        if (!select || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        select(tab);
        requestAnimationFrame(() => {
          const trigger = document.querySelector<HTMLElement>(`[data-property-tab="${tab}"]`);
          trigger?.scrollIntoView({ block: "nearest" });
          trigger?.focus();
        });
      }}
    >
      {children}
    </Link>
  );
}
