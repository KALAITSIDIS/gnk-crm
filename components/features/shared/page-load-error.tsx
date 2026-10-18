"use client";

import { RotateCw } from "lucide-react";
import { TechnicalDetails } from "@/components/features/shared/technical-details";
import { Button } from "@/components/ui/button";

/**
 * What a route's error boundary shows (T5.7; worded in A08, review
 * 2026-10-18): one business sentence, a reference to quote, and a way to try
 * again — the raw error behind "Technical details".
 *
 * Before this the boundary led with `error.message`. In production Next
 * replaces a server component's message with its own generic framework text
 * (only the digest survives), and in development it is a PostgREST or query
 * string — neither is a sentence for an agent. The DIGEST is what matches
 * the server's log and Sentry, so it is the reference a person quotes.
 *
 * `retry` (Next 16) refreshes the route's server data and re-renders it; the
 * old `reset` only re-rendered, so a failed server read failed again.
 * `role="alert"` is on the sentence, not on the button: a screen reader hears
 * that the page failed the moment the boundary replaces it.
 */
export function PageLoadError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div
      data-testid="page-load-error"
      className="flex flex-col items-center gap-3 rounded-[10px] border border-border bg-surface px-4 py-16 text-center"
    >
      <div role="alert" className="flex flex-col items-center gap-2">
        <h1 className="text-base font-semibold text-text-1">This page could not load</h1>
        <p className="max-w-md text-sm text-text-2">
          Try again. If it keeps happening, tell an admin
          {error.digest ? (
            <>
              {" "}
              and quote reference <span className="select-all font-mono text-text-1">{error.digest}</span>
            </>
          ) : null}
          .
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => retry()}>
        <RotateCw className="size-4" /> Try again
      </Button>
      {error.message ? (
        <TechnicalDetails className="max-w-md text-left">{error.message}</TechnicalDetails>
      ) : null}
    </div>
  );
}
