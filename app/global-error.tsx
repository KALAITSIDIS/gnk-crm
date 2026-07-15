"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * Root error boundary (T5.7): catches failures in the root layout itself, so
 * it must render its own <html>/<body>. Deliberately dependency-free (inline
 * styles) since the app shell may not have loaded.
 */
export default function GlobalError({
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
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          margin: 0,
          background: "#fafafa",
          color: "#1a1a1a",
        }}
      >
        <div style={{ textAlign: "center", padding: 32 }}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: "#666", marginBottom: 16 }}>
            The application hit an unexpected error.
          </p>
          <button
            onClick={reset}
            style={{
              borderRadius: 8,
              border: "1px solid #ccc",
              background: "#fff",
              padding: "6px 14px",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
