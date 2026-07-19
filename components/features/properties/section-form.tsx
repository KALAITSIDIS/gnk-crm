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
  readOnly = false,
  children,
}: {
  propertyId: string;
  section: "details" | "legal" | "marketing";
  /** true when the viewer's role can't update this property (RLS would no-op) */
  readOnly?: boolean;
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
      {/* min-w-0 overrides the fieldset UA default min-inline-size:min-content,
          which otherwise stops it shrinking and lets a long unbroken value in a
          field-sizing-content textarea drag the whole form past the viewport */}
      <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-4">
        {children}
      </fieldset>
      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {readOnly ? (
        <p className="text-xs text-text-3">
          Read-only — this property isn&apos;t assigned to you. Admins and listing managers can
          edit any property.
        </p>
      ) : (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </form>
  );
}
