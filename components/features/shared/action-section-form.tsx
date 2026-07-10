"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export type SectionActionState = { error: string | null; savedAt: number | null };

const initialState: SectionActionState = { error: null, savedAt: null };

/**
 * Generic evented-save form wrapper: hidden entity/section fields, submit
 * button, error line, "Saved" toast (doc 06). Used by property and contact
 * detail tabs alike.
 */
export function ActionSectionForm({
  action,
  hidden,
  children,
  submitLabel = "Save",
}: {
  action: (prev: SectionActionState, formData: FormData) => Promise<SectionActionState>;
  hidden: Record<string, string>;
  children: React.ReactNode;
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Saved");
    }
  }, [state.savedAt]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
