"use client";

import { useState, useTransition, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UPLOAD_REQUEST_BUDGET_BYTES, uploadSizeRefusal } from "@/lib/constants/upload";
import { submitUpload, type UploadActionState } from "@/lib/services/client-upload";

/** A toast the user must read even if the form that said it is gone. */
const UNTIL_DISMISSED = { duration: Infinity, closeButton: true } as const;

/**
 * Submits a form whose `file` field goes to a server action (documents ×3,
 * branding — T-upload-size-honest).
 *
 * NOT useActionState with the server action as the form `action`: a rejected
 * call (the platform's 413 page, a dropped connection — "An unexpected
 * response was received from the server") would be rethrown into the route's
 * error boundary. This is the house idiom of
 * components/features/deals/outcome-actions.tsx instead: onSubmit, a
 * transition, and every outcome said by the form —
 *
 * - over the limit: refused on the spot, nothing sent (also said the moment
 *   the file is chosen, through `onFileChange`);
 * - the server's refusal: inline, in its words;
 * - no usable answer: an UNKNOWN outcome — the upload may have committed —
 *   kept on screen until dismissed, and the page re-read so the list shows
 *   what is really there;
 * - saved: a toast, the form reset, `onSaved`.
 *
 * onSubmit, not a form `action`, also means React 19 does not reset the form
 * after a refusal: a typed title survives it.
 */
export function useUploadForm<S extends UploadActionState>({
  action,
  initialState,
  limit = UPLOAD_REQUEST_BUDGET_BYTES,
  tooLargeAdvice,
  unconfirmedText,
  savedText,
  onSaved,
}: {
  action: (prev: S, formData: FormData) => Promise<S>;
  initialState: S;
  /** a form with its own smaller cap (branding); never above the request budget */
  limit?: number;
  tooLargeAdvice: string;
  unconfirmedText: string;
  savedText: string;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  /** Said when the file is chosen, before the user even presses Upload. */
  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setError(uploadSizeRefusal(event.currentTarget.files?.[0] ?? null, limit, tooLargeAdvice));
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const formData = new FormData(form);
    // refused synchronously, so the button never flashes "Uploading…" for a
    // file that is not going anywhere (submitUpload checks again: its own
    // contract is that nothing over the limit is ever sent)
    const refusal = uploadSizeRefusal(formData.get("file"), limit, tooLargeAdvice);
    if (refusal) {
      setError(refusal);
      return;
    }
    setError(null);
    startTransition(async () => {
      const outcome = await submitUpload(formData, action, {
        initialState,
        limit,
        tooLargeAdvice,
        unconfirmedText,
      });
      switch (outcome.kind) {
        case "saved":
          toast.success(savedText);
          form.reset();
          onSaved?.();
          return;
        case "unconfirmed":
          setError(outcome.text);
          toast.error(outcome.text, UNTIL_DISMISSED);
          router.refresh();
          return;
        case "refused":
        case "error":
          setError(outcome.text);
          return;
      }
    });
  };

  return { onSubmit, onFileChange, pending, error, clearError: () => setError(null) };
}
