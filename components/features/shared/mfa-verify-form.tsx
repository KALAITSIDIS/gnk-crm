"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { logout } from "@/lib/actions/auth";
import { verifyMfaLogin, type MfaActionState } from "@/lib/actions/mfa";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: MfaActionState = { error: null, savedAt: null };

export function MfaVerifyForm() {
  const [state, formAction, pending] = useActionState(verifyMfaLogin, initialState);
  const router = useRouter();

  useEffect(() => {
    if (!state.savedAt) return;
    // The session is aal2 now; refresh so the proxy re-evaluates and lets us in.
    router.replace("/dashboard");
    router.refresh();
  }, [state.savedAt, router]);

  return (
    // sibling forms, never nested — a <form> inside a <form> is invalid HTML
    // and the inner submit would be swallowed
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mfa-code">6-digit code</Label>
          <Input
            id="mfa-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            placeholder="000000"
            autoFocus
            className="tracking-[0.4em]"
          />
          <p className="text-xs text-text-3">From your authenticator app.</p>
        </div>

        {state.error ? (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        ) : null}

        <Button type="submit" disabled={pending}>
          {pending ? "Checking…" : "Verify"}
        </Button>
      </form>

      <form action={logout}>
        <button
          type="submit"
          className="text-xs font-medium text-text-3 hover:text-text-1 hover:underline"
        >
          Sign out instead
        </button>
      </form>
    </div>
  );
}
