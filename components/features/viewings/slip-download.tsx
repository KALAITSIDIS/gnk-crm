"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { getSlipDownloadUrl } from "@/lib/actions/viewing-slips";
import { Button } from "@/components/ui/button";

/** Opens a short-lived signed URL for the slip PDF (private bucket). */
export function SlipDownloadButton({ viewingId }: { viewingId: string }) {
  const [loading, setLoading] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      disabled={loading}
      onClick={async () => {
        setLoading(true);
        const { url, error } = await getSlipDownloadUrl(viewingId);
        setLoading(false);
        if (url) window.open(url, "_blank", "noopener");
        else toast.error(error ?? "Could not open the slip");
      }}
    >
      <Download className="size-4" /> {loading ? "Preparing…" : "Download slip (PDF)"}
    </Button>
  );
}
