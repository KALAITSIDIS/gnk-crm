"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import Link from "next/link";
import { Copy, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  regeneratePortalToken,
  savePortalSettings,
  setPortalEnabled,
  type PortalActionState,
} from "@/lib/actions/portals";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PortalCardDefinition } from "@/lib/services/portals/card-definition";
import type { PullHealth } from "@/lib/services/portals/pull-health";
import type { PortalSelectionSummary } from "@/lib/services/portals/selection-summary";
import { formatDateTime } from "@/lib/utils/format";

/**
 * One portal on Settings → Portals (spec 2026-09-14 §Settings; portal
 * integrations audit 2026-10-18).
 *
 * THE FEED URL IS SHOWN ONCE (0097). The database holds only the token's
 * digest, so the server can say that a URL exists and never what it is; the
 * plaintext arrives in the return value of the action that minted it (the
 * first enable, or Regenerate) and lives in this card's state until the page
 * is left. Its ORIGIN is the server's canonical one (feed-origin.ts:
 * NEXT_PUBLIC_APP_URL, else Vercel's production domain) — never the host this
 * page happens to be served from, so a URL copied on a preview or alias still
 * points at production. Only a local `next dev` with neither configured
 * falls back to the browser's origin, and says so.
 *
 * WHAT IT CLAIMS. Selected, on the website, in the feed, excluded (and why),
 * and when the feed URL was last requested and what that request was served.
 * Never that the portal published anything: no portal reports back, so the
 * card says "not verified" and where the desk can look.
 *
 * A portal whose renderer this build does not have shows a badge and the
 * reason instead of a switch. `setPortalEnabled` refuses it too.
 */

export interface PortalCardRun {
  firstAt: string;
  lastAt: string;
  hits: number;
  text: string;
  failed: boolean;
  ua: string;
}

export interface PortalCardConnection {
  enabled: boolean;
  /** Whether a feed URL exists. Its token is never stored, so it is shown only when issued. */
  hasToken: boolean;
  settings: Record<string, string>;
  lastPulledAt: string | null;
  lastPulledUa: string | null;
  lastPullCount: number | null;
  lastErrorAt: string | null;
  health: PullHealth;
  history: PortalCardRun[];
}

const initialState: PortalActionState = { error: null, savedAt: null };

/**
 * The browser's origin, read as what it is: a value owned by the browser and
 * absent on the server. `useSyncExternalStore` gives the server pass `""` and
 * the client the real origin AFTER hydration, so the two first renders agree.
 * It is used only to say "you are on another host", and as the URL's origin
 * when the server has no canonical one (a local `next dev`).
 */
const subscribeToNothing = () => () => {};
const readOrigin = () => window.location.origin;
const noOrigin = () => "";

/** "EUR", "EUR or GBP", "EUR, GBP or USD" */
function listOr(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

const TONE_CLASS: Record<PullHealth["tone"], string> = {
  ok: "text-text-2",
  warn: "text-warning",
  error: "text-danger",
  muted: "text-text-3",
};

/**
 * The feed URL an action just minted, shown once. Exported so its markup can
 * be rendered in a test (tests/unit/one-time-secret-notices.test.ts).
 *
 * `notice` is the action's "saved, but …" (T-one-time-secrets): the URL is
 * live and this is its only copy, but the enable's or the rotation's timeline
 * line could not be written or confirmed. It sits under the URL it is about;
 * the card also toasts it.
 */
export function IssuedFeedUrl({
  portalId,
  url,
  notice,
  rotating,
  onRegenerate,
  originNote = null,
}: {
  portalId: string;
  url: string;
  notice: string | null;
  rotating: boolean;
  onRegenerate: () => void;
  /** set when the URL's origin is not the production one, or not the page's */
  originNote?: string | null;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`feed-url-${portalId}`}
          data-testid={`portal-feed-url-${portalId}`}
          readOnly
          value={url}
          className="h-9 min-w-0 flex-1 font-mono text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          // While a rotation is in flight the field still shows the OLD
          // token; copying it would hand the portal a URL that is about
          // to stop answering.
          disabled={rotating}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              toast.success("Feed URL copied");
            } catch {
              toast.error("Could not copy — select the field and copy it by hand");
            }
          }}
        >
          <Copy className="size-4" />
          Copy
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={rotating} onClick={onRegenerate}>
          <RefreshCw className="size-4" />
          Regenerate
        </Button>
      </div>
      {notice ? (
        <p role="status" className="text-sm text-warning" data-testid={`portal-feed-url-notice-${portalId}`}>
          {notice}
        </p>
      ) : null}
      {originNote ? (
        <p className="text-xs text-warning" data-testid={`portal-feed-url-origin-${portalId}`}>
          {originNote}
        </p>
      ) : null}
      <p className="text-xs text-warning" data-testid={`portal-feed-url-once-${portalId}`}>
        Copy it now — it is shown once. The CRM keeps only a fingerprint of it; leave this
        page and the URL is gone until you regenerate.
      </p>
    </>
  );
}

function propertyHref(propertyId: string, tab: string | null): string {
  return tab ? `/properties/${propertyId}?tab=${tab}` : `/properties/${propertyId}`;
}

export function PortalCard({
  portal,
  connection,
  summary,
  feedOrigin,
  managementBlocked,
  acceptedCurrencies,
}: {
  /**
   * The registry entry's plain-data projection, NOT the entry: its schemas
   * are zod objects and React will not serialise a class instance across the
   * RSC boundary. See `card-definition.ts`.
   */
  portal: PortalCardDefinition;
  connection: PortalCardConnection | null;
  /** every listing selected for this portal: in the feed, excluded, or gone from the website */
  summary: PortalSelectionSummary;
  /** the canonical origin every feed URL is built on (feed-origin.ts), or null on a local `next dev` */
  feedOrigin: string | null;
  /** set on a deployment that may not manage connections (a preview) — the reason */
  managementBlocked: string | null;
  /**
   * `DIALECT_CURRENCIES[portal.dialect]`, resolved by the page. `null` = any.
   * Passed rather than looked up here so the `dialects` barrel — which holds
   * `DIALECT_RENDERERS`, and through it the whole Kyero renderer — stays out
   * of the client bundle.
   */
  acceptedCurrencies: readonly string[] | null;
}) {
  const enabled = connection?.enabled ?? false;
  const [toggling, startToggle] = useTransition();
  const [rotating, startRotate] = useTransition();

  const origin = useSyncExternalStore(subscribeToNothing, readOrigin, noOrigin);
  // The token this card was handed by the action that minted it, if any, with
  // that action's notice when its timeline line could not be written or
  // confirmed (T-one-time-secrets). Set only after a client action, so the
  // origin is always known by then.
  const [issued, setIssued] = useState<{ token: string; notice: string | null } | null>(null);
  const urlOrigin = feedOrigin ?? origin;
  const issuedUrl = issued ? `${urlOrigin}/api/portals/${portal.id}/${issued.token}` : "";
  const originNote = !feedOrigin
    ? "This is a local address (no production address is configured) — do not give it to a portal."
    : origin && origin !== feedOrigin
      ? `You are on ${origin}; this URL uses the production address, ${feedOrigin}.`
      : null;

  // `setPortalEnabled` refuses an enable while a required setting is blank.
  // Saying so here — and declining to send the click — is what makes the
  // asterisk on the field an honest mark rather than decoration.
  const missingRequired = portal.requiredSettings.filter(
    (k) => !(connection?.settings[k] ?? "").trim(),
  );
  const blockedByMissing = !enabled && missingRequired.length > 0;
  const onSite = summary.selected - summary.offSite.length;

  const [state, formAction, saving] = useActionState(savePortalSettings, initialState);
  // Two saves inside one millisecond would share a `savedAt` and the second
  // would pass unannounced — the house pattern, accepted.
  const lastSaved = useRef<number | null>(null);
  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastSaved.current) {
      lastSaved.current = state.savedAt;
      toast.success(`${portal.name} settings saved`);
      // saved, but its timeline line could not be written or confirmed
      if (state.notice) toast.warning(state.notice);
    }
  }, [state.savedAt, state.notice, portal.name]);
  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state.error]);

  const toggle = () => {
    // Switching a portal off empties its feed, which tells the portal to
    // remove everything it was offered; switching it back on offers every
    // retained selection again. Both say how many listings first.
    const question = enabled
      ? `Disable ${portal.name}? Its feed will answer an empty document, so ${portal.name} should remove the ${summary.inFeed} listing${summary.inFeed === 1 ? "" : "s"} it is offered now. ${summary.selected === 1 ? "The selection is" : `The ${summary.selected} selections are`} kept; enabling it again puts ${summary.selected === 1 ? "it" : "them"} back in the feed.`
      : summary.selected > 0
        ? `Enable ${portal.name}? ${summary.inFeed} of its ${summary.selected} selected listing${summary.selected === 1 ? "" : "s"} ${summary.inFeed === 1 ? "goes" : "go"} back into its feed at its next request.`
        : null;
    if (question && !confirm(question)) return;
    startToggle(async () => {
      const r = await setPortalEnabled(portal.id, !enabled);
      if (r.discardIssued) setIssued(null);
      if (r.error) {
        toast.error(r.error);
        return;
      }
      if (enabled) toast.success(`${portal.name} disabled — its feed now answers an empty document`);
      else if (r.token) {
        setIssued({ token: r.token, notice: r.notice ?? null });
        toast.success(`${portal.name} enabled — copy the feed URL now, it is shown once`);
      } else toast.success(`${portal.name} enabled`);
      // the switch took, but its timeline line could not be written or confirmed
      if (r.notice) toast.warning(r.notice);
    });
  };

  const regenerate = () => {
    if (
      !confirm(
        `Regenerate the ${portal.name} feed URL? The portal must be given the new URL; the old one stops answering.`,
      )
    ) {
      return;
    }
    startRotate(async () => {
      const r = await regeneratePortalToken(portal.id);
      // an unconfirmed rotation: whatever URL this card showed may be dead
      if (r.discardIssued) setIssued(null);
      if (r.error) {
        toast.error(r.error);
        return;
      }
      if (r.token) setIssued({ token: r.token, notice: r.notice ?? null });
      toast.success("New feed URL minted — copy it now and give it to the portal; it is shown once");
      if (r.notice) toast.warning(r.notice);
    });
  };

  return (
    <section
      className="rounded-[10px] border border-border bg-surface p-5"
      data-testid={`portal-card-${portal.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {/* an <h3>: the Portals section's <h2> is drawn by the settings layout (A08) */}
          <h3 className="text-sm font-semibold text-text-1">{portal.name}</h3>
          <p className="mt-1 text-sm text-text-2">{portal.audience}</p>
          <p className="mt-1 text-xs text-text-3">
            Format: {portal.dialect} · requests {portal.pullCadence} ·{" "}
            <a
              href={portal.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-text-2"
            >
              spec
            </a>
          </p>
        </div>
        {portal.spec === "pending" ? (
          <Badge variant="secondary">Not available yet</Badge>
        ) : (
          <div className="flex flex-col items-end gap-1">
            <Button
              type="button"
              variant={enabled ? "secondary" : "default"}
              size="sm"
              data-testid={`portal-toggle-${portal.id}`}
              disabled={toggling || blockedByMissing || managementBlocked !== null}
              title={
                managementBlocked ?? (blockedByMissing ? `Fill in ${missingRequired.join(", ")} first` : undefined)
              }
              onClick={toggle}
            >
              {toggling ? "Working…" : enabled ? "Disable" : "Enable"}
            </Button>
            {blockedByMissing ? (
              <p className="text-xs text-warning">Fill in {missingRequired.join(", ")} first</p>
            ) : null}
          </div>
        )}
      </div>

      {/* The badge has to stay short enough to sit on a 390px card, so the
          reason goes here rather than inside it. */}
      {portal.spec === "pending" ? (
        <p className="mt-2 text-xs text-text-3" data-testid={`portal-pending-${portal.id}`}>
          {portal.pendingReason ?? "No renderer in this build, so it cannot be enabled yet."}
        </p>
      ) : null}

      {connection && portal.spec === "public" ? (
        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor={`feed-url-${portal.id}`}>Feed URL</Label>
          {issued ? (
            <IssuedFeedUrl
              portalId={portal.id}
              url={issuedUrl}
              notice={issued.notice}
              rotating={rotating}
              onRegenerate={regenerate}
              originNote={originNote}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <p
                id={`feed-url-${portal.id}`}
                className="min-w-0 flex-1 text-sm text-text-2"
                data-testid={`portal-feed-url-withheld-${portal.id}`}
              >
                {connection.hasToken
                  ? "Shown once, when the portal was enabled or the URL was last regenerated. Regenerate to issue a new one — the old one stops answering."
                  : "Enabling the portal mints its feed URL."}
              </p>
              {connection.hasToken ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={rotating || managementBlocked !== null}
                  title={managementBlocked ?? undefined}
                  onClick={regenerate}
                >
                  <RefreshCw className="size-4" />
                  Regenerate
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {portal.spec === "public" ? (
        <div className="mt-3 flex flex-col gap-1.5 text-sm" data-testid={`portal-status-${portal.id}`}>
          <p className="text-text-2">
            {summary.selected === 0
              ? "No listing is selected for this portal."
              : enabled
                ? `${summary.selected} selected · ${onSite} on the website · ${summary.inFeed} in the feed${
                    summary.excluded.length ? ` · ${summary.excluded.length} excluded` : ""
                  }`
                : // switched off, nothing is in any feed: say what WOULD be
                  `${summary.selected} selected · ${onSite} on the website · switched off (${summary.inFeed} would be in the feed)`}
          </p>
          {/* The user-agent is up to 200 characters chosen by the caller, not
              by us: one unbroken token would otherwise push the card past the
              viewport. */}
          {connection ? (
            <p className={`break-words ${TONE_CLASS[connection.health.tone]}`} data-testid={`portal-health-${portal.id}`}>
              {connection.health.headline}
              {connection.lastPulledAt ? (
                <span className="text-text-3">
                  {" "}
                  Feed URL last requested {formatDateTime(connection.lastPulledAt)}
                  {connection.lastPulledUa ? ` (reported as ${connection.lastPulledUa})` : ""}.
                </span>
              ) : null}
            </p>
          ) : (
            <p className="text-text-2">Not connected — enabling it mints the feed URL to give the portal.</p>
          )}
          <p className="text-xs text-text-3" data-testid={`portal-publication-${portal.id}`}>
            Publication not verified: {portal.name} does not tell the CRM which listings it accepted
            or published. {portal.publicationCheck}
          </p>
        </div>
      ) : null}

      {summary.excluded.length ? (
        <details className="mt-3 text-xs" data-testid={`portal-excluded-${portal.id}`} open={summary.inFeed === 0}>
          <summary className="cursor-pointer text-warning">
            {summary.excluded.length} selected listing{summary.excluded.length === 1 ? " is" : "s are"} on the
            website but not in this feed
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {summary.excluded.map((l) => (
              <li key={l.propertyId} className="min-w-0">
                <Link href={propertyHref(l.propertyId, null)} className="font-medium text-text-1 underline underline-offset-2">
                  {l.reference}
                </Link>{" "}
                <span className="text-text-3">{l.title}</span>
                <ul className="mt-0.5 list-disc pl-5 text-text-2">
                  {l.reasons.map((reason) => (
                    <li key={reason.text}>
                      {reason.text}{" "}
                      {reason.fixTab ? (
                        <Link
                          href={propertyHref(l.propertyId, reason.fixTab)}
                          className="text-brand underline underline-offset-2"
                        >
                          Fix
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {summary.offSite.length ? (
        <details className="mt-2 text-xs text-text-3" data-testid={`portal-offsite-${portal.id}`}>
          <summary className="cursor-pointer">
            {summary.offSite.length} selected listing{summary.offSite.length === 1 ? " has" : "s have"} left the
            website (sold, withdrawn or private) and {summary.offSite.length === 1 ? "is" : "are"} not sent
          </summary>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {summary.offSite.map((l) => (
              <li key={l.propertyId}>
                <Link href={propertyHref(l.propertyId, null)} className="underline underline-offset-2">
                  {l.reference}
                </Link>{" "}
                ({l.status.replace(/_/g, " ")}
                {l.visibility !== "public" ? `, ${l.visibility.replace(/_/g, " ")}` : ""})
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {connection?.history.length ? (
        <details className="mt-2 text-xs text-text-3" data-testid={`portal-history-${portal.id}`}>
          <summary className="cursor-pointer">Recent requests to the feed URL</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {connection.history.map((run) => (
              <li key={`${run.firstAt}-${run.lastAt}`} className={`break-words ${run.failed ? "text-danger" : ""}`}>
                {formatDateTime(run.lastAt)}
                {run.hits > 1 ? ` (×${run.hits} since ${formatDateTime(run.firstAt)})` : ""} — {run.text}
                {run.ua ? <span className="text-text-3"> · {run.ua}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Only for a portal this build can write: naming the bar a listing must
          clear implies that clearing it puts the listing in the feed, which
          is not true while there is no renderer. */}
      {portal.spec === "public" ? (
        <>
          <p className="mt-3 text-xs text-text-3">Each listing needs, to go into this feed:</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-text-3">
            <li>
              at least {portal.requirements.minPhotos} photo
              {portal.requirements.minPhotos === 1 ? "" : "s"} with a JPEG rendition
              {portal.requirements.minImage
                ? `, each at least ${portal.requirements.minImage.width}×${portal.requirements.minImage.height} px`
                : ""}
            </li>
            <li>an English public description</li>
            <li>
              {acceptedCurrencies ? `a price in ${listOr(acceptedCurrencies)}` : "a price"} above zero
            </li>
            <li>a property type this portal has a category for</li>
            <li>a district or area name</li>
            {portal.requirements.needsCoords ? <li>map coordinates</li> : null}
            <li>languages carried: {portal.requirements.languages.join(", ")}</li>
          </ul>
          <p className="mt-1 text-xs text-text-3">
            Meeting these puts a listing in the feed; the portal&apos;s own review may still refuse it.
            Sale-and-rent listings go out as a sale only.
          </p>
        </>
      ) : null}

      {portal.settingsFields.length ? (
        // onSubmit inside a transition, not `action={formAction}`: React 19
        // resets a form after every action passed as its `action`, refusals
        // included, so a refused save would wipe what was typed (the 0141
        // price-uplift form's pattern)
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            startTransition(() => formAction(fd));
          }}
          className="mt-4 flex flex-col gap-3"
        >
          <input type="hidden" name="portal" value={portal.id} />
          <div className="flex flex-wrap gap-3">
            {portal.settingsFields.map((f) => {
              const required = portal.requiredSettings.includes(f.key);
              return (
                <div key={f.key} className="flex min-w-48 flex-1 flex-col gap-1.5">
                  <Label htmlFor={`${portal.id}-${f.key}`}>
                    {f.label}
                    {required ? (
                      <>
                        <span aria-hidden="true">*</span>
                        <span className="sr-only">(required before enabling)</span>
                      </>
                    ) : null}
                  </Label>
                  <Input
                    id={`${portal.id}-${f.key}`}
                    name={f.key}
                    defaultValue={connection?.settings[f.key] ?? ""}
                    placeholder={f.placeholder}
                    className="h-9"
                  />
                </div>
              );
            })}
          </div>
          <div>
            <Button type="submit" size="sm" disabled={saving || managementBlocked !== null}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
