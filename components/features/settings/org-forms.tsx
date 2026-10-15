"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  updateOrgName,
  uploadBranding,
  type SettingsActionState,
} from "@/lib/actions/settings";
import { BRANDING_MAX_BYTES, formatMegabytes } from "@/lib/constants/upload";
import { useUploadForm } from "@/components/features/shared/use-upload-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: SettingsActionState = {
  error: null,
  savedAt: null,
  tempPassword: null,
  invitedEmail: null,
  notice: null,
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

/** The branding PNG's cap as the form prints it ("2.0 MB") — the action's own. */
const BRANDING_LIMIT_TEXT = formatMegabytes(BRANDING_MAX_BYTES, "down");

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
  // refused before sending past the action's own 2 MB cap — a larger PNG used
  // to reach Vercel's ~4.5 MB 413 and the error boundary — and a lost answer
  // said, not thrown (T-upload-size-honest — use-upload-form.ts). The upload
  // overwrites one fixed path, so re-sending after an unknown outcome is safe.
  const upload = useUploadForm({
    action: uploadBranding,
    initialState,
    limit: BRANDING_MAX_BYTES,
    tooLargeAdvice: "Use a smaller PNG.",
    unconfirmedText: `Could not confirm whether the ${title.toLowerCase()} was saved — reload the page to see the current one.`,
    savedText: `${title} uploaded`,
  });

  return (
    <form onSubmit={upload.onSubmit} className="flex flex-col gap-2">
      <input type="hidden" name="kind" value={kind} />
      <Label htmlFor={`branding-${kind}`}>{title}</Label>
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
        <Input
          id={`branding-${kind}`}
          name="file"
          type="file"
          accept="image/png"
          required
          onChange={upload.onFileChange}
          className="max-w-64"
        />
        <Button type="submit" size="sm" disabled={upload.pending}>
          {upload.pending ? "Uploading…" : "Upload"}
        </Button>
      </div>
      <p className="text-xs text-text-3">
        {hint} Up to {BRANDING_LIMIT_TEXT}.
      </p>
      {upload.error ? (
        <p role="alert" className="text-sm text-danger">
          {upload.error}
        </p>
      ) : null}
    </form>
  );
}
