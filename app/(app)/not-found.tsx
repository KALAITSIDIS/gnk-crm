import Link from "next/link";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Branded 404 for the many pages that call notFound() (T5.7). */
export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[10px] border border-border bg-surface py-16 text-center">
      <Compass className="size-8 text-text-3" />
      <p className="text-lg font-semibold text-text-1">Not found</p>
      <p className="max-w-sm text-sm text-text-2">
        This record doesn&apos;t exist, was removed, or isn&apos;t visible to your role.
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}
