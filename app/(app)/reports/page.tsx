import Link from "next/link";
import { FileCheck2 } from "lucide-react";

export default function ReportsPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">Reports</h1>
        <p className="text-sm text-text-2">Generated documents are stored and evented.</p>
      </div>

      <Link
        href="/reports/commission-evidence"
        className="flex max-w-md items-start gap-3 rounded-[10px] border border-border bg-surface p-5 transition-colors hover:border-brand-300"
      >
        <FileCheck2 className="mt-0.5 size-5 shrink-0 text-brand-700" />
        <span>
          <span className="block text-sm font-semibold text-text-1">
            Commission evidence report
          </span>
          <span className="block text-sm text-text-2">
            Chronological, hash-verified activity record for a contact — viewings with signed
            slips, offers, stage changes — as a stored PDF.
          </span>
        </span>
      </Link>
    </div>
  );
}
