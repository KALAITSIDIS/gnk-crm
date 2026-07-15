"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Building2,
  Calculator,
  CalendarDays,
  FileText,
  Inbox,
  KeyRound,
  LayoutDashboard,
  ListTodo,
  Settings,
  SquareKanban,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { href: "/dashboard", key: "dashboard", icon: LayoutDashboard },
  { href: "/leads", key: "leads", icon: Inbox },
  { href: "/pipeline", key: "pipeline", icon: SquareKanban },
  { href: "/properties", key: "properties", icon: Building2 },
  { href: "/contacts", key: "contacts", icon: Users },
  { href: "/viewings", key: "viewings", icon: CalendarDays },
  { href: "/tasks", key: "tasks", icon: ListTodo },
  { href: "/keys", key: "keys", icon: KeyRound },
  { href: "/reports", key: "reports", icon: FileText },
  { href: "/calculators", key: "calculators", icon: Calculator },
  { href: "/settings", key: "settings", icon: Settings },
] as const;

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const t = useTranslations("nav");

  return (
    <nav className="flex flex-col gap-0.5 px-3">
      {items.map(({ href, key, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-white/70 transition-colors hover:bg-brand-900 hover:text-white",
              active && "bg-brand-900 text-white",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{t(key)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
