"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  parseStampDutyConfig,
  parseTransferFeesConfig,
} from "@/lib/services/calculators";
import { getCurrentProfile, type CurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  areaNameSchema,
  cyprusConfigSchema,
  inviteUserSchema,
  orgNameSchema,
  stageNameSchema,
} from "@/lib/validators/settings";

/**
 * Settings suite actions (T5.4, doc 02 §C9). Every action is admin-gated
 * server-side AND covered by admin-only RLS policies; every edit writes an
 * event (C9 acceptance: "settings edits write events").
 */

export type SettingsActionState = {
  error: string | null;
  savedAt: number | null;
  /** invite only: one-time credentials to hand over */
  tempPassword: string | null;
};

const ok = (): SettingsActionState => ({ error: null, savedAt: Date.now(), tempPassword: null });
const fail = (error: string): SettingsActionState => ({ error, savedAt: null, tempPassword: null });

async function requireAdmin(): Promise<
  | { supabase: Awaited<ReturnType<typeof createClient>>; profile: CurrentProfile }
  | { denied: string }
> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (profile.role !== "admin") return { denied: "Admins only." };
  return { supabase, profile };
}

/* ---------------- organization ---------------- */

export async function updateOrgName(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const parsed = orgNameSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");

  const gate = await requireAdmin();
  if ("denied" in gate) return fail(gate.denied);
  const { supabase, profile } = gate;

  const { error } = await supabase
    .from("organizations")
    .update({ name: parsed.data.name })
    .eq("id", profile.orgId);
  if (error) return fail(error.message);

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "organization",
    entityId: profile.orgId,
    eventType: "updated",
    payload: { changed: { name: { to: parsed.data.name } } },
  });
  revalidatePath("/settings/organization");
  return ok();
}

const BRANDING_PATHS = { logo: "branding/logo.png", watermark: "branding/watermark.png" } as const;

export async function uploadBranding(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const kind = String(formData.get("kind"));
  if (kind !== "logo" && kind !== "watermark") return fail("Unknown branding asset");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return fail("Choose a PNG file");
  if (file.type !== "image/png") return fail("PNG only — transparency is required");
  if (file.size > 2 * 1024 * 1024) return fail("File is over 2 MB");

  const gate = await requireAdmin();
  if ("denied" in gate) return fail(gate.denied);
  const { supabase, profile } = gate;

  // media bucket is public; the watermark path is what the T1.4 photo
  // pipeline reads (lib/actions/media.ts WATERMARK_PATH)
  const admin = createAdminClient();
  const upload = await admin.storage
    .from("media")
    .upload(BRANDING_PATHS[kind], file, {
      contentType: "image/png",
      upsert: true,
    });
  if (upload.error) return fail(upload.error.message);

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "organization",
    entityId: profile.orgId,
    eventType: "updated",
    payload: { changed: { [kind]: { to: BRANDING_PATHS[kind] } } },
  });
  revalidatePath("/settings/organization");
  return ok();
}

/* ---------------- users ---------------- */

export async function inviteUser(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const parsed = inviteUserSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;

  const gate = await requireAdmin();
  if ("denied" in gate) return fail(gate.denied);
  const { supabase, profile } = gate;

  // No SMTP in Phase 1 (email lands in Phase 2-3): create the account with a
  // one-time password shown ONCE to the admin, who hands it over.
  const tempPassword = randomBytes(9).toString("base64url");
  const admin = createAdminClient();
  const created = await admin.auth.admin.createUser({
    email: d.email,
    password: tempPassword,
    email_confirm: true,
  });
  if (created.error) return fail(created.error.message);
  const userId = created.data.user.id;

  const { error: profErr } = await supabase.from("profiles").insert({
    id: userId,
    org_id: profile.orgId,
    role: d.role,
    full_name: d.full_name,
    email: d.email,
  });
  if (profErr) {
    await admin.auth.admin.deleteUser(userId); // don't leave an orphan login
    return fail(profErr.message);
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "user",
    entityId: userId,
    eventType: "invited",
    payload: { email: d.email, role: d.role },
  });
  revalidatePath("/settings/users");
  return { error: null, savedAt: Date.now(), tempPassword };
}

export async function setUserRole(
  userId: string,
  role: string,
): Promise<{ error: string | null }> {
  if (!z.guid().safeParse(userId).success) return { error: "Invalid user" };
  if (!["admin", "agent", "listing_manager"].includes(role)) return { error: "Invalid role" };

  const gate = await requireAdmin();
  if ("denied" in gate) return { error: gate.denied };
  const { supabase, profile } = gate;
  if (userId === profile.id) return { error: "You cannot change your own role." };

  const { data: target } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (!target) return { error: "User not found" };
  if (target.role === role) return { error: null };

  const { error } = await supabase
    .from("profiles")
    .update({ role: role as "admin" | "agent" | "listing_manager" })
    .eq("id", userId);
  if (error) return { error: error.message };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "user",
    entityId: userId,
    eventType: "role_changed",
    payload: { from: target.role, to: role },
  });
  revalidatePath("/settings/users");
  return { error: null };
}

export async function setUserActive(
  userId: string,
  active: boolean,
): Promise<{ error: string | null }> {
  if (!z.guid().safeParse(userId).success) return { error: "Invalid user" };

  const gate = await requireAdmin();
  if ("denied" in gate) return { error: gate.denied };
  const { supabase, profile } = gate;
  if (userId === profile.id) return { error: "You cannot deactivate yourself." };

  const { error } = await supabase
    .from("profiles")
    .update({ is_active: active })
    .eq("id", userId);
  if (error) return { error: error.message };

  // also block/unblock the login itself, not just the profile flag
  const admin = createAdminClient();
  const ban = await admin.auth.admin.updateUserById(userId, {
    ban_duration: active ? "none" : "876000h",
  });
  if (ban.error) return { error: ban.error.message };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "user",
    entityId: userId,
    eventType: active ? "reactivated" : "deactivated",
    payload: {},
  });
  revalidatePath("/settings/users");
  return { error: null };
}

/* ---------------- deal stages ---------------- */

async function logStageEvent(
  supabase: Awaited<ReturnType<typeof createClient>>,
  profile: CurrentProfile,
  payload: Record<string, unknown>,
) {
  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "config",
    entityId: null,
    eventType: "stages_updated",
    payload: JSON.parse(JSON.stringify(payload)),
  });
}

export async function renameStage(
  stageId: string,
  name: string,
): Promise<{ error: string | null }> {
  const parsed = stageNameSchema.safeParse({ name });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid name" };
  if (!z.guid().safeParse(stageId).success) return { error: "Invalid stage" };

  const gate = await requireAdmin();
  if ("denied" in gate) return { error: gate.denied };
  const { supabase, profile } = gate;

  const { data: stage } = await supabase
    .from("deal_stages")
    .select("name")
    .eq("id", stageId)
    .maybeSingle();
  if (!stage) return { error: "Stage not found" };

  const { error } = await supabase
    .from("deal_stages")
    .update({ name: parsed.data.name })
    .eq("id", stageId);
  if (error) return { error: error.message };

  await logStageEvent(supabase, profile, {
    action: "rename",
    from: stage.name,
    to: parsed.data.name,
  });
  revalidatePath("/settings/stages");
  revalidatePath("/pipeline");
  return { error: null };
}

export async function addStage(
  dealType: string,
  name: string,
): Promise<{ error: string | null }> {
  const parsed = stageNameSchema.safeParse({ name });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid name" };

  const gate = await requireAdmin();
  if ("denied" in gate) return { error: gate.denied };
  const { supabase, profile } = gate;

  // append before the terminal won/lost stages: new sort_order = max(non-terminal)+1,
  // and shift terminal stages up by one to keep them last
  const { data: stages } = await supabase
    .from("deal_stages")
    .select("id, sort_order, is_won, is_lost")
    .eq("deal_type", dealType as "sale" | "rental" | "antiparoxi" | "advisory")
    .order("sort_order", { ascending: true });
  if (!stages || stages.length === 0) return { error: "Unknown deal type" };

  const terminals = stages.filter((s) => s.is_won || s.is_lost);
  const newOrder = (stages.filter((s) => !s.is_won && !s.is_lost).at(-1)?.sort_order ?? 0) + 1;

  // move terminals out of the way (descending so the unique index never collides)
  for (const t of [...terminals].sort((a, b) => b.sort_order - a.sort_order)) {
    const { error } = await supabase
      .from("deal_stages")
      .update({ sort_order: t.sort_order + 1 })
      .eq("id", t.id);
    if (error) return { error: error.message };
  }

  const { error } = await supabase.from("deal_stages").insert({
    org_id: profile.orgId,
    deal_type: dealType as "sale" | "rental" | "antiparoxi" | "advisory",
    name: parsed.data.name,
    sort_order: newOrder,
  });
  if (error) return { error: error.message };

  await logStageEvent(supabase, profile, {
    action: "add",
    deal_type: dealType,
    name: parsed.data.name,
  });
  revalidatePath("/settings/stages");
  revalidatePath("/pipeline");
  return { error: null };
}

export async function moveStage(
  stageId: string,
  direction: "up" | "down",
): Promise<{ error: string | null }> {
  if (!z.guid().safeParse(stageId).success) return { error: "Invalid stage" };

  const gate = await requireAdmin();
  if ("denied" in gate) return { error: gate.denied };
  const { supabase, profile } = gate;

  const { data: stage } = await supabase
    .from("deal_stages")
    .select("id, name, deal_type, sort_order, is_won, is_lost")
    .eq("id", stageId)
    .maybeSingle();
  if (!stage) return { error: "Stage not found" };
  if (stage.is_won || stage.is_lost) return { error: "Won/lost stages stay last." };

  const { data: siblings } = await supabase
    .from("deal_stages")
    .select("id, sort_order, is_won, is_lost")
    .eq("deal_type", stage.deal_type)
    .order("sort_order", { ascending: true });
  const movable = (siblings ?? []).filter((s) => !s.is_won && !s.is_lost);
  const idx = movable.findIndex((s) => s.id === stageId);
  const swapWith = direction === "up" ? movable[idx - 1] : movable[idx + 1];
  if (!swapWith) return { error: null }; // already at the edge

  // unique (org, type, sort_order): park the mover on a temp slot first
  const a = stage.sort_order;
  const b = swapWith.sort_order;
  const park = await supabase.from("deal_stages").update({ sort_order: -1 }).eq("id", stage.id);
  if (park.error) return { error: park.error.message };
  const s1 = await supabase.from("deal_stages").update({ sort_order: a }).eq("id", swapWith.id);
  if (s1.error) return { error: s1.error.message };
  const s2 = await supabase.from("deal_stages").update({ sort_order: b }).eq("id", stage.id);
  if (s2.error) return { error: s2.error.message };

  await logStageEvent(supabase, profile, { action: "reorder", stage: stage.name, direction });
  revalidatePath("/settings/stages");
  revalidatePath("/pipeline");
  return { error: null };
}

export async function deleteStage(stageId: string): Promise<{ error: string | null }> {
  if (!z.guid().safeParse(stageId).success) return { error: "Invalid stage" };

  const gate = await requireAdmin();
  if ("denied" in gate) return { error: gate.denied };
  const { supabase, profile } = gate;

  const { data: stage } = await supabase
    .from("deal_stages")
    .select("name, is_won, is_lost")
    .eq("id", stageId)
    .maybeSingle();
  if (!stage) return { error: "Stage not found" };
  if (stage.is_won || stage.is_lost) return { error: "Won/lost stages cannot be deleted." };

  // RLS also refuses when deals still reference the stage
  const { error, count } = await supabase
    .from("deal_stages")
    .delete({ count: "exact" })
    .eq("id", stageId);
  if (error) return { error: error.message };
  if (!count) return { error: "Stage still has deals — move them first." };

  await logStageEvent(supabase, profile, { action: "delete", name: stage.name });
  revalidatePath("/settings/stages");
  revalidatePath("/pipeline");
  return { error: null };
}

/* ---------------- locations ---------------- */

export async function addArea(
  districtId: string,
  name: string,
): Promise<{ error: string | null }> {
  const parsed = areaNameSchema.safeParse({ name });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid name" };
  if (!z.guid().safeParse(districtId).success) return { error: "Invalid district" };

  const gate = await requireAdmin();
  if ("denied" in gate) return { error: gate.denied };
  const { supabase, profile } = gate;

  const { error } = await supabase.from("areas").insert({
    org_id: profile.orgId,
    district_id: districtId,
    name: { en: parsed.data.name },
  });
  if (error) return { error: error.message };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "config",
    entityId: null,
    eventType: "locations_updated",
    payload: { action: "add_area", name: parsed.data.name },
  });
  revalidatePath("/settings/locations");
  return { error: null };
}

export async function renameArea(
  areaId: string,
  name: string,
): Promise<{ error: string | null }> {
  const parsed = areaNameSchema.safeParse({ name });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid name" };
  if (!z.guid().safeParse(areaId).success) return { error: "Invalid area" };

  const gate = await requireAdmin();
  if ("denied" in gate) return { error: gate.denied };
  const { supabase, profile } = gate;

  const { data: area } = await supabase
    .from("areas")
    .select("name")
    .eq("id", areaId)
    .maybeSingle();
  if (!area) return { error: "Area not found" };

  const nextName = { ...(area.name as Record<string, string>), en: parsed.data.name };
  const { error } = await supabase.from("areas").update({ name: nextName }).eq("id", areaId);
  if (error) return { error: error.message };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "config",
    entityId: null,
    eventType: "locations_updated",
    payload: {
      action: "rename_area",
      from: (area.name as { en?: string })?.en ?? null,
      to: parsed.data.name,
    },
  });
  revalidatePath("/settings/locations");
  return { error: null };
}

/* ---------------- cyprus config ---------------- */

export async function saveCyprusConfig(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const parsed = cyprusConfigSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;

  let value: unknown;
  try {
    value = JSON.parse(d.value_json);
  } catch {
    return fail("Invalid JSON — fix the syntax and try again.");
  }

  // shape-check the keys the calculators depend on (guardrail 5: a broken
  // config must not silently produce nonsense fees)
  if (d.key === "transfer_fees" && !parseTransferFeesConfig(value)) {
    return fail("transfer_fees shape invalid: needs bands[{up_to,rate}] + relief_pct.");
  }
  if (d.key === "stamp_duty" && !parseStampDutyConfig(value)) {
    return fail("stamp_duty shape invalid: needs bands[{up_to,rate}] (+ cap).");
  }

  const gate = await requireAdmin();
  if ("denied" in gate) return fail(gate.denied);
  const { supabase, profile } = gate;

  const { error } = await supabase
    .from("cyprus_config")
    .update({
      value: value as never,
      verified_at: d.verified_at ?? null,
      ...(d.source_note !== undefined ? { source_note: d.source_note } : {}),
    })
    .eq("key", d.key);
  if (error) return fail(error.message);

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "config",
    entityId: null,
    eventType: "updated",
    payload: { key: d.key, verified_at: d.verified_at ?? null },
  });
  revalidatePath("/settings/cyprus-config");
  revalidatePath("/calculators");
  return ok();
}
