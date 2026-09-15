"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
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
import { formatDateTime } from "@/lib/utils/format";

/**
 * One portal on Settings → Portals (spec 2026-09-14 §Settings).
 *
 * THE FEED URL IS SHOWN ONCE (0097). The database holds only the token's
 * digest, so the server can say that a URL exists and never what it is; the
 * plaintext arrives in the return value of the action that minted it (the
 * first enable, or Regenerate) and lives in this card's state until the page
 * is left. The origin is the browser's, so there is no NEXT_PUBLIC_APP_URL to
 * fall out of step with where the CRM actually answers.
 *
 * A portal whose renderer this build does not have shows a badge instead of a
 * switch. `setPortalEnabled` refuses it too; the badge is so the desk is told
 * why rather than finding out by clicking.
 */

export interface PortalCardConnection {
  enabled: boolean;
  /** Whether a feed URL exists. Its token is never stored, so it is shown only when issued. */
  hasToken: boolean;
  settings: Record<string, string>;
  lastPulledAt: string | null;
  lastPulledUa: string | null;
  lastPullCount: number | null;
}

const initialState: PortalActionState = { error: null, savedAt: null };

/**
 * The origin, read as what it is: a value owned by the browser and absent on
 * the server. `useSyncExternalStore` gives the server pass `""` and the client
 * the real origin AFTER hydration, so the two first renders agree — an effect
 * that called setState on mount would say the same thing but the React
 * Compiler lint refuses it (cascading renders), and reading `window` during
 * render would mismatch. It never changes for the life of the page, so the
 * subscription is a no-op.
 */
const subscribeToNothing = () => () => {};
const readOrigin = () => window.location.origin;
const noOrigin = () => "";

/** "EUR", "EUR or GBP", "EUR, GBP or USD" */
function listOr(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

export function PortalCard({
  portal,
  connection,
  acceptedCurrencies,
}: {
  /**
   * The registry entry's plain-data projection, NOT the entry: its
   * `settingsSchema` is a zod object and React will not serialise a class
   * instance across the RSC boundary. See `card-definition.ts`.
   */
  portal: PortalCardDefinition;
  connection: PortalCardConnection | null;
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
  // The token this card was handed by the action that minted it, if any. Set
  // only after a client action, so the origin is always known by then.
  const [issued, setIssued] = useState<string | null>(null);
  const issuedUrl = issued ? `${origin}/api/portals/${portal.id}/${issued}` : "";

  // `setPortalEnabled` refuses an enable while a required setting is blank.
  // Saying so here — and declining to send the click — is what makes the
  // asterisk on the field an honest mark rather than decoration. Every portal
  // in this build has `requiredSettings: []`, so nothing reaches it yet.
  const missingRequired = portal.requiredSettings.filter(
    (k) => !(connection?.settings[k] ?? "").trim(),
  );
  const blockedByMissing = !enabled && missingRequired.length > 0;

  const [state, formAction, saving] = useActionState(savePortalSettings, initialState);
  // Two saves inside one millisecond would share a `savedAt` and the second
  // would pass unannounced — the house pattern, accepted.
  const lastSaved = useRef<number | null>(null);
  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastSaved.current) {
      lastSaved.current = state.savedAt;
      toast.success(`${portal.name} settings saved`);
    }
  }, [state.savedAt, portal.name]);
  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state.error]);

  const toggle = () => {
    startToggle(async () => {
      const r = await setPortalEnabled(portal.id, !enabled);
      if (r.error) toast.error(r.error);
      else if (enabled) toast.success(`${portal.name} disabled — its feed now empties`);
      else if (r.token) {
        setIssued(r.token);
        toast.success(`${portal.name} enabled — copy the feed URL now, it is shown once`);
      } else toast.success(`${portal.name} enabled`);
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
      if (r.error) toast.error(r.error);
      else {
        if (r.token) setIssued(r.token);
        toast.success("New feed URL minted — copy it now and give it to the portal; it is shown once");
      }
    });
  };

  return (
    <section
      className="rounded-[10px] border border-border bg-surface p-5"
      data-testid={`portal-card-${portal.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-1">{portal.name}</h2>
          <p className="mt-1 text-sm text-text-2">{portal.audience}</p>
          <p className="mt-1 text-xs text-text-3">
            Format: {portal.dialect} · pulls {portal.pullCadence} ·{" "}
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
              disabled={toggling || blockedByMissing}
              title={blockedByMissing ? `Fill in ${missingRequired.join(", ")} first` : undefined}
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
        <p className="mt-2 text-xs text-text-3">
          No renderer in this build, so it cannot be enabled yet.
        </p>
      ) : null}

      {connection && portal.spec === "public" ? (
        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor={`feed-url-${portal.id}`}>Feed URL</Label>
          {issued ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={`feed-url-${portal.id}`}
                  data-testid={`portal-feed-url-${portal.id}`}
                  readOnly
                  value={issuedUrl}
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
                      await navigator.clipboard.writeText(issuedUrl);
                      toast.success("Feed URL copied");
                    } catch {
                      toast.error("Could not copy — select the field and copy it by hand");
                    }
                  }}
                >
                  <Copy className="size-4" />
                  Copy
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={rotating}
                  onClick={regenerate}
                >
                  <RefreshCw className="size-4" />
                  Regenerate
                </Button>
              </div>
              <p className="text-xs text-warning" data-testid={`portal-feed-url-once-${portal.id}`}>
                Copy it now — it is shown once. The CRM keeps only a fingerprint of it; leave this
                page and the URL is gone until you regenerate.
              </p>
            </>
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
                  disabled={rotating}
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
        // The user-agent is up to 200 characters chosen by the crawler, not by
        // us: one unbroken token would otherwise push the card past the viewport.
        <p className="mt-3 text-sm break-words text-text-2">
          {connection ? (
            <>
              {enabled
                ? "Answers the selected listings."
                : "Answers an empty document while disabled, so the portal clears its copy."}{" "}
              {connection.lastPulledAt
                ? `Last pulled ${formatDateTime(connection.lastPulledAt)} by ${
                    connection.lastPulledUa || "an unnamed crawler"
                  } — ${connection.lastPullCount ?? 0} listings.`
                : "Never pulled yet."}
            </>
          ) : (
            "Not connected — enabling it mints the feed URL to give the portal."
          )}
        </p>
      ) : null}

      {/* Only for a portal this build can write: naming the bar a listing must
          clear implies that clearing it puts the listing on the portal, which
          is not true while there is no renderer. */}
      {portal.spec === "public" ? (
        <>
          <p className="mt-3 text-xs text-text-3">Each listing needs:</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-text-3">
            <li>
              at least {portal.requirements.minPhotos} photo
              {portal.requirements.minPhotos === 1 ? "" : "s"} with a JPEG rendition
            </li>
            <li>an English public description</li>
            <li>
              {acceptedCurrencies ? `a price in ${listOr(acceptedCurrencies)}` : "a price"}
            </li>
            {portal.requirements.needsCoords ? <li>map coordinates</li> : null}
            <li>languages carried: {portal.requirements.languages.join(", ")}</li>
          </ul>
        </>
      ) : null}

      {portal.settingsFields.length ? (
        <form action={formAction} className="mt-4 flex flex-col gap-3">
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
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
