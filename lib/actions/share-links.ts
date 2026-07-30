"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import {
  DEFAULT_EXPIRY_DAYS,
  MAX_EXPIRY_DAYS,
  SHARE_LOCALES,
  expiryFromNow,
  generateShareToken,
  hashShareToken,
  shareLinkPath,
} from "@/lib/services/share-links";
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

/**
 * Revoke immediately. Never deletes — the row and its open history are part of
 * the commission evidence record, so a revoked link stays visible and retired.
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
