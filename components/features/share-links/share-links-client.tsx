"use client";

import { useMemo, useState, useTransition } from "react";
import { Link2, Plus, Ban } from "lucide-react";
import { toast } from "sonner";
import { createShareLink, revokeShareLink } from "@/lib/actions/share-links";
import {
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  SHARE_LOCALES,
  daysUntilExpiry,
  shareLinkState,
} from "@/lib/services/share-links";
import { MintedLink } from "@/components/features/share-links/minted-link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

export interface ShareLinkRow {
  id: string;
  title: string | null;
  locale: string;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastOpenedAt: string | null;
  propertyCount: number;
  contactName: string | null;
  /** 'proposal' | 'availability' (migration 0041) */
  kind: string;
  /** the project or phase an availability link names; null for a proposal */
  targetReference: string | null;
}

export interface CurationProperty {
  id: string;
  reference: string;
  title: string | null;
  askingPrice: number | null;
  currency: string;
  propertyType: string;
}

const LOCALE_LABEL: Record<string, string> = { en: "English", el: "Ελληνικά", ru: "Русский" };

export function ShareLinksClient({
  links,
  properties,
}: {
  links: ShareLinkRow[];
  properties: CurationProperty[];
}) {
  const [open, setOpen] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [locale, setLocale] = useState<string>("en");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [expiryDays, setExpiryDays] = useState(String(DEFAULT_EXPIRY_DAYS));
  const [search, setSearch] = useState("");
  const [pending, start] = useTransition();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return properties;
    return properties.filter(
      (p) =>
        p.reference.toLowerCase().includes(q) || (p.title ?? "").toLowerCase().includes(q),
    );
  }, [properties, search]);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));

  const submit = () =>
    start(async () => {
      const res = await createShareLink({
        property_ids: selected,
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
      setSelected([]);
      setTitle("");
      setMessage("");
    });

  const revoke = (id: string) =>
    start(async () => {
      const { error } = await revokeShareLink(id);
      if (error) toast.error(error);
      else toast.success("Link revoked");
    });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          {/* "Proposals" until 0041 — the page now also lists availability
              links, which are minted from a project's units page. */}
          <h1 className="text-xl font-semibold text-text-1">Share links</h1>
          <p className="text-sm text-text-2">
            No-login pages for buyers, developers and partner agents. Every open is counted
            and logged.
          </p>
        </div>
        <Button type="button" onClick={() => setOpen((v) => !v)} className="h-10">
          <Plus className="size-4" /> New proposal
        </Button>
      </div>

      {minted ? (
        <MintedLink
          path={minted}
          heading="Proposal link ready"
          onDone={() => setMinted(null)}
        />
      ) : null}

      {open ? (
        <section className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-4">
          <div className="flex flex-wrap gap-2">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title (optional)"
              aria-label="Proposal title"
              className="h-10 min-w-0 flex-1 basis-48"
            />
            <label className="flex items-center gap-2 text-sm text-text-2">
              Language
              <select
                aria-label="Proposal language"
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

          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="A short note to the buyer (optional)"
            aria-label="Message to the buyer"
            rows={2}
          />

          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter properties…"
            aria-label="Filter properties"
            className="h-10"
          />

          <ul className="flex max-h-72 flex-col divide-y divide-border/60 overflow-y-auto rounded-md border border-border">
            {filtered.length === 0 ? (
              <li className="p-3 text-sm text-text-3">No properties match.</li>
            ) : (
              filtered.map((p) => (
                <li key={p.id} className="flex min-h-11 items-center gap-3 px-3 py-2">
                  <Checkbox
                    checked={selected.includes(p.id)}
                    onCheckedChange={() => toggle(p.id)}
                    aria-label={`Include ${p.reference}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-text-1">
                    {p.title || p.reference}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-text-3">{p.reference}</span>
                </li>
              ))
            )}
          </ul>

          <div className="flex items-center gap-2">
            <Button type="button" onClick={submit} disabled={pending || selected.length === 0}>
              {pending ? "Creating…" : `Create link (${selected.length})`}
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </section>
      ) : null}

      <section className="rounded-[10px] border border-border bg-surface p-4">
        <h2 className="mb-2 text-sm font-semibold text-text-1">Recent links</h2>
        {links.length === 0 ? (
          <p className="py-2 text-sm text-text-3">No share links yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60">
            {links.map((l) => {
              const state = shareLinkState({ expires_at: l.expiresAt, revoked_at: l.revokedAt });
              const isAvailability = l.kind === "availability";
              return (
                <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                  <Link2 className="size-4 shrink-0 text-text-3" />
                  {/* Which kind, said plainly. The two expose different fields,
                      so "which one is this" is a question with a consequence. */}
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-xs",
                      isAvailability
                        ? "bg-brand-700/10 text-brand-700"
                        : "bg-surface-2 text-text-2",
                    )}
                  >
                    {isAvailability ? "availability" : "proposal"}
                  </span>
                  <span className="min-w-0 flex-1 text-sm text-text-1">
                    {l.title ||
                      (isAvailability
                        ? (l.targetReference ?? "Project availability")
                        : `${l.propertyCount} properties`)}
                    {isAvailability && l.title && l.targetReference ? (
                      <span className="text-text-3"> · {l.targetReference}</span>
                    ) : null}
                    {l.contactName ? (
                      <span className="text-text-3"> · {l.contactName}</span>
                    ) : null}
                    <span className="text-text-3"> · {LOCALE_LABEL[l.locale] ?? l.locale}</span>
                  </span>

                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-xs",
                      state === "live" && "bg-success/10 text-success",
                      state === "expired" && "bg-surface-2 text-text-3",
                      state === "revoked" && "bg-danger/10 text-danger",
                    )}
                  >
                    {state === "live"
                      ? `live · ${daysUntilExpiry(l.expiresAt)}d left`
                      : state}
                  </span>

                  <span className="shrink-0 text-xs tabular-nums text-text-2">
                    {l.viewCount} {l.viewCount === 1 ? "view" : "views"}
                    {l.lastOpenedAt ? ` · ${formatDateTime(l.lastOpenedAt)}` : ""}
                  </span>

                  {state === "live" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => revoke(l.id)}
                    >
                      <Ban className="size-4" /> Revoke
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
