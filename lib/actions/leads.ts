"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Database } from "@/lib/supabase/database.types";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createClient } from "@/lib/supabase/server";
import { COMM_CHANNELS, LEAD_SOURCES } from "@/lib/validators/contacts";

export type LeadActionState = { error: string | null; savedAt: number | null };

const emptyToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);

const createLeadSchema = z.object({
  source: z.enum(LEAD_SOURCES),
  channel: z.preprocess(emptyToUndefined, z.enum(COMM_CHANNELS).optional()),
  message: z.preprocess(emptyToUndefined, z.string().max(5000).optional()),
  contact_id: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  property_id: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
});

export async function createLead(
  _prev: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const parsed = createLeadSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: created, error } = await supabase
    .from("leads")
    .insert({
      org_id: profile.orgId,
      source: d.source,
      channel: d.channel ?? null,
      message: d.message ?? null,
      contact_id: d.contact_id ?? null,
      property_id: d.property_id ?? null,
    })
    .select("id")
    .single();
  if (error) return { error: error.message, savedAt: null };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "lead",
    entityId: created.id,
    eventType: "created",
    payload: { source: d.source, channel: d.channel ?? null },
  });

  revalidatePath("/leads");
  return { error: null, savedAt: Date.now() };
}

async function getLead(leadId: string) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const { data: lead } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (!lead) throw new Error("Lead not found");
  return { supabase, profile, lead };
}

export async function claimLead(leadId: string): Promise<void> {
  const { supabase, profile, lead } = await getLead(leadId);
  if (lead.assigned_agent_id && lead.assigned_agent_id !== profile.id) {
    throw new Error("Lead already assigned");
  }
  const { data, error } = await supabase
    .from("leads")
    .update({ assigned_agent_id: profile.id })
    .eq("id", leadId)
    .select("id");
  if (error || !data?.length) throw new Error(error?.message ?? "Claim blocked");

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "lead",
    entityId: leadId,
    eventType: "claimed",
    payload: {},
  });
  revalidatePath("/leads");
}

/** Stamps first_response_at exactly once (doc 02 §C4). */
export async function markContacted(leadId: string): Promise<void> {
  const { supabase, profile, lead } = await getLead(leadId);
  const updates: Database["public"]["Tables"]["leads"]["Update"] = {
    status: lead.status === "new" ? "contacted" : lead.status,
  };
  if (!lead.first_response_at) updates.first_response_at = new Date().toISOString();

  const { error } = await supabase.from("leads").update(updates).eq("id", leadId);
  if (error) throw new Error(error.message);

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "lead",
    entityId: leadId,
    eventType: "contacted",
    payload: { first_response: !lead.first_response_at },
  });
  revalidatePath("/leads");
}

export async function markCalled(leadId: string): Promise<void> {
  const { supabase, profile, lead } = await getLead(leadId);
  const updates: Database["public"]["Tables"]["leads"]["Update"] = {};
  if (!lead.first_call_at) updates.first_call_at = new Date().toISOString();
  if (!lead.first_response_at) updates.first_response_at = new Date().toISOString();
  if (lead.status === "new") updates.status = "contacted";

  if (Object.keys(updates).length > 0) {
    const { error } = await supabase.from("leads").update(updates).eq("id", leadId);
    if (error) throw new Error(error.message);
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "lead",
    entityId: leadId,
    eventType: "called",
    payload: { first_call: !lead.first_call_at },
  });
  revalidatePath("/leads");
}

const conversationSchema = z.object({
  lead_id: z.string().uuid(),
  channel: z.enum(COMM_CHANNELS),
  note: z.string().trim().min(1, "Note is required").max(5000),
});

export async function logConversation(
  _prev: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const parsed = conversationSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const { supabase, profile, lead } = await getLead(parsed.data.lead_id);

  if (!lead.first_response_at) {
    await supabase
      .from("leads")
      .update({
        first_response_at: new Date().toISOString(),
        status: lead.status === "new" ? "contacted" : lead.status,
      })
      .eq("id", lead.id);
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "lead",
    entityId: lead.id,
    eventType: "conversation_logged",
    payload: { channel: parsed.data.channel, note: parsed.data.note },
  });
  revalidatePath("/leads");
  revalidatePath(`/leads/${lead.id}`);
  return { error: null, savedAt: Date.now() };
}

const closeSchema = z.object({
  lead_id: z.string().uuid(),
  outcome: z.enum(["lost", "spam"]),
  reason: z.string().trim().max(500).optional(),
});

export async function closeLead(
  _prev: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const parsed = closeSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  if (parsed.data.outcome === "lost" && !parsed.data.reason) {
    return { error: "A reason is required to mark a lead lost", savedAt: null };
  }
  const { supabase, profile, lead } = await getLead(parsed.data.lead_id);

  const { error } = await supabase
    .from("leads")
    .update({ status: parsed.data.outcome, lost_reason: parsed.data.reason ?? null })
    .eq("id", lead.id);
  if (error) return { error: error.message, savedAt: null };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "lead",
    entityId: lead.id,
    eventType: parsed.data.outcome,
    payload: { reason: parsed.data.reason ?? null },
  });
  revalidatePath("/leads");
  return { error: null, savedAt: Date.now() };
}

/** WA/TG click-to-chat logging (T2.6 uses this too). */
export async function logChatLinkOpened(
  leadId: string | null,
  contactId: string | null,
  channel: "whatsapp" | "telegram",
): Promise<void> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: leadId ? "lead" : "contact",
    entityId: leadId ?? contactId,
    eventType: "chat_link_opened",
    payload: { channel },
  });
  if (leadId) revalidatePath(`/leads/${leadId}`);
}
