import { PortalCard, type PortalCardConnection } from "@/components/features/settings/portal-card";
import { getCurrentProfile } from "@/lib/services/auth";
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

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-2">
        Where listings are advertised beyond the website. Enabling a portal gives it a feed URL to
        pull; nothing goes out until an agent ticks a listing for that portal on its Marketing tab.
        The website never depends on any of this. Every change here is an event.
      </p>
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
        return <PortalCard key={def.id} portal={def} connection={connection} />;
      })}
    </div>
  );
}
