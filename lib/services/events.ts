import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";

/**
 * Append-only event log — the architectural spine (doc 01 §6.2).
 * EVERY mutation in the app calls logEvent(). A feature without its events is
 * not done (CLAUDE.md guardrail 1). Inserts only; the table has no UPDATE or
 * DELETE for any app role, and rows are hash-chained by a DB trigger.
 */

export const ENTITY_TYPES = [
  "organization",
  "user",
  "property",
  "contact",
  "lead",
  "deal",
  "viewing",
  "offer",
  "mandate",
  "key",
  "document",
  "task",
  "config",
  "share_link",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface LogEventParams {
  orgId: string;
  /** profiles.id of the acting user; null/undefined = system action */
  actorId?: string | null;
  entityType: EntityType;
  entityId?: string | null;
  /** e.g. 'created', 'updated', 'stage_changed', 'price_changed', 'viewing_slip_signed' */
  eventType: string;
  payload?: Json;
}

type Client = SupabaseClient<Database>;

/** Write one event row. Throws on failure — mutations must not silently lose their event. */
export async function logEvent(supabase: Client, params: LogEventParams): Promise<void> {
  const { error } = await supabase.from("events").insert({
    org_id: params.orgId,
    actor_id: params.actorId ?? null,
    entity_type: params.entityType,
    entity_id: params.entityId ?? null,
    event_type: params.eventType,
    payload: params.payload ?? {},
  });
  if (error) {
    throw new Error(`logEvent failed (${params.entityType}.${params.eventType}): ${error.message}`);
  }
}
