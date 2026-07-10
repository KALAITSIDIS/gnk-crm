"use client";

import { Button } from "@/components/ui/button";

export default function PropertiesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[10px] border border-border bg-surface py-16">
      <p className="text-sm font-medium text-text-1">Couldn&apos;t load properties.</p>
      <p className="max-w-md truncate text-xs text-text-3">{error.message}</p>
      <Button variant="outline" size="sm" onClick={reset}>
        Retry
      </Button>
    </div>
  );
}
