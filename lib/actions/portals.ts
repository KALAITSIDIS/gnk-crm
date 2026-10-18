"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile, type CurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { eventNotice, eventRefused } from "@/lib/services/one-time-secrets";
import { DIALECT_RENDERERS } from "@/lib/services/portals/dialects";
import { eligibilityFor, reasonText } from "@/lib/services/portals/eligibility";
import { feedTokenIssuance } from "@/lib/services/portals/feed-origin";
import {
  PORTAL_PROPERTY_COLUMNS,
  portalEligibilityInput,
  type PortalMediaRow,
  type PortalPropertyRow,
} from "@/lib/services/portals/property-portals";
import { portalById } from "@/lib/services/portals/registry";
import { hashPortalToken, mintPortalToken } from "@/lib/services/portals/token";
import { certainlyRolledBack } from "@/lib/services/rpc-outcome";
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
 * THE TOKEN IS MINTED HERE AND STORED AS A DIGEST (0097). The row holds
 * `feed_token_sha256`; the plaintext exists only in the action's return value
 * (`token`), which the card shows once. It is minted in exactly three places:
 * the first enable (the INSERT), an enable of a row that has no token yet
 * (contact details were saved before the switch), and Regenerate. A toggle of
 * a row that has its token never touches it.
 *
 * WHAT A WRITE'S ANSWER PROVES (portal integrations audit 2026-10-18,
 * finding 4). A non-empty RETURNING is a commit. An empty one, or an error
 * whose code certainly rolled back (rpc-outcome.ts), is a refusal. Anything
 * else — no code, a gateway body, a code that can follow a commit, an answer
 * with no rows array — is UNKNOWN: the write may have landed. Then:
 *   - a token write is RECONCILED by reading the stored digest back — the
 *     column is unique, so finding this token's digest proves this attempt
 *     committed, and the URL is shown; not finding it (or not being able to
 *     ask) shows NO URL and says to regenerate, because an unconfirmed URL
 *     handed to a portal may be dead and the old one may already be;
 *   - any other write says it could not be confirmed and asks for a reload,
 *     and writes no timeline line — an unproven fact does not go into an
 *     append-only chain.
 * A committed write whose timeline line then fails is reported with a
 * notice, never thrown (T-one-time-secrets): the page still refreshes, and
 * the desk is not told that a change which happened did not.
 *
 * WHERE CONNECTIONS ARE MANAGED (finding 8). A preview deployment refuses
 * every connection write before reading anything (feed-origin.ts): a URL
 * minted there is shown once and points nowhere a portal should go, and a
 * preview that shares production's database would otherwise rotate the
 * production URL.
 */

export type PortalActionState = {
  error: string | null;
  savedAt: number | null;
  /** The plaintext feed token, present only on the call that minted it AND confirmed it stored. Shown once. */
  token?: string | null;
  /**
   * The connection's write committed but its timeline line could not be
   * written or confirmed (T-one-time-secrets). The card shows it beside the
   * feed URL and toasts it; the token, if any, is still shown.
   */
  notice?: string | null;
  /**
   * A token write whose outcome could not be confirmed: the card must stop
   * showing any URL it issued earlier in the session — the stored token may
   * have changed under it.
   */
  discardIssued?: boolean;
};

const ok = (notice: string | null = null): PortalActionState => ({ error: null, savedAt: Date.now(), notice });
const okWithToken = (token: string, notice: string | null = null): PortalActionState => ({
  error: null,
  savedAt: Date.now(),
  token,
  notice,
});
/** A refusal always carries words: an empty error reads as success in both cards. */
const fail = (error: string | null | undefined, discardIssued = false): PortalActionState => ({
  error: error?.trim() ? error : "The database did not answer clearly — reload to see whether the change was made.",
  savedAt: null,
  ...(discardIssued ? { discardIssued: true } : {}),
});

const UNCONFIRMED_SAVE =
  "The database did not answer clearly, so this change could not be confirmed. Reload to see whether it was saved.";
const ROTATION_UNCONFIRMED =
  "The new feed URL could not be confirmed, and the old one may already have stopped answering. Regenerate to issue a URL you can give the portal.";
const ENABLE_UNCONFIRMED =
  "Enabling could not be confirmed. Reload: if the portal shows as enabled, use Regenerate to issue its feed URL.";

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

type WriteAnswer = { data: unknown; error: { code?: unknown; message?: string } | null };
type WriteOutcome = { kind: "committed" } | { kind: "refused"; message: string | null } | { kind: "unknown" };

/** What a write's answer proves — see the header. */
function classifyWrite(res: WriteAnswer): WriteOutcome {
  if (res.error) {
    // an empty message is no words at all: the caller's own refusal sentence applies
    const message = typeof res.error.message === "string" && res.error.message.trim() ? res.error.message : null;
    return certainlyRolledBack(res.error.code) ? { kind: "refused", message } : { kind: "unknown" };
  }
  if (!Array.isArray(res.data)) return { kind: "unknown" };
  return res.data.length ? { kind: "committed" } : { kind: "refused", message: null };
}

/**
 * A timeline line, written AFTER its write committed. A failure is reported,
 * never thrown (T-one-time-secrets): null when the line was written;
 * otherwise the notice that says it could not be recorded (refused) or
 * confirmed (unknown).
 */
async function recordLine(
  supabase: Session["supabase"],
  params: Parameters<typeof logEvent>[1],
): Promise<string | null> {
  try {
    await logEvent(supabase, params);
    return null;
  } catch (err) {
    console.error("[portals] change saved, its timeline line not written", {
      eventType: params.eventType,
      refused: eventRefused(err),
    });
    return eventNotice(err);
  }
}

/**
 * Read back whether the row holding this connection's digest is the one this
 * token hashes to — 0097's column is UNIQUE, so a hit proves this attempt
 * committed. "unknown" when the read itself did not answer clearly.
 */
async function tokenStored(
  supabase: Session["supabase"],
  portal: string,
  token: string,
): Promise<"stored" | "not_stored" | "unknown"> {
  const res = await supabase
    .from("portal_connections")
    .select("id")
    .eq("portal", portal)
    .eq("feed_token_sha256", hashPortalToken(token));
  if (res.error || !Array.isArray(res.data)) return "unknown";
  return res.data.length ? "stored" : "not_stored";
}

/** `settings` is jsonb, so anything could be in the column; only an object has keys. */
function asSettings(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The org's connection row for a portal, read as an array: [] is "none", a hollow answer is an error. */
async function readConnection(
  supabase: Session["supabase"],
  portal: string,
  columns: string,
): Promise<{ row: Record<string, unknown> | null } | { error: string }> {
  const res = await supabase.from("portal_connections").select(columns).eq("portal", portal);
  if (res.error) return { error: res.error.message || "The connection could not be read — reload and try again." };
  if (!Array.isArray(res.data)) return { error: "The connection could not be read — reload and try again." };
  return { row: (res.data[0] as unknown as Record<string, unknown> | undefined) ?? null };
}

/* ---------------- the connection (Settings → Portals, admin only) ---------------- */

export async function setPortalEnabled(
  portalId: string,
  enabled: boolean,
): Promise<PortalActionState> {
  const id = portalIdSchema.safeParse(portalId);
  if (!id.success) return fail("Unknown portal.");
  const def = portalById(id.data)!;

  const issuance = feedTokenIssuance();
  if (!issuance.allowed) return fail(issuance.reason);

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
  // is a row to update at all. Read as an array, so a hollow answer is an
  // error rather than "no row" — which, for a disable, would report a portal
  // switched off that is still serving.
  const read = await readConnection(supabase, id.data, "id, settings, feed_token_sha256");
  if ("error" in read) return fail(read.error);
  const existing = read.row as { id: string; settings: unknown; feed_token_sha256: string | null } | null;

  if (enabled && def.requiredSettings.length) {
    const settings = asSettings(existing?.settings);
    const missing = def.requiredSettings.filter((key) => !String(settings[key] ?? "").trim());
    if (missing.length) return fail(`Fill in ${missing.join(", ")} before enabling ${def.name}.`);
  }

  // Disabling a portal that was never connected is already true. Inserting a
  // disabled row would mint a feed token nobody asked for, and the
  // `portal_disabled` event would describe something that did not happen.
  if (!existing && !enabled) return ok();

  // The switch is where the URL is born (0097): a first enable mints, and so
  // does enabling a row that was created by saving contact details first. A
  // row that has its token keeps it through every later toggle.
  const token = !existing || (enabled && existing.feed_token_sha256 === null) ? mintPortalToken() : null;
  const digest = token ? { feed_token_sha256: hashPortalToken(token) } : {};

  const answer = existing
    ? await supabase
        .from("portal_connections")
        .update({ enabled, updated_by: profile.id, ...digest })
        .eq("id", existing.id)
        .select("id")
    : await supabase
        .from("portal_connections")
        .insert({ org_id: profile.orgId, portal: id.data, enabled, updated_by: profile.id, ...digest })
        .select("id");
  const outcome = classifyWrite(answer);
  if (outcome.kind === "refused") {
    return fail(outcome.message ?? "Nothing changed — your role may not manage portals.");
  }
  if (outcome.kind === "unknown") {
    revalidatePath(PORTAL_SETTINGS_PATH);
    if (!token) return fail(UNCONFIRMED_SAVE);
    // a minting write: committed only if the row now holds THIS token's digest
    if ((await tokenStored(supabase, id.data, token)) !== "stored") return fail(ENABLE_UNCONFIRMED, true);
  }

  // committed: a first enable's URL now exists only in `token`
  const notice = await recordLine(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "organization",
    entityId: profile.orgId,
    eventType: enabled ? "portal_enabled" : "portal_disabled",
    payload: { portal: id.data },
  });
  revalidatePath(PORTAL_SETTINGS_PATH);
  return token ? okWithToken(token, notice) : ok(notice);
}

export async function savePortalSettings(
  _prev: PortalActionState,
  formData: FormData,
): Promise<PortalActionState> {
  const parsed = portalSettingsForm(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error);
  const { portal, settings } = parsed.data;

  const issuance = feedTokenIssuance();
  if (!issuance.allowed) return fail(issuance.reason);

  const gate = await requireAdmin();
  if ("denied" in gate) return fail(gate.denied);
  const { supabase, profile } = gate;

  const read = await readConnection(supabase, portal, "id");
  if ("error" in read) return fail(read.error);
  const existing = read.row as { id: string } | null;

  // Filling in the contact details before the portal is switched on is the
  // ordinary order of work, so this creates the row (disabled) when absent —
  // again without naming feed_token_sha256.
  const answer = existing
    ? await supabase
        .from("portal_connections")
        .update({ settings, updated_by: profile.id })
        .eq("id", existing.id)
        .select("id")
    : await supabase
        .from("portal_connections")
        .insert({ org_id: profile.orgId, portal, settings, updated_by: profile.id })
        .select("id");
  const outcome = classifyWrite(answer);
  if (outcome.kind === "refused") return fail(outcome.message ?? "Nothing saved — your role may not manage portals.");
  if (outcome.kind === "unknown") {
    revalidatePath(PORTAL_SETTINGS_PATH);
    return fail(UNCONFIRMED_SAVE);
  }

  // The keys, never the values: a contact e-mail is a mutable row, not a line
  // in a hash-chained log that erasure cannot reach.
  const notice = await recordLine(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "organization",
    entityId: profile.orgId,
    eventType: "portal_settings_updated",
    payload: { portal, keys: Object.keys(settings) },
  });
  revalidatePath(PORTAL_SETTINGS_PATH);
  return ok(notice);
}

export async function regeneratePortalToken(portalId: string): Promise<PortalActionState> {
  const id = portalIdSchema.safeParse(portalId);
  if (!id.success) return fail("Unknown portal.");

  const issuance = feedTokenIssuance();
  if (!issuance.allowed) return fail(issuance.reason);

  const gate = await requireAdmin();
  if ("denied" in gate) return fail(gate.denied);
  const { supabase, profile } = gate;

  // No insert branch: rotating a connection that does not exist would only
  // mean creating one, which is the enable switch's job. The row takes the
  // digest; the token goes back to the card, once — and only once it is
  // known to be the stored one.
  const token = mintPortalToken();
  const answer = await supabase
    .from("portal_connections")
    .update({ feed_token_sha256: hashPortalToken(token), updated_by: profile.id })
    .eq("portal", id.data)
    .select("id");
  const outcome = classifyWrite(answer);
  if (outcome.kind === "refused") {
    return fail(outcome.message ?? "No connection to rotate — enable the portal first.");
  }
  if (outcome.kind === "unknown" && (await tokenStored(supabase, id.data, token)) !== "stored") {
    // The old URL may be dead and this token may never have landed: show
    // neither as live. Regenerate again is right in both cases.
    revalidatePath(PORTAL_SETTINGS_PATH);
    return fail(ROTATION_UNCONFIRMED, true);
  }

  // committed: the old URL is dead, and the only live one is `token`
  const notice = await recordLine(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "organization",
    entityId: profile.orgId,
    eventType: "portal_token_regenerated",
    payload: { portal: id.data },
  });
  revalidatePath(PORTAL_SETTINGS_PATH);
  return okWithToken(token, notice);
}

/* ---------------- the selection (property page, whoever may edit it) ---------------- */

type ListingRead = { id: string; reference: string; org_id: string } & PortalPropertyRow;

async function readListing(
  supabase: Session["supabase"],
  propertyId: string,
  columns: string,
): Promise<{ listing: ListingRead | null } | { error: string }> {
  const res = await supabase.from("properties").select(columns).eq("id", propertyId);
  if (res.error) return { error: res.error.message || "The listing could not be read — reload and try again." };
  if (!Array.isArray(res.data)) return { error: "The listing could not be read — reload and try again." };
  return { listing: (res.data[0] as unknown as ListingRead | undefined) ?? null };
}

/**
 * No role gate here, deliberately: 0095's insert policy is the properties_update
 * rule verbatim, so an agent may put THEIR OWN listing on a portal and a
 * second-guessing check in the app would either duplicate it or diverge from
 * it. The action's job is to read what the policy did — 42501 when it refused,
 * zero rows if it ever refuses silently — and never to claim more.
 *
 * ELIGIBILITY IS RE-CHECKED HERE (finding 7). The card disables Select for a
 * listing the portal would not receive, but a page can be stale — another
 * agent made it private, a photo went — and neither the old action nor the
 * insert policy looked. A selection the feed would silently exclude is
 * refused with the reasons, from the same adapter the card and the settings
 * panel use.
 */
export async function selectPortal(
  propertyId: string,
  portalId: string,
): Promise<PortalActionState> {
  const id = portalIdSchema.safeParse(portalId);
  if (!id.success) return fail("Unknown portal.");
  const def = portalById(id.data)!;
  const { supabase, profile } = await session();

  const read = await readListing(supabase, propertyId, `id, reference, org_id, ${PORTAL_PROPERTY_COLUMNS}`);
  if ("error" in read) return fail(read.error);
  const listing = read.listing;
  if (!listing) return fail("Listing not found.");

  const conn = await readConnection(supabase, id.data, "enabled");
  if ("error" in conn) return fail(conn.error);
  if (!(conn.row as { enabled?: boolean } | null)?.enabled) {
    return fail("That portal is not enabled — an admin enables it under Settings → Portals.");
  }

  const media = await supabase
    .from("property_media")
    .select("kind, path_jpeg, width, height")
    .eq("property_id", propertyId);
  if (media.error || !Array.isArray(media.data)) {
    return fail("The listing's photos could not be read — reload and try again.");
  }
  const e = eligibilityFor(def, portalEligibilityInput(listing, media.data as PortalMediaRow[]));
  if (!e.ok) {
    return fail(
      `This listing would not go into ${def.name}'s feed: ${e.reasons.map((r) => reasonText(def, r)).join(" ")}`,
    );
  }

  const answer = await supabase
    .from("portal_listings")
    .insert({
      org_id: listing.org_id,
      property_id: propertyId,
      portal: id.data,
      selected_by: profile.id,
    })
    .select("portal");
  if (answer.error?.code === "23505") {
    // (property_id, portal) is the primary key: someone already selected it,
    // so the desk's intent is met. Not an error, and not a second event — the
    // first selection's event is the one that happened.
    revalidatePath(`/properties/${propertyId}`);
    return ok();
  }
  if (answer.error?.code === "42501") return fail("Your role cannot put this listing on a portal.");
  const outcome = classifyWrite(answer);
  if (outcome.kind === "refused") {
    return fail(outcome.message ?? "Nothing changed — your role may not put this listing on a portal.");
  }
  if (outcome.kind === "unknown") {
    revalidatePath(`/properties/${propertyId}`);
    return fail(UNCONFIRMED_SAVE);
  }

  // The org of the RECORD, not of the reader. They are the same today — RLS
  // saw to that on the way in — but an event is a fact about the listing.
  const notice = await recordLine(supabase, {
    orgId: listing.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "portal_selected",
    payload: { portal: id.data, reference: listing.reference },
  });
  revalidatePath(`/properties/${propertyId}`);
  return ok(notice);
}

export async function deselectPortal(
  propertyId: string,
  portalId: string,
): Promise<PortalActionState> {
  const id = portalIdSchema.safeParse(portalId);
  if (!id.success) return fail("Unknown portal.");
  const { supabase, profile } = await session();

  const read = await readListing(supabase, propertyId, "id, reference, org_id");
  if ("error" in read) return fail(read.error);
  const listing = read.listing;
  if (!listing) return fail("Listing not found.");

  // Deselecting deletes the row (0095): the events chain is the history, so
  // the returned row is the only proof the delete reached anything.
  const answer = await supabase
    .from("portal_listings")
    .delete()
    .eq("property_id", propertyId)
    .eq("portal", id.data)
    .select("portal");
  const outcome = classifyWrite(answer);
  if (outcome.kind === "refused") {
    return fail(outcome.message ?? "Nothing changed — it was not selected, or your role may not change it.");
  }
  if (outcome.kind === "unknown") {
    // no read-back: an absent row may be another person's removal, with its
    // own line — this one has nothing to prove it did it
    revalidatePath(`/properties/${propertyId}`);
    return fail(UNCONFIRMED_SAVE);
  }

  const notice = await recordLine(supabase, {
    // the org of the record, as above
    orgId: listing.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "portal_removed",
    payload: { portal: id.data, reference: listing.reference },
  });
  revalidatePath(`/properties/${propertyId}`);
  return ok(notice);
}
