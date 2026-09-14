"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getCurrentProfile, type CurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { DIALECT_RENDERERS } from "@/lib/services/portals/dialects";
import { portalById } from "@/lib/services/portals/registry";
import { createClient } from "@/lib/supabase/server";
import { portalIdSchema, portalSettingsForm } from "@/lib/validators/portals";

/**
 * Portal syndication actions (spec 2026-09-14 §Settings, §Property page).
 *
 * Connection changes are admin-only here AND by 0095's policies; selection is
 * whoever may edit the listing, likewise twice. Every write checks the row
 * count — an RLS-filtered zero-row write must never report success or log
 * an event — and every success is an event.
 *
 * THE TOKEN IS THE DATABASE'S TO MINT. `portal_connections.feed_token`
 * defaults to 32 random bytes, so an INSERT never names it: an upsert that
 * carried one would hand every enable/disable toggle a NEW feed URL and point
 * the portal at a dead one. `newToken()` exists for regeneration and for
 * nothing else, which is why enable/disable is an explicit
 * insert-if-absent-else-update rather than one `.upsert()`.
 */

export type PortalActionState = { error: string | null; savedAt: number | null };

const ok = (): PortalActionState => ({ error: null, savedAt: Date.now() });
const fail = (error: string): PortalActionState => ({ error, savedAt: null });

const PORTAL_SETTINGS_PATH = "/settings/portals";

type Session = { supabase: Awaited<ReturnType<typeof createClient>>; profile: CurrentProfile };

async function session(): Promise<Session> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  return { supabase, profile };
}

async function requireAdmin(): Promise<Session | { denied: string }> {
  const s = await session();
  if (s.profile.role !== "admin") return { denied: "Admins only." };
  return s;
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}

/** `settings` is jsonb, so anything could be in the column; only an object has keys. */
function asSettings(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/* ---------------- the connection (Settings → Portals, admin only) ---------------- */

export async function setPortalEnabled(
  portalId: string,
  enabled: boolean,
): Promise<PortalActionState> {
  const id = portalIdSchema.safeParse(portalId);
  if (!id.success) return fail("Unknown portal.");
  const def = portalById(id.data)!;

  const gate = await requireAdmin();
  if ("denied" in gate) return fail(gate.denied);
  const { supabase, profile } = gate;

  // Both refusals are decided before a single round trip: a portal whose feed
  // this build cannot write would otherwise sit enabled, serving the empty
  // document to a crawler that reads absence as "withdraw everything".
  if (enabled && (def.spec === "pending" || !DIALECT_RENDERERS[def.dialect])) {
    return fail(`${def.name} cannot be enabled yet: its feed format is not available to the CRM.`);
  }

  // One read, two jobs: the settings the enable gate needs, and whether there
  // is a row to update at all.
  const { data: existing, error: readError } = await supabase
    .from("portal_connections")
    .select("id, settings")
    .eq("portal", id.data)
    .maybeSingle();
  if (readError) return fail(readError.message);

  if (enabled && def.requiredSettings.length) {
    const settings = asSettings(existing?.settings);
    const missing = def.requiredSettings.filter((key) => !String(settings[key] ?? "").trim());
    if (missing.length) return fail(`Fill in ${missing.join(", ")} before enabling ${def.name}.`);
  }

  // Disabling a portal that was never connected is already true. Inserting a
  // disabled row would mint a feed token nobody asked for, and the
  // `portal_disabled` event would put a line on the organisation's timeline
  // for a portal that was never enabled — an entry in an append-only log
  // describing something that did not happen.
  if (!existing && !enabled) return ok();

  const { data: written, error } = existing
    ? await supabase
        .from("portal_connections")
        .update({ enabled, updated_by: profile.id })
        .eq("id", existing.id)
        .select("id")
    : await supabase
        .from("portal_connections")
        .insert({ org_id: profile.orgId, portal: id.data, enabled, updated_by: profile.id })
        .select("id");
  if (error) return fail(error.message);
  if (!written?.length) return fail("Nothing changed — your role may not manage portals.");

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "organization",
    entityId: profile.orgId,
    eventType: enabled ? "portal_enabled" : "portal_disabled",
    payload: { portal: id.data },
  });
  revalidatePath(PORTAL_SETTINGS_PATH);
  return ok();
}

export async function savePortalSettings(
  _prev: PortalActionState,
  formData: FormData,
): Promise<PortalActionState> {
  const parsed = portalSettingsForm(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error);
  const { portal, settings } = parsed.data;

  const gate = await requireAdmin();
  if ("denied" in gate) return fail(gate.denied);
  const { supabase, profile } = gate;

  const { data: existing, error: readError } = await supabase
    .from("portal_connections")
    .select("id")
    .eq("portal", portal)
    .maybeSingle();
  if (readError) return fail(readError.message);

  // Filling in the contact details before the portal is switched on is the
  // ordinary order of work, so this creates the row (disabled) when absent —
  // again without naming feed_token.
  const { data: written, error } = existing
    ? await supabase
        .from("portal_connections")
        .update({ settings, updated_by: profile.id })
        .eq("id", existing.id)
        .select("id")
    : await supabase
        .from("portal_connections")
        .insert({ org_id: profile.orgId, portal, settings, updated_by: profile.id })
        .select("id");
  if (error) return fail(error.message);
  if (!written?.length) return fail("Nothing saved — your role may not manage portals.");

  // The keys, never the values: a contact e-mail is a mutable row, not a line
  // in a hash-chained log that erasure cannot reach.
  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "organization",
    entityId: profile.orgId,
    eventType: "portal_settings_updated",
    payload: { portal, keys: Object.keys(settings) },
  });
  revalidatePath(PORTAL_SETTINGS_PATH);
  return ok();
}

export async function regeneratePortalToken(portalId: string): Promise<PortalActionState> {
  const id = portalIdSchema.safeParse(portalId);
  if (!id.success) return fail("Unknown portal.");

  const gate = await requireAdmin();
  if ("denied" in gate) return fail(gate.denied);
  const { supabase, profile } = gate;

  // The one place a token is minted in the app. No insert branch: rotating a
  // connection that does not exist would only mean creating one, and the
  // database's own default already does that better.
  const { data: written, error } = await supabase
    .from("portal_connections")
    .update({ feed_token: newToken(), updated_by: profile.id })
    .eq("portal", id.data)
    .select("id");
  if (error) return fail(error.message);
  if (!written?.length) return fail("No connection to rotate — enable the portal first.");

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "organization",
    entityId: profile.orgId,
    eventType: "portal_token_regenerated",
    payload: { portal: id.data },
  });
  revalidatePath(PORTAL_SETTINGS_PATH);
  return ok();
}

/* ---------------- the selection (property page, whoever may edit it) ---------------- */

/**
 * No role gate here, deliberately: 0095's insert policy is the properties_update
 * rule verbatim, so an agent may put THEIR OWN listing on a portal and a
 * second-guessing check in the app would either duplicate it or diverge from
 * it. The action's job is to read what the policy did — 42501 when it refused,
 * zero rows if it ever refuses silently — and never to claim more.
 */
export async function selectPortal(
  propertyId: string,
  portalId: string,
): Promise<PortalActionState> {
  const id = portalIdSchema.safeParse(portalId);
  if (!id.success) return fail("Unknown portal.");
  const { supabase, profile } = await session();

  const { data: listing, error: listingError } = await supabase
    .from("properties")
    .select("id, reference, org_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (listingError) return fail(listingError.message);
  if (!listing) return fail("Listing not found.");

  const { data: connection, error: connectionError } = await supabase
    .from("portal_connections")
    .select("enabled")
    .eq("portal", id.data)
    .maybeSingle();
  if (connectionError) return fail(connectionError.message);
  if (!connection?.enabled) {
    return fail("That portal is not enabled — an admin enables it under Settings → Portals.");
  }

  const { data: written, error } = await supabase
    .from("portal_listings")
    .insert({
      org_id: listing.org_id,
      property_id: propertyId,
      portal: id.data,
      selected_by: profile.id,
    })
    .select("portal");
  if (error) {
    // (property_id, portal) is the primary key: someone already selected it,
    // so the desk's intent is met. Not an error, and not a second event — the
    // first selection's event is the one that happened.
    if (error.code === "23505") {
      // already selected, but the page may be stale
      revalidatePath(`/properties/${propertyId}`);
      return ok();
    }
    if (error.code === "42501") return fail("Your role cannot put this listing on a portal.");
    return fail(error.message);
  }
  if (!written?.length) {
    return fail("Nothing changed — your role may not put this listing on a portal.");
  }

  // The org of the RECORD, not of the reader. They are the same today — RLS
  // saw to that on the way in — but an event is a fact about the listing, and
  // taking its tenant from whoever happened to be looking is the defect class
  // this codebase keeps re-growing.
  await logEvent(supabase, {
    orgId: listing.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "portal_selected",
    payload: { portal: id.data, reference: listing.reference },
  });
  revalidatePath(`/properties/${propertyId}`);
  return ok();
}

export async function deselectPortal(
  propertyId: string,
  portalId: string,
): Promise<PortalActionState> {
  const id = portalIdSchema.safeParse(portalId);
  if (!id.success) return fail("Unknown portal.");
  const { supabase, profile } = await session();

  const { data: listing, error: listingError } = await supabase
    .from("properties")
    .select("id, reference, org_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (listingError) return fail(listingError.message);
  if (!listing) return fail("Listing not found.");

  // Deselecting deletes the row (0095): the events chain is the history, so
  // the returned row is the only proof the delete reached anything.
  const { data: removed, error } = await supabase
    .from("portal_listings")
    .delete()
    .eq("property_id", propertyId)
    .eq("portal", id.data)
    .select("portal");
  if (error) return fail(error.message);
  if (!removed?.length) {
    return fail("Nothing changed — it was not selected, or your role may not change it.");
  }

  await logEvent(supabase, {
    // the org of the record, as above
    orgId: listing.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "portal_removed",
    payload: { portal: id.data, reference: listing.reference },
  });
  revalidatePath(`/properties/${propertyId}`);
  return ok();
}
