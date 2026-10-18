import { ShieldAlert } from "lucide-react";
import {
  PortalCard,
  type PortalCardConnection,
  type PortalCardRun,
} from "@/components/features/settings/portal-card";
import { getCurrentProfile } from "@/lib/services/auth";
import { toPortalCardDefinition } from "@/lib/services/portals/card-definition";
import { DIALECT_CURRENCIES } from "@/lib/services/portals/dialects";
import { deploymentKind, feedTokenIssuance, portalFeedOrigin } from "@/lib/services/portals/feed-origin";
import { pullHealth, pullRunText } from "@/lib/services/portals/pull-health";
import { PORTALS } from "@/lib/services/portals/registry";
import { buildPortalSelectionSummary } from "@/lib/services/portals/selection-summary";
import { publicSiteOrigin } from "@/lib/services/portals/site-url";
import type { Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { unwrapCount, unwrapRows } from "@/lib/supabase/unwrap";

export const dynamic = "force-dynamic";

/** Runs of the pull history shown per portal (0150 keeps 50). */
const HISTORY_RUNS = 8;

/**
 * `portal_connections.settings` is `jsonb`, so the column's type is `Json`: it
 * could hold a string, a number or an array, and even an object's values could
 * be anything. The card renders these into text inputs, so keep the
 * string-valued keys and drop the rest rather than casting a `Json` to
 * `Record<string, string>` and letting a number reach `defaultValue`.
 */
function settingsStrings(value: Json | null | undefined): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

export default async function PortalsSettingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // pages render in parallel with the layout's admin gate — stop here too
  if (profile.role !== "admin") return null;

  // A failed read must not fall through to an empty list: that renders every
  // portal as "Not connected", which is the reassuring direction and the wrong
  // one. A hollow answer is a failure too (unwrapRows).
  const rows = unwrapRows(
    await supabase
      .from("portal_connections")
      .select(
        "id, portal, enabled, feed_token_sha256, settings, last_pulled_at, last_pulled_ua, last_pull_count, last_pull_outcome, last_success_at, last_error_at, last_error_reason",
      ),
    "portal connections",
  );
  const byPortal = new Map(rows.map((r) => [r.portal, r]));

  // The pull history, newest first. 0150 keeps at most 50 runs per connection
  // and an org has at most one connection per portal, so the whole history is
  // ≤ 50 × PORTALS.length rows — read all of it, so a quiet portal's runs are
  // never crowded out by a busy one's.
  const runs = unwrapRows(
    await supabase
      .from("portal_pull_log")
      .select("connection_id, first_at, last_at, hits, outcome, served, selected, excluded, reason, ua")
      .order("last_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(50 * PORTALS.length),
    "portal pull history",
  );

  // Every selected listing, per portal: in the feed, excluded (with why), or
  // gone from the website on purpose.
  const summaries = await buildPortalSelectionSummary(supabase);

  // The JPEG backfill stands between a migrated database and photos a portal
  // can receive: portal_feed_supplement returns only photos that have a JPEG
  // rendition. A count is the cheapest honest signal, and it fails like the
  // reads above — a hollow HEAD answer is not a zero (unwrapCount).
  const unpreparedPhotos = unwrapCount(
    await supabase
      .from("property_media")
      .select("id", { count: "exact", head: true })
      .eq("kind", "photo")
      .is("path_jpeg", null),
    "portal photos",
  );

  const feedOrigin = portalFeedOrigin();
  const kind = deploymentKind();
  const issuance = feedTokenIssuance();
  const now = new Date();
  const siteOrigin = publicSiteOrigin();

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-2">
        Where listings can be offered beyond the website. Enabling a portal gives it a feed URL to
        request; a listing goes into that feed only once an agent selects it on its Marketing tab
        and it meets the portal&apos;s requirements. What the portal then publishes is its own
        decision, and it does not report back to the CRM. The website never depends on any of
        this. Every change here is an event.
      </p>
      {kind !== "production" ? (
        <p
          data-testid="portal-environment-note"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-text-2"
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            {issuance.allowed
              ? `This is not the production CRM, so a feed URL issued here ${feedOrigin ? `points to ${feedOrigin}` : "uses this machine's address"} — never give it to a portal.`
              : issuance.reason}
          </span>
        </p>
      ) : null}
      {/* Same notice idiom as the invite form's 2FA warning (users-panel.tsx). */}
      {unpreparedPhotos ? (
        <p
          data-testid="portal-photos-unprepared"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-text-2"
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            {unpreparedPhotos} {unpreparedPhotos === 1 ? "photo is" : "photos are"} not yet prepared
            for portals — run <code>npm run media:backfill-jpeg</code>; until then those photos are
            invisible to every portal, and a listing they leave short of its portal&apos;s photo
            minimum drops out of that feed.
          </span>
        </p>
      ) : null}
      {siteOrigin ? null : (
        <p className="text-xs text-text-3" data-testid="portal-site-url-unset">
          Listings go out without a link to their page on the website: set PUBLIC_SITE_URL to
          include one.
        </p>
      )}
      {/* `toPortalCardDefinition`, never `def` itself: a registry entry carries
          zod schemas, and React refuses to serialise a class instance into a
          "use client" component. */}
      {PORTALS.map((def) => {
        const r = byPortal.get(def.id);
        const summary = summaries.get(def.id) ?? { selected: 0, inFeed: 0, excluded: [], offSite: [] };
        const connection: PortalCardConnection | null = r
          ? {
              enabled: r.enabled,
              // 0097: the row holds only the token's digest, so the page can
              // say THAT a feed URL exists and never what it is
              hasToken: r.feed_token_sha256 !== null,
              settings: settingsStrings(r.settings),
              lastPulledAt: r.last_pulled_at,
              lastPulledUa: r.last_pulled_ua,
              lastPullCount: r.last_pull_count,
              health: pullHealth(
                def,
                {
                  enabled: r.enabled,
                  hasToken: r.feed_token_sha256 !== null,
                  lastPulledAt: r.last_pulled_at,
                  lastPulledUa: r.last_pulled_ua,
                  lastPullCount: r.last_pull_count,
                  lastPullOutcome: r.last_pull_outcome,
                  lastSuccessAt: r.last_success_at,
                  lastErrorAt: r.last_error_at,
                  lastErrorReason: r.last_error_reason,
                },
                summary.selected,
                now,
              ),
              lastErrorAt: r.last_error_at,
              history: runs
                .filter((run) => run.connection_id === r.id)
                .slice(0, HISTORY_RUNS)
                .map(
                  (run): PortalCardRun => ({
                    firstAt: run.first_at,
                    lastAt: run.last_at,
                    hits: run.hits,
                    text: pullRunText(run),
                    failed: run.outcome === "failed",
                    ua: run.ua,
                  }),
                ),
            }
          : null;
        return (
          <PortalCard
            key={def.id}
            portal={toPortalCardDefinition(def)}
            connection={connection}
            summary={summary}
            feedOrigin={feedOrigin}
            managementBlocked={issuance.allowed ? null : issuance.reason}
            // resolved here, not in the card: the `dialects` barrel also
            // exports `DIALECT_RENDERERS`, so importing it from a "use client"
            // file would pull the Kyero renderer into the browser bundle
            acceptedCurrencies={DIALECT_CURRENCIES[def.dialect]}
          />
        );
      })}
    </div>
  );
}
