"use client";

import { useActionState, useEffect, useRef } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import { changePassword, type ChangePasswordState } from "@/lib/actions/account";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: ChangePasswordState = { error: null, savedAt: null };

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(changePassword, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  // clear the fields on success — a password lingering in a form is a shoulder
  // surf away from being read, and "did it save?" deserves a real answer
  useEffect(() => {
    if (state.savedAt) {
      toast.success("Password changed");
      formRef.current?.reset();
    }
  }, [state.savedAt]);

  return (
    <div className="rounded-[10px] border border-border bg-surface p-5">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-text-2" />
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-text-1">Change password</h2>
          <p className="max-w-xl text-sm text-text-2">
            Use at least 10 characters. If you still have the password you were handed at
            invite time, replace it now — whoever invited you has seen it.
          </p>
        </div>
      </div>

      <form ref={formRef} action={formAction} className="mt-4 flex max-w-sm flex-col gap-3 border-t border-border pt-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            name="new_password"
            type="password"
            autoComplete="new-password"
            required
            minLength={10}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirm-password">Repeat it</Label>
          <Input
            id="confirm-password"
            name="confirm_password"
            type="password"
            autoComplete="new-password"
            required
          />
        </div>
        {state.error ? (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        ) : null}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Changing…" : "Change password"}
          </Button>
        </div>
      </form>
    </div>
  );
}
