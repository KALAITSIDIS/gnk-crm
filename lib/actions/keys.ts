"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createClient } from "@/lib/supabase/server";
import {
  checkoutKeySchema,
  markLostKeySchema,
  registerKeySchema,
  returnKeySchema,
  transferKeySchema,
  updateKeySchema,
} from "@/lib/validators/keys";
import type { Database } from "@/lib/supabase/database.types";

export type KeyActionState = { error: string | null; savedAt: number | null };

type KeyAction = Database["public"]["Enums"]["key_action"];

/** Register a key (admin/LM per RLS; the insert itself is policy-checked). */
export async function registerKey(
  _prev: KeyActionState,
  formData: FormData,
): Promise<KeyActionState> {
  const parsed = registerKeySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: created, error } = await supabase
    .from("property_keys")
    .insert({
      org_id: profile.orgId,
      property_id: d.property_id,
      key_code: d.key_code,
      description: d.description ?? null,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "42501") {
      return { error: "Only admins and listing managers register keys.", savedAt: null };
    }
    if (error.code === "23505") {
      return { error: `A key with code ${d.key_code} already exists.`, savedAt: null };
    }
    return { error: error.message, savedAt: null };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "key",
    entityId: created.id,
    eventType: "created",
    payload: { property_id: d.property_id, key_code: d.key_code },
  });

  revalidatePath("/keys");
  revalidatePath(`/properties/${d.property_id}`);
  return { error: null, savedAt: Date.now() };
}

/** Edit key code/description (admin/LM per RLS; row-count guarded). */
export async function updateKey(
  _prev: KeyActionState,
  formData: FormData,
): Promise<KeyActionState> {
  const parsed = updateKeySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: before } = await supabase
    .from("property_keys")
    .select("id, property_id, key_code, description")
    .eq("id", d.key_id)
    .maybeSingle();
  if (!before) return { error: "Key not found", savedAt: null };

  if (before.key_code === d.key_code && (before.description ?? null) === (d.description ?? null)) {
    return { error: null, savedAt: Date.now() }; // no-op save writes nothing
  }

  const { data: updated, error } = await supabase
    .from("property_keys")
    .update({ key_code: d.key_code, description: d.description ?? null })
    .eq("id", d.key_id)
    .select("id");
  if (error) {
    if (error.code === "23505") {
      return { error: `A key with code ${d.key_code} already exists.`, savedAt: null };
    }
    return { error: error.message, savedAt: null };
  }
  // RLS filtered the update to 0 rows — no phantom success, no phantom event
  if ((updated ?? []).length === 0) {
    return { error: "Only admins and listing managers can edit keys.", savedAt: null };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "key",
    entityId: before.id,
    eventType: "updated",
    payload: {
      section: "key_meta",
      ...(before.key_code !== d.key_code ? { from: before.key_code, to: d.key_code } : {}),
    },
  });

  revalidatePath("/keys");
  revalidatePath(`/properties/${before.property_id}`);
  return { error: null, savedAt: Date.now() };
}

/**
 * All four movements go through the record_key_movement RPC (0013): it
 * enforces org/role/status server-side, refuses unverified holder ids, and
 * writes movement + status cache + event in one transaction. The pre-fetch
 * here is only for a friendly not-found and the revalidate path.
 */
async function moveKey(
  keyId: string,
  action: KeyAction,
  opts: { holderProfileId?: string; holderName?: string; note?: string },
): Promise<KeyActionState> {
  const supabase = await createClient();

  const { data: key } = await supabase
    .from("property_keys")
    .select("id, property_id")
    .eq("id", keyId)
    .maybeSingle();
  if (!key) return { error: "Key not found", savedAt: null };

  const { error } = await supabase.rpc("record_key_movement", {
    p_key_id: keyId,
    p_action: action,
    p_holder_profile_id: opts.holderProfileId,
    p_holder_name: opts.holderName,
    p_note: opts.note,
  });
  if (error) return { error: error.message, savedAt: null };

  revalidatePath("/keys");
  revalidatePath(`/properties/${key.property_id}`);
  return { error: null, savedAt: Date.now() };
}

/** Check a key out of the office to a staff member or external holder. */
export async function checkoutKey(
  _prev: KeyActionState,
  formData: FormData,
): Promise<KeyActionState> {
  const parsed = checkoutKeySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;
  return moveKey(d.key_id, "checkout", {
    holderProfileId: d.holder_profile_id,
    holderName: d.holder_name,
    note: d.note,
  });
}

/** Return a key to the office — also the recovery path from with-owner/lost. */
export async function returnKey(
  _prev: KeyActionState,
  formData: FormData,
): Promise<KeyActionState> {
  const parsed = returnKeySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  return moveKey(parsed.data.key_id, "return", { note: parsed.data.note });
}

/** Hand a key to the property owner (status with_owner). */
export async function transferKey(
  _prev: KeyActionState,
  formData: FormData,
): Promise<KeyActionState> {
  const parsed = transferKeySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;
  return moveKey(d.key_id, "transfer", { holderName: d.holder_name, note: d.note });
}

/** Flag a key as lost; the last holder stays on the row for accountability. */
export async function markLostKey(
  _prev: KeyActionState,
  formData: FormData,
): Promise<KeyActionState> {
  const parsed = markLostKeySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  return moveKey(parsed.data.key_id, "mark_lost", { note: parsed.data.note });
}

export interface KeyMovementRow {
  id: string;
  action: string;
  holderName: string | null;
  note: string | null;
  occurredAt: string;
  actorName: string | null;
}

/** Full movement trail for one key (history dialog; RLS org-scoped). */
export async function listKeyMovements(keyId: string): Promise<KeyMovementRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("key_movements")
    .select("id, action, holder_name, note, occurred_at, actor:profiles!created_by(full_name)")
    .eq("key_id", keyId)
    .order("occurred_at", { ascending: false })
    .limit(100);
  return (data ?? []).map((m) => ({
    id: m.id,
    action: m.action as string,
    holderName: m.holder_name,
    note: m.note,
    occurredAt: m.occurred_at,
    actorName: (m.actor as { full_name: string } | null)?.full_name ?? null,
  }));
}
