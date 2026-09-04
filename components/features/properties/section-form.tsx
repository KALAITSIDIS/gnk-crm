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
  readOnlyNote,
  children,
}: {
  propertyId: string;
  section: "details" | "legal" | "marketing" | "parties";
  /** true when the viewer's role can't update this property (RLS would no-op) */
  readOnly?: boolean;
  /** Why it is read-only, when assignment isn't the reason (e.g. the parties
   *  section, which is admin + listing manager regardless of assignment). */
  readOnlyNote?: string;
  children: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(updatePropertySection, initialState);
  const lastToasted = useRef<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Saved");
    }
  }, [state.savedAt]);

  /**
   * REACT RESETS AN UNCONTROLLED FORM once a server action settles, so the
   * boxes snap back to the `defaultValue` the last server render gave them —
   * the OLD values. A save that worked therefore looked like a silent no-op:
   * green toast, fields blank or reverted, and only a manual reload proved
   * the data was safe. Reported from a real production session on 2026-09-03,
   * and it is corrosive out of all proportion to its size: an operator who
   * cannot trust a save stops trusting the app.
   *
   * The values are snapshotted at submit and written back once the action
   * settles. On success they ARE the stored truth; on a refusal they are what
   * the person typed, which is what they need in front of them to fix it.
   * The create wizard has carried this same workaround since 2026-08-28.
   *
   * Deliberately inputs and textareas only: Radix selects keep their own
   * React state (untouched by the DOM reset), and a checkbox like the publish
   * override SHOULD clear — it authorises one save, not every later one.
   */
  const submitted = useRef<Record<string, string> | null>(null);

  const snapshot = () => {
    const form = formRef.current;
    if (!form) return;
    const snap: Record<string, string> = {};
    for (const el of Array.from(form.elements)) {
      const named =
        (el instanceof HTMLInputElement &&
          el.type !== "hidden" &&
          el.type !== "checkbox" &&
          el.type !== "radio") ||
        el instanceof HTMLTextAreaElement;
      if (named && el.name) snap[el.name] = el.value;
    }
    submitted.current = snap;
  };

  useEffect(() => {
    const snap = submitted.current;
    if (!snap) return;
    const form = formRef.current;
    for (const [name, value] of Object.entries(snap)) {
      const el = form?.elements.namedItem(name);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.value = value;
    }
    submitted.current = null;
    // `state`, not `state.savedAt`: two consecutive refusals carrying the same
    // message are two result objects but one unchanged field, and keying on
    // the field would skip the restore on the second one
  }, [state]);

  return (
    <form ref={formRef} action={formAction} onSubmit={snapshot} className="flex flex-col gap-4">
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
          {readOnlyNote ??
            "Read-only — this property isn't assigned to you. Admins and listing managers can edit any property."}
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
