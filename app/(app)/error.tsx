"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** App-level error boundary (T5.7). Reports to Sentry when configured. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center gap-3 rounded-[10px] border border-border bg-surface py-16 text-center">
      <p className="text-sm font-medium text-text-1">Something went wrong.</p>
      <p className="max-w-md truncate px-4 text-xs text-text-3">{error.message}</p>
      {error.digest ? (
        <p className="font-mono text-[10px] text-text-3">ref: {error.digest}</p>
      ) : null}
      <Button variant="outline" size="sm" onClick={reset}>
        <RotateCw className="size-4" /> Try again
      </Button>
    </div>
  );
}
