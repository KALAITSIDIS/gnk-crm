"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { toast } from "sonner";
import { saveViewingFeedback, type FeedbackActionState } from "@/lib/actions/viewings";
import type { ViewingFeedback } from "@/lib/validators/viewings";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const initialState: FeedbackActionState = { error: null, savedAt: null };

export function ViewingFeedbackForm({
  viewingId,
  initial,
}: {
  viewingId: string;
  initial: ViewingFeedback | null;
}) {
  const [state, formAction, pending] = useActionState(saveViewingFeedback, initialState);
  const [rating, setRating] = useState(initial?.rating ?? 0);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Feedback saved");
    }
  }, [state.savedAt]);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="viewing_id" value={viewingId} />
      <input type="hidden" name="rating" value={rating} />

      <div className="flex flex-col gap-1.5">
        {/* five toggle buttons, not one control — group semantics (A11Y-1) */}
        <Label id="rating-label">Rating</Label>
        <div role="group" aria-labelledby="rating-label" className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setRating(n)}
              aria-label={`${n} star${n > 1 ? "s" : ""}`}
              aria-pressed={n <= rating}
            >
              <Star
                className={cn(
                  "size-7 transition-colors",
                  n <= rating ? "fill-warning text-warning" : "text-text-3 hover:text-text-2",
                )}
              />
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fb-liked">Liked</Label>
        <Textarea id="fb-liked" name="liked" rows={2} defaultValue={initial?.liked ?? ""} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fb-disliked">Disliked</Label>
        <Textarea id="fb-disliked" name="disliked" rows={2} defaultValue={initial?.disliked ?? ""} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fb-comment">Comment</Label>
        <Textarea id="fb-comment" name="comment" rows={2} defaultValue={initial?.comment ?? ""} />
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending || rating < 1} className="self-start">
        {pending ? "Saving…" : initial ? "Update feedback" : "Save feedback"}
      </Button>
    </form>
  );
}
