"use client";

import { useTransition } from "react";
import Link from "next/link";
import { Check, SearchCheck } from "lucide-react";
import { toast } from "sonner";
import { saveSearchFromEnquiry } from "@/lib/actions/leads";
import { Button } from "@/components/ui/button";
import type { SavedSearchState } from "@/lib/queries/lead-saved-search";

/**
 * Whether the lead's contact has a saved search, on the inbox row (A04).
 *
 * The matcher works from saved searches and nothing else, and they were
 * edited only on a contact tab no other screen could link to — so the desk
 * qualifying a buyer here had no sign the matcher had nothing to go on. Every
 * state links to the contact's Preferences tab (`?tab=preferences`), where the
 * search is read and edited. A website buyer's brief can be saved as the
 * search in one click; the server re-checks everything the button assumes.
 *
 * "Could not be checked" is said as such — never drawn as "no saved search".
 */
export function SavedSearchStatus({
  leadId,
  contactId,
  state,
  canAdd,
  canSaveBrief,
}: {
  leadId: string;
  contactId: string;
  state: SavedSearchState;
  canAdd: boolean;
  canSaveBrief: boolean;
}) {
  const [pending, start] = useTransition();
  const href = `/contacts/${contactId}?tab=preferences`;

  const save = () =>
    start(async () => {
      try {
        const r = await saveSearchFromEnquiry(leadId);
        if (r.error) {
          toast.error(r.error);
          return;
        }
        toast.success("Brief saved as the contact's search");
        if (r.note) toast.warning(r.note);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save the brief");
      }
    });

  if (state === "has") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs">
        <Link href={href} className="inline-flex items-center gap-1 font-medium text-success hover:underline">
          <Check className="size-3.5" aria-hidden /> Saved search
        </Link>
      </p>
    );
  }

  if (state === "unknown") {
    return (
      <p className="text-xs text-text-3">
        Saved search could not be checked —{" "}
        <Link href={href} className="text-brand-700 hover:underline">
          see the contact
        </Link>
      </p>
    );
  }

  return (
    <p className="flex flex-wrap items-center gap-2 text-xs">
      <Link href={href} className="font-medium text-warning hover:underline">
        {canAdd ? "No saved search — add one" : "No saved search"}
      </Link>
      {canSaveBrief ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={pending}
          title="Save this enquiry's brief (budget, area, type, bedrooms, deed) as the contact's saved search. Nothing is sent."
          onClick={save}
        >
          <SearchCheck className="size-3.5" /> {pending ? "Saving…" : "Save brief as search"}
        </Button>
      ) : null}
    </p>
  );
}
