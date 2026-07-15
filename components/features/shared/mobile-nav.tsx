"use client";

import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { SidebarNav } from "@/components/features/shared/sidebar-nav";
import { Button } from "@/components/ui/button";

/**
 * Mobile navigation. The desktop `<aside>` is `hidden md:flex`, so below the
 * md breakpoint there is no way to navigate — this hamburger opens the same
 * nav in a slide-in drawer. Plain React state (no Radix) to sidestep the
 * app's known hydration/Radix quirks on this shell.
 */
export function MobileNav({ appName }: { appName: string }) {
  const [open, setOpen] = useState(false);

  // lock background scroll while the drawer is open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="md:hidden">
      <Button
        variant="ghost"
        size="icon"
        className="-ml-2"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        aria-expanded={open}
      >
        <Menu className="size-5" />
      </Button>

      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-[248px] max-w-[85vw] flex-col bg-brand-950 shadow-xl">
            <div className="flex h-14 items-center justify-between pl-6 pr-3">
              <span className="text-sm font-semibold tracking-wide text-white">{appName}</span>
              <Button
                variant="ghost"
                size="icon"
                className="text-white/70 hover:bg-brand-900 hover:text-white"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
              >
                <X className="size-5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-4">
              <SidebarNav onNavigate={() => setOpen(false)} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
