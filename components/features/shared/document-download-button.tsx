"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { getDocumentDownloadUrl } from "@/lib/actions/documents";
import { Button } from "@/components/ui/button";

/** Opens a short-lived signed URL for a private document (RLS-gated). */
export function DocumentDownloadButton({
  documentId,
  label = "Download PDF",
}: {
  documentId: string;
  label?: string;
}) {
  const [loading, setLoading] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={loading}
      onClick={async () => {
        setLoading(true);
        const { url, error } = await getDocumentDownloadUrl(documentId);
        setLoading(false);
        if (url) window.open(url, "_blank", "noopener");
        else toast.error(error ?? "Could not open the document");
      }}
    >
      <Download className="size-4" /> {loading ? "Preparing…" : label}
    </Button>
  );
}
