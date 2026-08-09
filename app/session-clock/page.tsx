import { Clock } from "lucide-react";
import { logout } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";

/**
 * Dynamic so the CSP nonce can be stamped on this page (C1).
 *
 * A prerendered page is rendered at BUILD time, before any request nonce
 * exists, so its script tags carry none — while proxy.ts still mints a fresh
 * nonce into the header per request. See lib/services/csp.ts for why that
 * mismatch blocks EVERY script once the policy is enforced.
 */
export const dynamic = "force-dynamic";

/**
 * Where a `PGRST303` token lands (lib/supabase/clock-skew.ts).
 *
 * Deliberately OUTSIDE the `(app)` group. That layout builds a Supabase client
 * of its own, so a page placed inside it would re-enter the same failing session
 * and bounce here again — the loop this whole route exists to avoid. The root
 * layout does no data access, so this renders with nothing that can fail.
 *
 * It does not sign the user out on arrival. Doing that would need a GET endpoint
 * with a side effect, which is a logout-CSRF surface the app does not otherwise
 * have — `logout()` is a server action, so the button below is a POST that Next
 * protects. The user is one click from the fix and nobody can trigger it for
 * them.
 *
 * English only, matching `app/(app)/error.tsx`. Error surfaces in this app are
 * not translated.
 */
export default function SessionClockPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-2 p-4">
      <div className="w-full max-w-md rounded-[10px] border border-border bg-surface p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-full bg-surface-2">
          <Clock className="size-5 text-text-2" aria-hidden />
        </div>

        <h1 className="text-base font-semibold text-text-1">Your session is out of step</h1>

        <p className="mt-2 text-sm text-text-2">
          This device&apos;s clock is far enough ahead of the server that the database is
          refusing your sign-in token. It is not a problem with your account or your data.
        </p>

        <p className="mt-3 text-sm text-text-2">
          Reloading will not clear it — the same token is sent again. Signing in gets you a
          fresh one.
        </p>

        <form action={logout} className="mt-6">
          <Button type="submit" className="w-full">
            Sign in again
          </Button>
        </form>

        <p className="mt-4 text-xs text-text-3">
          If it keeps happening, this machine&apos;s clock needs correcting rather than the app.
        </p>
      </div>
    </div>
  );
}
