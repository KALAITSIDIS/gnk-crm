"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { createShareLink } from "@/lib/actions/share-links";
import {
  needsAudienceConfirmation,
  proposalBlocker,
  proposalLocale,
  statusCaveat,
  visibilityChipLabel,
} from "@/lib/services/match-proposal";
import { DEFAULT_EXPIRY_DAYS } from "@/lib/services/share-links";
import type { MatchVerdict } from "@/lib/services/matching";
import { MintedLink } from "@/components/features/share-links/minted-link";
import {
  MatchReasons,
  ProposedBadge,
  ScoreBadge,
  VisibilityChip,
} from "@/components/features/shared/match-list";
import { CreateViewingDialog } from "@/components/features/viewings/create-viewing-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * A match, one step further (A04): a buyer-bound proposal, or a viewing.
 *
 * THE PROPOSAL IS THE EXISTING ONE. `createShareLink` with the buyer's
 * `contact_id` — the B3 magic link, shown once (its token is stored only as a
 * hash) and handed to the buyer BY THE AGENT. Nothing is sent, drafted or
 * prefilled here; the system never contacts anyone.
 *
 * What the proposal page will not say, the desk is told before minting:
 *   - a reserved or under-offer listing reads there as plainly available (the
 *     resolver's payload carries no status), so the caveat sits beside its
 *     tick, and every match starts unticked — a proposal is a deliberate
 *     shortlist, never "everything the matcher found";
 *   - an off-market listing is shown to whoever holds the link, so including
 *     one needs an explicit "this buyer may see off-market listings".
 * The title is left for the agent to write: a saved search's label is the
 * desk's own wording and is never put on a client-facing page by default.
 *
 * Not offered for an archived or erased contact (the caller decides; the
 * action refuses either anyway). The viewing is the existing dialog with both
 * parties filled in; its role gate stays inside it.
 */

const LOCALE_NAME: Record<string, string> = { en: "English", el: "Greek", ru: "Russian" };

export interface ProposalBuyer {
  id: string;
  name: string;
  languages: string[];
}

export interface ProposalListing {
  id: string;
  reference: string;
  status: string;
  visibility: string;
}

type Minted = { path: string; notice: string | null };

/** One mint, shared by both sides: the token comes back once, with its notice. */
function useMintProposal(buyer: ProposalBuyer) {
  const [minted, setMinted] = useState<Minted | null>(null);
  const [pending, start] = useTransition();
  const locale = proposalLocale(buyer.languages);

  const mint = (listings: readonly ProposalListing[], title: string, onMinted: () => void) =>
    start(async () => {
      try {
        const res = await createShareLink({
          property_ids: listings.map((l) => l.id),
          contact_id: buyer.id,
          locale,
          title: title.trim() || undefined,
        });
        if (res.error) {
          toast.error(res.error);
          return;
        }
        if (res.path) setMinted({ path: res.path, notice: res.notice });
        if (res.notice) toast.warning(res.notice);
        onMinted();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "The proposal could not be created");
      }
    });

  return { minted, clear: () => setMinted(null), pending, mint, locale };
}

/** The link, shown once — with the action's notice when a step after it was not confirmed. */
function MintedProposal({ minted, onDone }: { minted: Minted; onDone: () => void }) {
  return <MintedLink path={minted.path} heading="Proposal link ready" notice={minted.notice} onDone={onDone} />;
}

/** "Nothing is sent" and what the link is, under every Create button. */
function ProposalFinePrint({ locale }: { locale: string }) {
  return (
    <p className="text-xs text-text-3">
      A no-login page in {LOCALE_NAME[locale] ?? locale}, valid {DEFAULT_EXPIRY_DAYS} days, bound to this buyer.
      Nothing is sent — copy the link and send it yourself. Every proposal is listed under{" "}
      <Link href="/share-links" className="text-brand-700 underline underline-offset-2">
        Share links
      </Link>
      .
    </p>
  );
}

function OffMarketConfirm({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm text-text-1">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
      <span>
        This buyer may see off-market listings
        <span className="block text-xs text-text-3">
          Whoever holds the link sees every listing on it, off-market ones included.
        </span>
      </span>
    </label>
  );
}

function StatusCaveats({ listings }: { listings: readonly ProposalListing[] }) {
  const flagged = listings.filter((l) => statusCaveat(l.status));
  if (flagged.length === 0) return null;
  return (
    <p className="text-xs text-warning" role="note">
      {flagged.map((l) => `${l.reference} is ${statusCaveat(l.status)!.toLowerCase()}`).join("; ")} — the proposal
      page does not show that. Tell the buyer when you send it.
    </p>
  );
}

/* ------------------------------------------------------------------------ */
/* Contact side: pick matches for one buyer                                  */
/* ------------------------------------------------------------------------ */

export interface ContactMatchRow {
  listing: ProposalListing;
  title: string;
  /** reference · price the search is about · bedrooms — built by the server */
  subline: string;
  verdict: MatchVerdict;
  /** the newest buyer-bound proposal already holding it, formatted */
  proposed: { date: string; detail: string } | null;
}

/**
 * One saved search's matches for this buyer, each with a tick (when a
 * proposal may be made) and a Viewing button. Rows stay `<li>`s with the
 * score, the reasons, and now the visibility and "Proposed" chips.
 */
export function MatchProposalList({
  listKey,
  buyer,
  rows,
  canAct,
  role,
}: {
  /** unique per list on the page (the search id) — form control ids hang off it */
  listKey: string;
  buyer: ProposalBuyer;
  rows: ContactMatchRow[];
  /** false for an archived or erased contact: no proposal, no viewing */
  canAct: boolean;
  role: string;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [title, setTitle] = useState("");
  const { minted, clear, pending, mint, locale } = useMintProposal(buyer);

  const picked = rows.filter((r) => selected.includes(r.listing.id)).map((r) => r.listing);
  const blocker = proposalBlocker({ listings: picked, offMarketConfirmed: confirmed });
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...selected.filter((v) => v !== id), id] : selected.filter((v) => v !== id);
    setSelected(next);
    // the confirmation is about the off-market listings ticked NOW: once none
    // is, it is withdrawn, and ticking one again asks again
    const stillOffMarket = needsAudienceConfirmation(
      rows.filter((r) => next.includes(r.listing.id)).map((r) => r.listing),
    );
    if (!stillOffMarket) setConfirmed(false);
  };

  return (
    <>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const id = `pick-${listKey}-${row.listing.id}`;
          const caveat = statusCaveat(row.listing.status);
          return (
            <li key={row.listing.id} className="rounded-[10px] border border-border bg-surface p-3">
              <div className="flex items-start gap-3">
                {canAct ? (
                  <Checkbox
                    id={id}
                    className="mt-1"
                    checked={selected.includes(row.listing.id)}
                    onCheckedChange={(v) => toggle(row.listing.id, v === true)}
                    aria-label={`Include ${row.listing.reference} in the proposal`}
                  />
                ) : null}
                <ScoreBadge score={row.verdict.score} />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/properties/${row.listing.id}`}
                    className="text-sm font-medium text-text-1 underline-offset-2 hover:underline"
                  >
                    {row.title}
                  </Link>
                  <p className="text-xs text-text-3">{row.subline}</p>
                  {row.proposed || visibilityChipLabel(row.listing.visibility) ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <VisibilityChip visibility={row.listing.visibility} />
                      {row.proposed ? <ProposedBadge date={row.proposed.date} detail={row.proposed.detail} /> : null}
                    </div>
                  ) : null}
                  <MatchReasons verdict={row.verdict} />
                  {canAct && caveat ? (
                    <p className="mt-1 text-xs text-warning">
                      {caveat} — a proposal page does not show that; tick it only if the buyer should still see it.
                    </p>
                  ) : null}
                </div>
                {canAct ? (
                  <div className="shrink-0">
                    <CreateViewingDialog
                      compact
                      triggerLabel="Viewing"
                      triggerAriaLabel={`Viewing — ${row.listing.reference} with ${buyer.name}`}
                      role={role}
                      defaultProperty={{ id: row.listing.id, label: row.title, sublabel: row.listing.reference }}
                      defaultContact={{ id: buyer.id, label: buyer.name, sublabel: null }}
                    />
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      {canAct ? (
        <div className="mt-3 flex flex-col gap-2 rounded-[10px] border border-border bg-surface-2/40 p-3">
          <StatusCaveats listings={picked} />
          {needsAudienceConfirmation(picked) ? (
            <OffMarketConfirm id={`offmarket-${listKey}`} checked={confirmed} onChange={setConfirmed} />
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Label htmlFor={`title-${listKey}`} className="text-xs text-text-2">
                Title on the proposal page (optional)
              </Label>
              <Input
                id={`title-${listKey}`}
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Villas near the sea"
                className="h-9"
              />
            </div>
            <Button
              type="button"
              // a long buyer name wraps inside the button instead of widening a phone's page
              className="h-auto min-h-9 max-w-full whitespace-normal py-1.5 text-left"
              disabled={pending || blocker !== null}
              onClick={() =>
                mint(picked, title, () => {
                  setSelected([]);
                  setConfirmed(false);
                  setTitle("");
                })
              }
            >
              <FileText className="size-4" />
              {pending ? "Creating…" : `Create proposal for ${buyer.name} (${picked.length})`}
            </Button>
          </div>
          {picked.length > 0 && blocker ? <p className="text-xs text-text-3">{blocker}</p> : null}
          <ProposalFinePrint locale={locale} />
        </div>
      ) : null}

      {minted ? (
        <div className="mt-3">
          <MintedProposal minted={minted} onDone={clear} />
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* Property side: this listing for one matched buyer                         */
/* ------------------------------------------------------------------------ */

/** "Proposal" and "Viewing" on a Matching buyers row. */
export function BuyerRowActions({
  buyer,
  listing,
  listingLabel,
  role,
}: {
  buyer: ProposalBuyer;
  listing: ProposalListing;
  /** the listing's title, for the viewing dialog's prefilled property */
  listingLabel: string;
  role: string;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1">
      <SingleProposalDialog buyer={buyer} listing={listing} />
      <CreateViewingDialog
        compact
        triggerLabel="Viewing"
        triggerAriaLabel={`Viewing — ${listing.reference} with ${buyer.name}`}
        role={role}
        defaultProperty={{ id: listing.id, label: listingLabel, sublabel: listing.reference }}
        defaultContact={{ id: buyer.id, label: buyer.name, sublabel: null }}
      />
    </div>
  );
}

function SingleProposalDialog({ buyer, listing }: { buyer: ProposalBuyer; listing: ProposalListing }) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [title, setTitle] = useState("");
  const { minted, clear, pending, mint, locale } = useMintProposal(buyer);
  const blocker = proposalBlocker({ listings: [listing], offMarketConfirmed: confirmed });
  const ids = `${listing.id}-${buyer.id}`;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          // the link was shown once; closing ends it, as "Done" does
          clear();
          setConfirmed(false);
          setTitle("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          aria-label={`Proposal — ${listing.reference} for ${buyer.name}`}
        >
          <FileText className="size-3.5" /> Proposal
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Proposal for {buyer.name}</DialogTitle>
          <DialogDescription>{listing.reference}, as a no-login page bound to this buyer.</DialogDescription>
        </DialogHeader>
        {minted ? (
          <MintedProposal
            minted={minted}
            onDone={() => {
              clear();
              setOpen(false);
            }}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <StatusCaveats listings={[listing]} />
            {needsAudienceConfirmation([listing]) ? (
              <OffMarketConfirm id={`offmarket-${ids}`} checked={confirmed} onChange={setConfirmed} />
            ) : null}
            <div className="flex flex-col gap-1">
              <Label htmlFor={`title-${ids}`}>Title on the proposal page (optional)</Label>
              <Input
                id={`title-${ids}`}
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. A villa you may like"
              />
            </div>
            <Button
              type="button"
              disabled={pending || blocker !== null}
              onClick={() => mint([listing], title, () => setConfirmed(false))}
            >
              {pending ? "Creating…" : "Create proposal"}
            </Button>
            {blocker ? <p className="text-xs text-text-3">{blocker}</p> : null}
            <ProposalFinePrint locale={locale} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
