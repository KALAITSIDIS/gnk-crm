"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The settings sections. "Overview" (A07) is the activation-readiness page at
 * /settings itself — active on that exact path only, since every other
 * section lives under it. The current section is announced with
 * `aria-current="page"`, not by its colour alone.
 */
export const SETTINGS_SECTIONS = [
  { href: "/settings", label: "Overview" },
  { href: "/settings/organization", label: "Organization" },
  { href: "/settings/users", label: "Users" },
  { href: "/settings/stages", label: "Deal stages" },
  { href: "/settings/locations", label: "Locations" },
  { href: "/settings/nudges", label: "Nudges" },
  { href: "/settings/lead-routing", label: "Lead routing" },
  { href: "/settings/lead-escalation", label: "Lead escalation" },
  { href: "/settings/cyprus-config", label: "Cyprus config" },
  { href: "/settings/portals", label: "Portals" },
  { href: "/settings/retention", label: "Data retention" },
] as const;

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="flex flex-wrap gap-1 border-b border-border pb-2">
      {SETTINGS_SECTIONS.map((s) => {
        const active = pathname === s.href;
        return (
          <Link
            key={s.href}
            href={s.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active ? "bg-brand-100 text-brand-700" : "text-text-2 hover:bg-surface-2 hover:text-text-1",
            )}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
