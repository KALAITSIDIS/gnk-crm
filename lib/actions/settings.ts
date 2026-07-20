"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import sharp from "sharp";
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
  DEAL_TYPES,
  areaNameSchema,
  cyprusConfigSchema,
  inviteUserSchema,
  orgNameSchema,
  stageNameSchema,
} from "@/lib/validators/settings";

/**
 * Settings suite actions (T5.4, doc 02 §C9). Every action is admin-gated
 * server-side AND covered by admin-only RLS policies; every edit writes an
 * event (C9 acceptance: "settings edits write events"). Stage add/reorder go
 * through the 0014 RPCs so the mutation and its event land in one transaction;
 * everything else follows the repo convention of row-count-guarded writes
 * (an RLS-filtered 0-row update must never report success or log an event).
 */

export type SettingsActionState = {
  error: string | null;
  savedAt: number | null;
  /** invite only: one-time credentials to hand over */
  tempPassword: string | null;
  /** invite only: shown next to the password so the admin hands over both */
  invitedEmail: string | null;
};

const ok = (): SettingsActionState => ({
  error: null,
  savedAt: Date.now(),
  tempPassword: null,
  invitedEmail: null,
});
const fail = (error: string): SettingsActionState => ({
  error,
  savedAt: null,
  tempPassword: null,
  invitedEmail: null,
});

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

  const { data: updated, error } = await supabase
    .from("organizations")
    .update({ name: parsed.data.name })
    .eq("id", profile.orgId)
    .select("id");
  if (error) return fail(error.message);
  if (!updated?.length) return fail("Organization not found.");

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

  // decode-verify the bytes: the MIME type above is client-supplied, and a
  // corrupt watermark would break EVERY later public-photo upload inside the
  // T1.4 pipeline with a per-file "unreadable image" — fail loudly here instead
  const bytes = Buffer.from(await file.arrayBuffer());
  try {
    const meta = await sharp(bytes).metadata();
    if (meta.format !== "png") return fail("File is not a real PNG");
    if (kind === "watermark" && !meta.hasAlpha) {
      return fail("Watermark PNG needs an alpha (transparency) channel");
    }
  } catch {
    return fail("File could not be decoded as an image");
  }

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
  return { error: null, savedAt: Date.now(), tempPassword, invitedEmail: d.email };
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

  const { data: updated, error } = await supabase
    .from("profiles")
    .update({ role: role as "admin" | "agent" | "listing_manager" })
    .eq("id", userId)
    .select("id");
  if (error) return { error: error.message };
  if (!updated?.length) return { error: "You do not have permission to change this user." };

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

  // RLS-scoped existence check: a cross-org or unknown id must stop HERE —
  // the ban below runs with the service role and would otherwise hit any
  // auth user in the instance (audit finding #1)
  const { data: target } = await supabase
    .from("profiles")
    .select("id, is_active")
    .eq("id", userId)
    .maybeSingle();
  if (!target) return { error: "User not found" };
  if (target.is_active === active) return { error: null };

  const { data: updated, error } = await supabase
    .from("profiles")
    .update({ is_active: active })
    .eq("id", userId)
    .select("id");
  if (error) return { error: error.message };
  if (!updated?.length) return { error: "You do not have permission to change this user." };

  // also block/unblock the login itself, not just the profile flag
  // (0014 makes the flag itself kill live-JWT access; the ban stops refresh)
  const admin = createAdminClient();
  const ban = await admin.auth.admin.updateUserById(userId, {
    ban_duration: active ? "none" : "876000h",
  });
  if (ban.error) {
    // keep flag and ban consistent: revert the flag so the UI never claims
    // a state the login doesn't have
    await supabase.from("profiles").update({ is_active: !active }).eq("id", userId);
    return { error: ban.error.message };
  }

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
    .select("name, deal_type")
    .eq("id", stageId)
    .maybeSingle();
  if (!stage) return { error: "Stage not found" };
  if (stage.name === parsed.data.name) return { error: null };

  const { data: siblings } = await supabase
    .from("deal_stages")
    .select("id, name")
    .eq("deal_type", stage.deal_type);
  const lowered = parsed.data.name.toLowerCase();
  if ((siblings ?? []).some((s) => s.id !== stageId && s.name.toLowerCase() === lowered)) {
    return { error: "A stage with this name already exists for this deal type." };
  }

  const { data: updated, error } = await supabase
    .from("deal_stages")
    .update({ name: parsed.data.name })
    .eq("id", stageId)
    .select("id");
  if (error) return { error: error.message };
  if (!updated?.length) return { error: "You do not have permission to rename stages." };

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
  const parsedType = z.enum(DEAL_TYPES).safeParse(dealType);
  if (!parsedType.success) return { error: "Unknown deal type" };

  const gate = await requireAdmin();
  if ("denied" in gate) return { error: gate.denied };
  const { supabase } = gate;

  // 0014 RPC: terminal-shift + insert + stages_updated event in ONE
  // transaction (the app-side shift loop could strand a half-moved order)
  const { error } = await supabase.rpc("add_deal_stage", {
    p_deal_type: parsedType.data,
    p_name: parsed.data.name,
  });
  if (error) return { error: error.message };

  revalidatePath("/settings/stages");
  revalidatePath("/pipeline");
  return { error: null };
}

export async function moveStage(
  stageId: string,
  direction: "up" | "down",
): Promise<{ error: string | null }> {
  if (!z.guid().safeParse(stageId).success) return { error: "Invalid stage" };
  if (direction !== "up" && direction !== "down") return { error: "Unknown direction" };

  const gate = await requireAdmin();
  if ("denied" in gate) return { error: gate.denied };
  const { supabase } = gate;

  // 0014 RPC: row-locked park-and-swap + event in ONE transaction — the old
  // three-statement app-side swap could strand a stage at sort_order -1
  const { error } = await supabase.rpc("reorder_stage", {
    p_stage_id: stageId,
    p_direction: direction,
  });
  if (error) return { error: error.message };

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
  const { data: updated, error } = await supabase
    .from("areas")
    .update({ name: nextName })
    .eq("id", areaId)
    .select("id");
  if (error) return { error: error.message };
  if (!updated?.length) return { error: "You do not have permission to rename areas." };

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

  const { data: updated, error } = await supabase
    .from("cyprus_config")
    .update({
      value: value as never,
      verified_at: d.verified_at ?? null,
      source_note: d.source_note || null,
    })
    .eq("key", d.key)
    .select("key");
  if (error) return fail(error.message);
  // update matched no row (tampered/removed key) — must not report success
  if (!updated?.length) return fail("Unknown config key — refresh and try again.");

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
