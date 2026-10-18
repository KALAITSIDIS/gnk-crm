"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { PageLoadError } from "@/components/features/shared/page-load-error";

/**
 * The properties segment's error boundary (T5.7). Same words as the app's
 * (A08): what failed is the page, and the reference is what to quote.
 */
export default function PropertiesError({
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
