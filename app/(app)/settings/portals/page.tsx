import { ShieldAlert } from "lucide-react";
import { PortalCard, type PortalCardConnection } from "@/components/features/settings/portal-card";
import { getCurrentProfile } from "@/lib/services/auth";
import { toPortalCardDefinition } from "@/lib/services/portals/card-definition";
import { DIALECT_CURRENCIES } from "@/lib/services/portals/dialects";
import { PORTALS } from "@/lib/services/portals/registry";
import type { Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

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

  // A failed read must not fall through to `rows ?? []`: that renders every
  // portal as "Not connected", which is the reassuring direction and the wrong
  // one — an admin would enable a portal that is already enabled, and the
  // organisation's timeline would carry a `portal_enabled` event for a change
  // that did not happen.
  const { data: rows, error } = await supabase
    .from("portal_connections")
    .select("portal, enabled, feed_token, settings, last_pulled_at, last_pulled_ua, last_pull_count");
  if (error) throw new Error(`portal connections: ${error.message}`);
  const byPortal = new Map((rows ?? []).map((r) => [r.portal, r]));

  // The JPEG backfill is what stands between a migrated database and an empty
  // feed: `portal_supplement` (0095) returns only photos that have a JPEG
  // rendition, `path_jpeg` is null on every row that predates the migration
  // until `scripts/media/backfill-jpeg.mts` runs, and a listing left with no
  // such photo fails `too_few_photos` — so the feed is the empty document,
  // which a pull portal reads as "remove everything". A count is the cheapest
  // honest signal; it is org-scoped by RLS like every read on this page, and
  // it fails like the read above for the same reason: a silent 0 is the
  // reassuring direction and the wrong one.
  const { count: unpreparedPhotos, error: photosError } = await supabase
    .from("property_media")
    .select("id", { count: "exact", head: true })
    .eq("kind", "photo")
    .is("path_jpeg", null);
  if (photosError) throw new Error(`portal photos: ${photosError.message}`);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-2">
        Where listings are advertised beyond the website. Enabling a portal gives it a feed URL to
        pull; nothing goes out until an agent ticks a listing for that portal on its Marketing tab.
        The website never depends on any of this. Every change here is an event.
      </p>
      {/* Same notice idiom as the invite form's 2FA warning (users-panel.tsx). */}
      {unpreparedPhotos ? (
        <p
          data-testid="portal-photos-unprepared"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-text-2"
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            {unpreparedPhotos} {unpreparedPhotos === 1 ? "photo is" : "photos are"} not yet prepared
            for portals — run <code>npm run media:backfill-jpeg</code> before giving any portal its
            feed URL; until then those photos are invisible to every portal.
          </span>
        </p>
      ) : null}
      {/* `toPortalCardDefinition`, never `def` itself: a registry entry carries
          `settingsSchema`, a zod object, and React refuses to serialise a class
          instance into a "use client" component — passing the whole definition
          put this page behind its error boundary, which the e2e caught. The
          schema is a server concern: `savePortalSettings` parses with it. */}
      {PORTALS.map((def) => {
        const r = byPortal.get(def.id);
        const connection: PortalCardConnection | null = r
          ? {
              enabled: r.enabled,
              // the path, not a full URL: the card builds the origin on the
              // client, so no NEXT_PUBLIC_APP_URL to keep in step with reality
              feedPath: `/api/portals/${def.id}/${r.feed_token}`,
              settings: settingsStrings(r.settings),
              lastPulledAt: r.last_pulled_at,
              lastPulledUa: r.last_pulled_ua,
              lastPullCount: r.last_pull_count,
            }
          : null;
        return (
          <PortalCard
            key={def.id}
            portal={toPortalCardDefinition(def)}
            connection={connection}
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
