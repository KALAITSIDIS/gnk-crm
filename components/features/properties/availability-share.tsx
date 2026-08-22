"use client";

import { useState, useTransition } from "react";
import { Share2 } from "lucide-react";
import { toast } from "sonner";
import { createAvailabilityLink } from "@/lib/actions/share-links";
import { MintedLink } from "@/components/features/share-links/minted-link";
import {
  AVAILABILITY_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  SHARE_LOCALES,
} from "@/lib/services/share-links";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/**
 * Mint a live availability link for this project or phase (migration 0041).
 *
 * It lives HERE, on the units page, rather than on `/share-links`, because this
 * is where somebody is standing when the thought occurs — the matrix is on the
 * screen and the price lists are beside it. `/share-links` still lists and
 * revokes every link of both kinds; only the minting is contextual.
 *
 * No role gate, matching proposals. See `createAvailabilityLink` for why.
 */

const LOCALE_LABEL: Record<string, string> = { en: "English", el: "Ελληνικά", ru: "Русский" };

export interface AvailabilityPriceList {
  id: string;
  version: number;
  effectiveDate: string;
}

export function AvailabilityShare({
  projectId,
  projectReference,
  isPhase,
  priceLists,
  unitCount,
  hasPhases,
}: {
  projectId: string;
  projectReference: string;
  isPhase: boolean;
  priceLists: AvailabilityPriceList[];
  /** units directly under this record — 0 on a phased project, which is fine */
  unitCount: number;
  hasPhases: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [locale, setLocale] = useState<string>("en");
  const [expiryDays, setExpiryDays] = useState(String(AVAILABILITY_EXPIRY_DAYS));
  const [priceListId, setPriceListId] = useState<string>("");
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      const res = await createAvailabilityLink({
        project_id: projectId,
        price_list_id: priceListId || null,
        locale: locale as (typeof SHARE_LOCALES)[number],
        title: title || undefined,
        message: message || undefined,
        expiry_days: Number(expiryDays),
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setMinted(res.path);
      setOpen(false);
      setTitle("");
      setMessage("");
    });

  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text-1">Share availability</h2>
          <p className="text-sm text-text-2">
            A no-login page showing every unit and its status, live. Replaces sending a PDF.
            Every open is counted and logged, and you can revoke it at any time from Share
            links.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => setOpen((v) => !v)}>
          <Share2 className="size-4" /> {open ? "Cancel" : "New link"}
        </Button>
      </div>

      {minted ? (
        <MintedLink
          path={minted}
          heading="Availability link ready"
          onDone={() => setMinted(null)}
        />
      ) : null}

      {open ? (
        <div className="flex flex-col gap-3 border-t border-border pt-3">
          {/* A phased project's units hang off its phases, so the matrix walks
              descendants (0041). Said out loud here because the units table
              above this form shows only the DIRECT children, and the two
              numbers differing would otherwise look like a bug. */}
          {hasPhases && !isPhase ? (
            <p className="rounded-md bg-surface-2 p-2 text-xs text-text-2">
              This link covers every phase of {projectReference}, grouped by phase with each
              phase&apos;s own delivery date. To share one phase only, open that phase and
              create the link from there.
            </p>
          ) : null}
          {!hasPhases && unitCount === 0 ? (
            <p className="rounded-md bg-warning/10 p-2 text-xs text-warning">
              {projectReference} has no units yet, so this link would open an empty matrix.
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title (optional)"
              aria-label="Availability link title"
              className="h-10 min-w-0 flex-1 basis-48"
            />
            <label className="flex items-center gap-2 text-sm text-text-2">
              Language
              <select
                aria-label="Availability link language"
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
                className="h-10 rounded-md border border-border bg-surface px-2 text-sm"
              >
                {SHARE_LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {LOCALE_LABEL[l]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-text-2">
              Expires in
              <Input
                type="number"
                min={1}
                max={MAX_EXPIRY_DAYS}
                value={expiryDays}
                onChange={(e) => setExpiryDays(e.target.value)}
                aria-label="Expires in days"
                className="h-10 w-20"
              />
              days
            </label>
          </div>

          {/* Which prices they see. A pinned version shows what was actually
              quoted; it does NOT fall back to live numbers for units it omits,
              which is the whole reason to pin one. */}
          <label className="flex flex-col gap-1 text-sm text-text-2">
            Prices
            <select
              aria-label="Prices shown on the link"
              value={priceListId}
              onChange={(e) => setPriceListId(e.target.value)}
              className="h-10 rounded-md border border-border bg-surface px-2 text-sm"
            >
              <option value="">Live asking prices (change as the desk updates them)</option>
              {priceLists.map((pl) => (
                <option key={pl.id} value={pl.id}>
                  Price list v{pl.version} — effective {pl.effectiveDate}
                </option>
              ))}
            </select>
            {priceListId ? (
              <span className="text-xs text-text-3">
                Units missing from that version will show no price rather than a live one.
              </span>
            ) : null}
          </label>

          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="A short note for the developer or partner agent (optional)"
            aria-label="Message on the availability page"
            rows={2}
          />

          <div className="flex items-center gap-2">
            <Button type="button" onClick={submit} disabled={pending}>
              {pending ? "Creating…" : "Create link"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
