"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
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
import type { PortalDefinition } from "@/lib/services/portals/registry";
import { formatDateTime } from "@/lib/utils/format";

/**
 * One portal on Settings → Portals (spec 2026-09-14 §Settings).
 *
 * The card shows the FEED PATH on the server and upgrades it to the full URL
 * once hydrated. The origin is the browser's, so there is no NEXT_PUBLIC_APP_URL
 * to fall out of step with where the CRM actually answers — and rendering the
 * path first is what keeps the first client render identical to the server's.
 *
 * A portal whose renderer this build does not have shows a badge instead of a
 * switch. `setPortalEnabled` refuses it too; the badge is so the desk is told
 * why rather than finding out by clicking.
 */

export interface PortalCardConnection {
  enabled: boolean;
  /** `/api/portals/<id>/<token>` — the origin is added on the client */
  feedPath: string;
  settings: Record<string, string>;
  lastPulledAt: string | null;
  lastPulledUa: string | null;
  lastPullCount: number | null;
}

const initialState: PortalActionState = { error: null, savedAt: null };

const COPIED_MS = 1500;

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

export function PortalCard({
  portal,
  connection,
}: {
  portal: PortalDefinition;
  connection: PortalCardConnection | null;
}) {
  const enabled = connection?.enabled ?? false;
  const [toggling, startToggle] = useTransition();
  const [rotating, startRotate] = useTransition();
  const [copied, setCopied] = useState(false);

  // The server renders the path; the client swaps in the origin once hydrated.
  const origin = useSyncExternalStore(subscribeToNothing, readOrigin, noOrigin);
  const feedUrl = connection ? `${origin}${connection.feedPath}` : "";

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
      else toast.success(`${portal.name} enabled`);
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
      else toast.success("New feed URL minted — give it to the portal");
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
          <Badge variant="secondary">not available in this build — cannot be enabled yet</Badge>
        ) : (
          <Button
            type="button"
            variant={enabled ? "secondary" : "default"}
            size="sm"
            aria-pressed={enabled}
            data-testid={`portal-toggle-${portal.id}`}
            disabled={toggling}
            onClick={toggle}
          >
            {toggling ? "Working…" : enabled ? "Disable" : "Enable"}
          </Button>
        )}
      </div>

      {connection && portal.spec === "public" ? (
        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor={`feed-url-${portal.id}`}>Feed URL</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={`feed-url-${portal.id}`}
              data-testid={`portal-feed-url-${portal.id}`}
              readOnly
              value={origin ? feedUrl : connection.feedPath}
              className="h-9 min-w-0 flex-1 font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Copy feed URL"
              onClick={async () => {
                await navigator.clipboard.writeText(feedUrl || connection.feedPath);
                setCopied(true);
                setTimeout(() => setCopied(false), COPIED_MS);
              }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Regenerate feed URL"
              disabled={rotating}
              onClick={regenerate}
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {portal.spec === "public" ? (
        <p className="mt-3 text-sm text-text-2">
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

      <ul className="mt-3 list-disc pl-5 text-xs text-text-3">
        <li>
          at least {portal.requirements.minPhotos} photo
          {portal.requirements.minPhotos === 1 ? "" : "s"} with a JPEG rendition
        </li>
        <li>an English public description and a price</li>
        {portal.requirements.needsCoords ? <li>map coordinates</li> : null}
        <li>languages carried: {portal.requirements.languages.join(", ")}</li>
      </ul>

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
