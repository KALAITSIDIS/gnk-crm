"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { updatePropertySection, type UpdateSectionState } from "@/lib/actions/properties";
import { Button } from "@/components/ui/button";

const initialState: UpdateSectionState = { error: null, savedAt: null };

/**
 * Wraps one tab's fields in a form bound to updatePropertySection.
 * Children render the inputs; this supplies hidden ids, submit, and the
 * "Saved" toast (doc 06 interaction rules).
 */
export function SectionForm({
  propertyId,
  section,
  children,
}: {
  propertyId: string;
  section: "details" | "legal" | "marketing";
  children: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(updatePropertySection, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Saved");
    }
  }, [state.savedAt]);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="property_id" value={propertyId} />
      <input type="hidden" name="section" value={section} />
      {children}
      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
