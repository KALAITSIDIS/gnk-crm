"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { PageLoadError } from "@/components/features/shared/page-load-error";

/**
 * App-level error boundary (T5.7). Reports to Sentry when configured; the
 * words, the reference and the retry are PageLoadError's (A08).
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return <PageLoadError error={error} retry={retry} />;
}
