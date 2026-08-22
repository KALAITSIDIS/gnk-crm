"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The token is shown EXACTLY ONCE. Only its hash is stored (migration 0023), so
 * there is no way to recover it afterwards — the same one-shown-once shape as
 * the invite dialog, and for the same reason: a recoverable secret is not one.
 *
 * Lifted out of `share-links-client.tsx` when 0041 added a second place to mint
 * from (the project units page). Importing it from that file instead would have
 * dragged the whole proposal curation UI into the properties bundle.
 */
export function MintedLink({
  path,
  heading = "Link ready",
  onDone,
}: {
  path: string;
  heading?: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? path : `${window.location.origin}${path}`;

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-brand-700/40 bg-brand-700/5 p-4">
      <div>
        <h3 className="text-sm font-semibold text-text-1">{heading}</h3>
        <p className="text-sm text-text-2">
          Copy it now — this is the only time it can be shown. Only a hash is stored, so it
          cannot be recovered later. You can always revoke it and make a new one.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input readOnly value={url} aria-label={heading} className="h-10 min-w-0 flex-1" />
        <Button
          type="button"
          className="h-10"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            toast.success("Link copied");
          }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" variant="outline" className="h-10" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
