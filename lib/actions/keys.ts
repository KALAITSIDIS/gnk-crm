"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  checkoutKeySchema,
  registerKeySchema,
  returnKeySchema,
} from "@/lib/validators/keys";

export type KeyActionState = { error: string | null; savedAt: number | null };

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
    return {
      error: error.code === "42501" ? "Only admins and listing managers register keys." : error.message,
      savedAt: null,
    };
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

/**
 * Check a key out. The movement insert is the RLS-checked user action
 * (append-only log); the key row's status/holder cache is then updated with
 * the service role — agents may move keys but only admin/LM may edit the
 * register row itself (doc 04), so the derived-state write goes through the
 * service role on purpose.
 */
export async function checkoutKey(
  _prev: KeyActionState,
  formData: FormData,
): Promise<KeyActionState> {
  const parsed = checkoutKeySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: key } = await supabase
    .from("property_keys")
    .select("id, org_id, property_id, status, key_code")
    .eq("id", d.key_id)
    .maybeSingle();
  if (!key) return { error: "Key not found", savedAt: null };
  if (key.status !== "in_office") {
    return { error: `Key is ${key.status.replace("_", " ")} — return it first.`, savedAt: null };
  }

  let holderName = d.holder_name ?? null;
  if (d.holder_profile_id) {
    const { data: holder } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", d.holder_profile_id)
      .maybeSingle();
    holderName = holder?.full_name ?? holderName;
  }

  const { error: moveErr } = await supabase.from("key_movements").insert({
    org_id: key.org_id,
    key_id: key.id,
    action: "checkout",
    holder_profile_id: d.holder_profile_id ?? null,
    holder_name: holderName,
    note: d.note ?? null,
    created_by: profile.id,
  });
  if (moveErr) return { error: moveErr.message, savedAt: null };

  const admin = createAdminClient();
  const { error: cacheErr } = await admin
    .from("property_keys")
    .update({
      status: "checked_out",
      current_holder_profile_id: d.holder_profile_id ?? null,
      current_holder_name: holderName,
    })
    .eq("id", key.id);
  if (cacheErr) return { error: cacheErr.message, savedAt: null };

  await logEvent(supabase, {
    orgId: key.org_id,
    actorId: profile.id,
    entityType: "key",
    entityId: key.id,
    eventType: "key_checkout",
    payload: { key_code: key.key_code, holder: holderName },
  });

  revalidatePath("/keys");
  revalidatePath(`/properties/${key.property_id}`);
  return { error: null, savedAt: Date.now() };
}

/** Return a key to the office (movement + cache reset, same split as checkout). */
export async function returnKey(
  _prev: KeyActionState,
  formData: FormData,
): Promise<KeyActionState> {
  const parsed = returnKeySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: key } = await supabase
    .from("property_keys")
    .select("id, org_id, property_id, status, key_code, current_holder_name")
    .eq("id", d.key_id)
    .maybeSingle();
  if (!key) return { error: "Key not found", savedAt: null };
  if (key.status !== "checked_out") {
    return { error: "Key is not checked out.", savedAt: null };
  }

  const { error: moveErr } = await supabase.from("key_movements").insert({
    org_id: key.org_id,
    key_id: key.id,
    action: "return",
    holder_name: key.current_holder_name,
    note: d.note ?? null,
    created_by: profile.id,
  });
  if (moveErr) return { error: moveErr.message, savedAt: null };

  const admin = createAdminClient();
  const { error: cacheErr } = await admin
    .from("property_keys")
    .update({
      status: "in_office",
      current_holder_profile_id: null,
      current_holder_name: null,
    })
    .eq("id", key.id);
  if (cacheErr) return { error: cacheErr.message, savedAt: null };

  await logEvent(supabase, {
    orgId: key.org_id,
    actorId: profile.id,
    entityType: "key",
    entityId: key.id,
    eventType: "key_return",
    payload: { key_code: key.key_code, holder: key.current_holder_name },
  });

  revalidatePath("/keys");
  revalidatePath(`/properties/${key.property_id}`);
  return { error: null, savedAt: Date.now() };
}
