"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EXPORT_FAILED_MESSAGE } from "@/lib/constants/export";
import { csvFilenameOf, exportRefusalMessage, isCsvAnswer } from "@/lib/utils/export-download";

/**
 * The "Export CSV" button of a list page (DECISIONS T-export-complete).
 *
 * It used to be a plain `<a download>`: when the route refused — too many
 * records, a failed page, a failed audit line — the browser showed at most a
 * failed download with no reason. Now the button fetches the export itself:
 * a CSV answer is saved under the route's own filename; anything else saves
 * NOTHING and says why (`exportRefusalMessage`). The anchor keeps its `href`,
 * so without JavaScript it still downloads as before.
 */
export function ExportCsvButton({
  href,
  label = "Export CSV",
  size,
}: {
  href: string;
  label?: string;
  size?: "default" | "sm";
}) {
  const [busy, setBusy] = useState(false);

  async function download(event: React.MouseEvent<HTMLAnchorElement>) {
    // a modified click (new tab, save link as…) stays the browser's
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(href, { cache: "no-store", credentials: "same-origin" });
      if (isCsvAnswer(res)) save(await res.blob(), csvFilenameOf(res.headers.get("content-disposition")));
      else toast.error(await exportRefusalMessage(res), { duration: 15_000 });
    } catch {
      toast.error(EXPORT_FAILED_MESSAGE, { duration: 15_000 });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button asChild variant="outline" size={size}>
      {/* An anchor, not next/link: this is a file download, not a navigation. */}
      <a href={href} download onClick={download} aria-busy={busy}>
        <Download className="size-4" /> {busy ? "Preparing…" : label}
      </a>
    </Button>
  );
}

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // revoked later, not at once: a browser may still be reading the blob after click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
