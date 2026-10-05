"use client";

import { useTransition } from "react";
import { LogOut } from "lucide-react";
import { logout } from "@/lib/actions/auth";
import { purgeOfflineCaches } from "@/components/features/shared/pwa";
import { Button } from "@/components/ui/button";

/**
 * Sign out, and take the offline cache with you (IMPROVEMENTS B8).
 *
 * The current worker keeps no page (T-sw-no-private-cache, 2026-10-05). The v1
 * worker cached whole rendered pages, and a device still running it until its
 * next update could otherwise let the next person page back through the
 * previous user's KYC and client data with no session at all. So the purge
 * runs BEFORE the sign-out action, and is awaited rather than fired and
 * forgotten — losing that race would leave exactly the data behind that
 * signing out is supposed to remove.
 */
export function LogoutButton() {
  const [pending, start] = useTransition();

  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      title="Log out"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await purgeOfflineCaches();
          await logout();
        })
      }
    >
      <LogOut className="size-4" />
    </Button>
  );
}
