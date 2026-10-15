"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import {
  LINK_CONTENT_UNCONFIRMED_NOTICE,
  eventNotice,
  eventRefused,
  joinNotices,
} from "@/lib/services/one-time-secrets";
import { certainlyRolledBack } from "@/lib/services/rpc-outcome";
import {
  AVAILABILITY_EXPIRY_DAYS,
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  SHARE_LOCALES,
  expiryFromNow,
  shareLinkPath,
} from "@/lib/services/share-links";
import { generateShareToken, hashShareToken } from "@/lib/services/share-links-token";
import { rowsOf } from "@/lib/supabase/rows";
import { createClient } from "@/lib/supabase/server";
import { contactLinkError } from "@/lib/services/contact-reread";

export type ShareLinkActionState = {
  error: string | null;
  /** The token is returned ONCE and never again — only its hash is stored. */
  path: string | null;
  savedAt: number | null;
  /**
   * The link exists and `path` carries it, but a step after it was not
   * confirmed — its curation, its `created` line (T-one-time-secrets). Shown
   * beside the link and toasted; never a reason to withhold the link.
   */
  notice: string | null;
};

const refuse = (error: string): ShareLinkActionState => ({ error, path: null, savedAt: null, notice: null });

type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * A link's curation — the rows that say what it shows — inserted AFTER the
 * link committed, whose token now exists only in the calling action.
 *
 * Only a certain refusal (`certainlyRolledBack`, T-refusal-allowlist) says no
 * row was written. Anything else — a code that can follow a commit, no code,
 * an answer that is not 201 Created (an insert's only success,
 * T-log-event-hollow) — may have written them, or may yet, so they are read
 * back by the link's id: `confirmed` is false when they are not all there or
 * the read did not answer, and the link is handed back with a notice rather
 * than lost (T-one-time-secrets).
 */
async function curate(
  supabase: Client,
  linkId: string,
  rows: { property_id: string; sort_order: number }[],
): Promise<{ refused: string } | { confirmed: boolean }> {
  const res = await supabase
    .from("share_link_properties")
    .insert(rows.map((row) => ({ share_link_id: linkId, ...row })));
  if (res.error && certainlyRolledBack(res.error.code)) return { refused: res.error.message };
  if (!res.error && res.status === 201) return { confirmed: true };
  try {
    const found = rowsOf(
      await supabase.from("share_link_properties").select("property_id").eq("share_link_id", linkId),
      "curation read-back",
    );
    return { confirmed: found.length === rows.length };
  } catch {
    return { confirmed: false };
  }
}

/**
 * A link's `created` line, written after the link committed. A failure is
 * reported, never thrown: the token exists only in the action's return value,
 * so an error page would lose it and a resubmit would mint a second link. The
 * link is never revoked over its line (T-one-time-secrets). Null when the
 * line was written; otherwise the notice that says it could not be recorded
 * (refused) or confirmed (unknown).
 */
async function recordLink(supabase: Client, params: Parameters<typeof logEvent>[1]): Promise<string | null> {
  try {
    await logEvent(supabase, params);
    return null;
  } catch (err) {
    console.error("[share-links] link created, its created line not written", { refused: eventRefused(err) });
    return eventNotice(err);
  }
}

const createSchema = z.object({
  property_ids: z
    .array(z.guid())
    .min(1, "Pick at least one property to include")
    .max(25, "A proposal is a shortlist — 25 properties at most"),
  contact_id: z.guid().optional(),
  locale: z.enum(SHARE_LOCALES).default("en"),
  title: z.string().trim().max(200).optional(),
  message: z.string().trim().max(2000).optional(),
  expiry_days: z.coerce.number().int().min(1).max(MAX_EXPIRY_DAYS).default(DEFAULT_EXPIRY_DAYS),
});

export type CreateShareLinkInput = z.input<typeof createSchema>;

/**
 * Mint a proposal link (B3). The plaintext token exists only in this function's
 * return value — the row stores `sha256(token)` — so the UI must show it once
 * and the agent must copy it. That is the same one-shown-once shape as the
 * invite dialog, and for the same reason: a recoverable secret is not a secret.
 */
export async function createShareLink(
  input: CreateShareLinkInput,
): Promise<ShareLinkActionState> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return refuse(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // Only properties the caller can actually SEE may be curated — RLS scopes
  // this read, so an agent cannot assemble a proposal out of rows they were
  // never allowed to open.
  const { data: visible, error: visibleErr } = await supabase
    .from("properties")
    .select("id")
    .in("id", d.property_ids);
  if (visibleErr) return refuse(visibleErr.message);
  if ((visible ?? []).length !== d.property_ids.length) {
    return refuse("Some of those properties are no longer available to you.");
  }
  // the recipient, read the same way (0139 binds the link to the organisation)
  const contactErr = await contactLinkError(supabase, [d.contact_id]);
  if (contactErr) return refuse(contactErr);

  const token = generateShareToken();

  const { data: link, error } = await supabase
    .from("share_links")
    .insert({
      org_id: profile.orgId,
      kind: "proposal",
      token_sha256: hashShareToken(token),
      contact_id: d.contact_id ?? null,
      locale: d.locale,
      title: d.title || null,
      message: d.message || null,
      expires_at: expiryFromNow(d.expiry_days).toISOString(),
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error) return refuse(error.message);

  // ---- committed: the link exists, and its token is in this function alone ----
  const notices: string[] = [];
  const curation = await curate(
    supabase,
    link.id,
    d.property_ids.map((property_id, i) => ({ property_id, sort_order: i })),
  );
  if ("refused" in curation) {
    // A proposal with no properties is not a proposal — don't leave the husk.
    await supabase.from("share_links").delete().eq("id", link.id);
    return refuse(curation.refused);
  }
  if (!curation.confirmed) notices.push(LINK_CONTENT_UNCONFIRMED_NOTICE);

  const notRecorded = await recordLink(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "share_link",
    entityId: link.id,
    eventType: "created",
    payload: {
      property_count: d.property_ids.length,
      locale: d.locale,
      expiry_days: d.expiry_days,
      contact_id: d.contact_id ?? null,
    },
  });
  if (notRecorded) notices.push(notRecorded);

  revalidatePath("/share-links");
  return { error: null, path: shareLinkPath(token), savedAt: Date.now(), notice: joinNotices(notices) };
}

const availabilitySchema = z.object({
  project_id: z.guid(),
  /** null = live asking prices; set = that version, with no fallback */
  price_list_id: z.guid().nullish(),
  contact_id: z.guid().optional(),
  locale: z.enum(SHARE_LOCALES).default("en"),
  title: z.string().trim().max(200).optional(),
  message: z.string().trim().max(2000).optional(),
  expiry_days: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_EXPIRY_DAYS)
    .default(AVAILABILITY_EXPIRY_DAYS),
});

export type CreateAvailabilityLinkInput = z.input<typeof availabilitySchema>;

/**
 * Mint an availability link (migration 0041): a live unit matrix for ONE
 * project or phase, in place of yesterday's PDF.
 *
 * No role gate, deliberately, matching `createShareLink`. Any agent can already
 * put any property and its asking price into a 25-property proposal; the only
 * field this kind adds is `status`, which is not a secret from the partner
 * being invited to sell the units. A role check here would be friction with no
 * boundary behind it. Revocation stays creator-or-admin, as 0023 wrote it.
 */
export async function createAvailabilityLink(
  input: CreateAvailabilityLinkInput,
): Promise<ShareLinkActionState> {
  const parsed = availabilitySchema.safeParse(input);
  if (!parsed.success) return refuse(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // RLS scopes this read, so an agent cannot point a link at a project they
  // were never allowed to open — the same guard `createShareLink` applies to
  // its curated shortlist.
  const { data: target, error: targetErr } = await supabase
    .from("properties")
    .select("id, kind, reference")
    .eq("id", d.project_id)
    .maybeSingle();
  if (targetErr) return refuse(targetErr.message);
  if (!target) return refuse("That project is no longer available to you.");

  // A standalone listing has no units, so an availability matrix over one would
  // always render empty. Refused here rather than shipped as a blank page.
  if (target.kind !== "project" && target.kind !== "phase") {
    return refuse("An availability link needs a project or a phase — that record is neither.");
  }

  // A pinned version must belong to the property being shared. Pinning another
  // project's price list would quote numbers for units that are not in it, and
  // the resolver would render every row unpriced with no explanation.
  if (d.price_list_id) {
    const { data: priceList, error: plErr } = await supabase
      .from("price_lists")
      .select("id, version, project_id")
      .eq("id", d.price_list_id)
      .maybeSingle();
    if (plErr) return refuse(plErr.message);
    if (!priceList || priceList.project_id !== target.id) {
      return refuse("That price list belongs to a different project.");
    }
  }
  // the recipient, read the same way (0139 binds the link to the organisation)
  const contactErr = await contactLinkError(supabase, [d.contact_id]);
  if (contactErr) return refuse(contactErr);

  const token = generateShareToken();

  const { data: link, error } = await supabase
    .from("share_links")
    .insert({
      org_id: profile.orgId,
      kind: "availability",
      token_sha256: hashShareToken(token),
      price_list_id: d.price_list_id ?? null,
      contact_id: d.contact_id ?? null,
      locale: d.locale,
      title: d.title || null,
      message: d.message || null,
      expires_at: expiryFromNow(d.expiry_days).toISOString(),
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error) return refuse(error.message);

  // ---- committed: the link exists, and its token is in this function alone ----
  // One row, in the table 0023 already built. `share_link_properties` is what
  // makes this need no new table at all.
  const notices: string[] = [];
  const curation = await curate(supabase, link.id, [{ property_id: target.id, sort_order: 0 }]);
  if ("refused" in curation) {
    // A link pointing at nothing resolves to nothing — don't leave the husk.
    await supabase.from("share_links").delete().eq("id", link.id);
    return refuse(curation.refused);
  }
  if (!curation.confirmed) notices.push(LINK_CONTENT_UNCONFIRMED_NOTICE);

  const notRecorded = await recordLink(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "share_link",
    entityId: link.id,
    eventType: "created",
    payload: {
      kind: "availability",
      project_id: target.id,
      project_reference: target.reference,
      target_kind: target.kind,
      price_list_id: d.price_list_id ?? null,
      locale: d.locale,
      expiry_days: d.expiry_days,
      contact_id: d.contact_id ?? null,
    },
  });
  if (notRecorded) notices.push(notRecorded);

  revalidatePath("/share-links");
  revalidatePath(`/properties/${target.id}/units`);
  return { error: null, path: shareLinkPath(token), savedAt: Date.now(), notice: joinNotices(notices) };
}

/**
 * Revoke immediately. Never deletes — the row and its open history are part of
 * the commission evidence record, so a revoked link stays visible and retired.
 * Kind-agnostic: an availability link retires exactly as a proposal does.
 */
export async function revokeShareLink(linkId: string): Promise<{ error: string | null }> {
  if (!z.guid().safeParse(linkId).success) return { error: "Invalid link" };

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // Row-count guard folded into the write: RLS admits only the creator or an
  // admin, and `is null` makes a double-revoke single-fire, so 0 rows means
  // "not yours, or already revoked" rather than a phantom event.
  const { data: updated, error } = await supabase
    .from("share_links")
    .update({ revoked_at: new Date().toISOString(), revoked_by: profile.id })
    .eq("id", linkId)
    .is("revoked_at", null)
    .select("id, view_count");
  if (error) return { error: error.message };
  if (!updated || updated.length === 0) {
    return { error: "Link was not revoked — it may already be revoked, or is not yours." };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "share_link",
    entityId: linkId,
    eventType: "revoked",
    payload: { views_at_revocation: updated[0].view_count },
  });

  revalidatePath("/share-links");
  return { error: null };
}
