"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  updateOrgName,
  uploadBranding,
  type SettingsActionState,
} from "@/lib/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: SettingsActionState = {
  error: null,
  savedAt: null,
  tempPassword: null,
  invitedEmail: null,
};

function useSavedToast(state: SettingsActionState, message: string) {
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (state.savedAt && state.savedAt !== last.current) {
      last.current = state.savedAt;
      toast.success(message);
    }
  }, [state.savedAt, message]);
}

export function OrgNameForm({ name }: { name: string }) {
  const [state, formAction, pending] = useActionState(updateOrgName, initialState);
  useSavedToast(state, "Organization saved");

  return (
    <form action={formAction} className="flex max-w-md flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="org-name">Organization name</Label>
        <Input id="org-name" name="name" defaultValue={name} required />
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

export function BrandingUpload({
  kind,
  title,
  hint,
  currentUrl,
}: {
  kind: "logo" | "watermark";
  title: string;
  hint: string;
  currentUrl: string | null;
}) {
  const [state, formAction, pending] = useActionState(uploadBranding, initialState);
  useSavedToast(state, `${title} uploaded`);

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="kind" value={kind} />
      <Label>{title}</Label>
      {currentUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- storage URL, no next/image loader configured for it
        <img
          src={currentUrl}
          alt={`Current ${title.toLowerCase()}`}
          className="h-16 w-fit max-w-56 rounded border border-border bg-surface-2 object-contain p-1"
        />
      ) : (
        <p className="text-xs text-text-3">Not uploaded yet.</p>
      )}
      <div className="flex items-center gap-2">
        <Input name="file" type="file" accept="image/png" required className="max-w-64" />
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Uploading…" : "Upload"}
        </Button>
      </div>
      <p className="text-xs text-text-3">{hint}</p>
      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
