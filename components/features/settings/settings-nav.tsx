"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { href: "/settings/organization", label: "Organization" },
  { href: "/settings/users", label: "Users" },
  { href: "/settings/stages", label: "Deal stages" },
  { href: "/settings/locations", label: "Locations" },
  { href: "/settings/cyprus-config", label: "Cyprus config" },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap gap-1 border-b border-border pb-2">
      {SECTIONS.map((s) => (
        <Link
          key={s.href}
          href={s.href}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            pathname === s.href
              ? "bg-brand-100 text-brand-700"
              : "text-text-2 hover:bg-surface-2 hover:text-text-1",
          )}
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );
}
