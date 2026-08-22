"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import {
  AVAILABILITY_EXPIRY_DAYS,
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  SHARE_LOCALES,
  expiryFromNow,
  shareLinkPath,
} from "@/lib/services/share-links";
import { generateShareToken, hashShareToken } from "@/lib/services/share-links-token";
import { createClient } from "@/lib/supabase/server";

export type ShareLinkActionState = {
  error: string | null;
  /** The token is returned ONCE and never again — only its hash is stored. */
  path: string | null;
  savedAt: number | null;
};

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
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid input",
      path: null,
      savedAt: null,
    };
  }
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
  if (visibleErr) return { error: visibleErr.message, path: null, savedAt: null };
  if ((visible ?? []).length !== d.property_ids.length) {
    return {
      error: "Some of those properties are no longer available to you.",
      path: null,
      savedAt: null,
    };
  }

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
  if (error) return { error: error.message, path: null, savedAt: null };

  const { error: propsErr } = await supabase.from("share_link_properties").insert(
    d.property_ids.map((property_id, i) => ({
      share_link_id: link.id,
      property_id,
      sort_order: i,
    })),
  );
  if (propsErr) {
    // A proposal with no properties is not a proposal — don't leave the husk.
    await supabase.from("share_links").delete().eq("id", link.id);
    return { error: propsErr.message, path: null, savedAt: null };
  }

  await logEvent(supabase, {
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

  revalidatePath("/share-links");
  return { error: null, path: shareLinkPath(token), savedAt: Date.now() };
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
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid input",
      path: null,
      savedAt: null,
    };
  }
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
  if (targetErr) return { error: targetErr.message, path: null, savedAt: null };
  if (!target) {
    return { error: "That project is no longer available to you.", path: null, savedAt: null };
  }

  // A standalone listing has no units, so an availability matrix over one would
  // always render empty. Refused here rather than shipped as a blank page.
  if (target.kind !== "project" && target.kind !== "phase") {
    return {
      error: "An availability link needs a project or a phase — that record is neither.",
      path: null,
      savedAt: null,
    };
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
    if (plErr) return { error: plErr.message, path: null, savedAt: null };
    if (!priceList || priceList.project_id !== target.id) {
      return {
        error: "That price list belongs to a different project.",
        path: null,
        savedAt: null,
      };
    }
  }

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
  if (error) return { error: error.message, path: null, savedAt: null };

  // One row, in the table 0023 already built. `share_link_properties` is what
  // makes this need no new table at all.
  const { error: joinErr } = await supabase
    .from("share_link_properties")
    .insert({ share_link_id: link.id, property_id: target.id, sort_order: 0 });
  if (joinErr) {
    // A link pointing at nothing resolves to nothing — don't leave the husk.
    await supabase.from("share_links").delete().eq("id", link.id);
    return { error: joinErr.message, path: null, savedAt: null };
  }

  await logEvent(supabase, {
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

  revalidatePath("/share-links");
  revalidatePath(`/properties/${target.id}/units`);
  return { error: null, path: shareLinkPath(token), savedAt: Date.now() };
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
