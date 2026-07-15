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

/**
 * Link (or replace) the contact on an existing lead — doc 02 §C4
 * "link/create contact". Allowed for admin or the assigned/claiming agent
 * (mirrors the leads UPDATE policy, doc 04). Not permitted once converted:
 * the contact is already carried on the resulting deal.
 */
export async function linkLeadContact(leadId: string, contactId: string): Promise<void> {
  const { supabase, profile, lead } = await getLead(leadId);
  if (lead.status === "converted") {
    throw new Error("Lead already converted — the contact lives on its deal.");
  }
  if (
    profile.role !== "admin" &&
    lead.assigned_agent_id &&
    lead.assigned_agent_id !== profile.id
  ) {
    throw new Error("Lead is assigned to another agent.");
  }

  // org-scoped by RLS; confirms the contact exists and gives a name for the event
  const { data: contact } = await supabase
    .from("contacts")
    .select("display_name")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) throw new Error("Contact not found.");

  const { data, error } = await supabase
    .from("leads")
    .update({ contact_id: contactId })
    .eq("id", leadId)
    .select("id");
  if (error || !data?.length) throw new Error(error?.message ?? "Link blocked");

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "lead",
    entityId: leadId,
    eventType: "contact_linked",
    payload: { contact_id: contactId, contact_name: contact.display_name ?? null },
  });
  revalidatePath("/leads");
}

/**
 * Reassign a lead to another agent — doc 02 §C4 "assign agent". Admin-only:
 * doc 04 test 11 denies an agent reassigning a lead away from themselves, so
 * the UI must not offer it to non-admins. (Agents self-assign via claimLead.)
 */
export async function reassignLead(leadId: string, agentId: string): Promise<void> {
  const { supabase, profile, lead } = await getLead(leadId);
  if (profile.role !== "admin") throw new Error("Admins only.");

  const { data: agent } = await supabase
    .from("profiles")
    .select("full_name, is_active")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent || !agent.is_active) throw new Error("Pick an active agent.");
  if (lead.assigned_agent_id === agentId) return; // no-op

  const { error } = await supabase
    .from("leads")
    .update({ assigned_agent_id: agentId })
    .eq("id", leadId);
  if (error) throw new Error(error.message);

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "lead",
    entityId: leadId,
    eventType: "assigned",
    payload: { from: lead.assigned_agent_id, to: agentId, to_name: agent.full_name },
  });
  revalidatePath("/leads");
}

/**
 * Admin correction for mis-clicks — doc 02 §C4 stamps first_response_at
 * "exactly once", so this is the only sanctioned way to undo it. Admin-only
 * on purpose: first_response_at feeds the dashboard speed KPI. The events log
 * is append-only (guardrail 1), so a correction is a new `corrected` event,
 * never a deletion.
 *   - resetResponse: clears first_response_at/first_call_at (and drops a lead
 *     back to "new" so it re-enters the awaiting-first-response queue)
 *   - reopen: pulls a lost/spam lead back to an open status, clears lost_reason
 */
export async function correctLead(
  leadId: string,
  opts: { resetResponse?: boolean; reopen?: boolean },
): Promise<void> {
  const { supabase, profile, lead } = await getLead(leadId);
  if (profile.role !== "admin") throw new Error("Admins only.");

  const updates: Database["public"]["Tables"]["leads"]["Update"] = {};
  let reopened = false;

  if (opts.reopen) {
    if (lead.status !== "lost" && lead.status !== "spam") {
      throw new Error("Only a lost or spam lead can be reopened.");
    }
    updates.status = lead.first_response_at ? "contacted" : "new";
    updates.lost_reason = null;
    reopened = true;
  }

  if (opts.resetResponse) {
    updates.first_response_at = null;
    updates.first_call_at = null;
    // a lead marked contacted only by that stamp returns to the new queue
    if (!opts.reopen && lead.status === "contacted") updates.status = "new";
  }

  if (Object.keys(updates).length === 0) throw new Error("Nothing to correct.");

  const { error } = await supabase.from("leads").update(updates).eq("id", leadId);
  if (error) throw new Error(error.message);

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "lead",
    entityId: leadId,
    eventType: "corrected",
    payload: { reset_response: Boolean(opts.resetResponse), reopened },
  });
  revalidatePath("/leads");
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

  // Conversations count as deal activity once the lead is converted — the
  // health activity factor decays from last_activity_at (doc 02 §C5, T3.3)
  if (lead.converted_deal_id) {
    await supabase
      .from("deals")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", lead.converted_deal_id);
    const { recomputeDealHealth } = await import("@/lib/services/health-score");
    await recomputeDealHealth(supabase, lead.converted_deal_id);
    revalidatePath(`/deals/${lead.converted_deal_id}`);
  }

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

const convertSchema = z.object({
  lead_id: z.string().uuid(),
  deal_type: z.enum(["sale", "rental", "antiparoxi", "advisory"]),
});

/** Convert a lead into a deal at the first stage of the chosen type (T2.5). */
export async function convertLead(
  _prev: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  const parsed = convertSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const { supabase, profile, lead } = await getLead(parsed.data.lead_id);

  if (lead.status === "converted") return { error: "Lead already converted", savedAt: null };
  if (!lead.contact_id) {
    return { error: "Link a contact to the lead before converting", savedAt: null };
  }

  const { data: stage } = await supabase
    .from("deal_stages")
    .select("id, name")
    .eq("deal_type", parsed.data.deal_type)
    .eq("is_won", false)
    .eq("is_lost", false)
    .order("sort_order")
    .limit(1)
    .maybeSingle();
  if (!stage) return { error: "No stages configured for this deal type", savedAt: null };

  const [{ data: contact }, { data: property }] = await Promise.all([
    supabase.from("contacts").select("display_name").eq("id", lead.contact_id).maybeSingle(),
    lead.property_id
      ? supabase.from("properties").select("reference").eq("id", lead.property_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const title = [contact?.display_name ?? "Deal", property?.reference]
    .filter(Boolean)
    .join(" — ");

  const { data: deal, error: dealErr } = await supabase
    .from("deals")
    .insert({
      org_id: profile.orgId,
      deal_type: parsed.data.deal_type,
      stage_id: stage.id,
      title,
      property_id: lead.property_id,
      buyer_contact_id: lead.contact_id,
      agent_id: lead.assigned_agent_id ?? profile.id,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (dealErr) return { error: dealErr.message, savedAt: null };

  const { error: leadErr } = await supabase
    .from("leads")
    .update({ status: "converted", converted_deal_id: deal.id })
    .eq("id", lead.id);
  if (leadErr) return { error: leadErr.message, savedAt: null };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "lead",
    entityId: lead.id,
    eventType: "converted",
    payload: { deal_id: deal.id, deal_type: parsed.data.deal_type },
  });
  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "deal",
    entityId: deal.id,
    eventType: "created",
    payload: { from_lead: lead.id, stage: stage.name, title },
  });

  revalidatePath("/leads");
  revalidatePath("/pipeline");
  return { error: null, savedAt: Date.now() };
}
