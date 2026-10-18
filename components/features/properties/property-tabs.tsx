"use client";

import Link from "next/link";
import { createContext, useContext, useState, type ReactNode } from "react";
import { Tabs } from "@/components/ui/tabs";
import { isPropertyTab, propertyTabHref, type PropertyTab } from "@/lib/services/property-tabs";

/**
 * The property page's Tabs root, holding which tab is open where a link
 * outside the tab strip can change it (F03).
 *
 * The page opened on `?tab=` through Radix's `defaultValue`, which is read
 * once: a link to `?tab=details` on the page itself changed the URL and left
 * the tab where it was — and when the URL already said `?tab=details` (the
 * reader had since clicked another tab) it changed nothing at all. The
 * readiness panel's "fix it here" links are on the page itself, so the state
 * lives here: the strip is controlled by it, a TabLink sets it directly, and
 * a navigation that brings a new `?tab=` (the worklist, the calculators)
 * still opens on that tab. The URL is not rewritten on a tab click.
 *
 * Anything may sit inside the root (it is a plain div): the readiness panel
 * does, above the strip, so its links share this state.
 */

const TabContext = createContext<((tab: PropertyTab) => void) | null>(null);

export function PropertyTabs({
  initialTab,
  children,
}: {
  initialTab: PropertyTab;
  children: ReactNode;
}) {
  const [tab, setTab] = useState<PropertyTab>(initialTab);
  // a navigation to this same page with a different `?tab=` re-renders this
  // with a new initialTab and the state kept: follow it (React's "adjust
  // state when a prop changes" pattern — during render, no effect)
  const [seen, setSeen] = useState<PropertyTab>(initialTab);
  if (seen !== initialTab) {
    setSeen(initialTab);
    setTab(initialTab);
  }
  return (
    <TabContext.Provider value={setTab}>
      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (isPropertyTab(v)) setTab(v);
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
