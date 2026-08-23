"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createClient } from "@/lib/supabase/server";
import {
  RESERVATION_TRANSITIONS,
  createReservationSchema,
  cyprusEndOfDay,
  extendReservationSchema,
  isLiveReservation,
  transitionReservationSchema,
  type ReservationStatus,
} from "@/lib/validators/reservations";

/**
 * Reservations (0044, T-C3).
 *
 * Events are written against the PROPERTY, matching what the nightly sweep
 * does: `ENTITY_TYPES` has no `reservation` member, and a hold is a fact about
 * the property, which is where a later dispute will look for it.
 *
 * Guardrail 1: every mutation here writes its event.
 */

export type ReservationActionState = { error: string | null; savedAt: number | null };

const ok = (): ReservationActionState => ({ error: null, savedAt: Date.now() });
const fail = (error: string): ReservationActionState => ({ error, savedAt: null });

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * The single most likely error a user will hit, and a raw driver message is
 * not an answer. The partial unique index is deliberate, so its violation gets
 * a sentence that says what to do about it.
 */
function humaniseInsertError(error: { code?: string; message: string }): string {
  if (error.code === UNIQUE_VIOLATION || /reservations_one_live_per_property/.test(error.message)) {
    return "This property already has a live reservation. Release or confirm the existing one first.";
  }
  if (/reservation_window_ordered/.test(error.message)) {
    return "The hold must expire after it starts.";
  }
  return error.message;
}

export async function createReservation(
  _prev: ReservationActionState,
  formData: FormData,
): Promise<ReservationActionState> {
  const parsed = createReservationSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid reservation");
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // Re-read under RLS: a form can post any property id, and failing here gives
  // a sentence rather than a driver error.
  const { data: property } = await supabase
    .from("properties")
    .select("id, reference, kind")
    .eq("id", d.property_id)
    .maybeSingle();
  if (!property) return fail("That property is no longer available to you.");
  if (property.kind === "project" || property.kind === "phase") {
    // A container is not a thing anyone holds; its units are.
    return fail(`A ${property.kind} cannot be reserved — reserve one of its units instead.`);
  }

  // Cyprus end-of-day, not midnight UTC: a hold agreed "until Friday" must last
  // through Friday (see cyprusEndOfDay).
  const expiresAt = cyprusEndOfDay(d.expires_on);
  if (expiresAt.getTime() <= Date.now()) {
    return fail("That date has already passed — pick a later one.");
  }

  const { data: created, error } = await supabase
    .from("reservations")
    .insert({
      org_id: profile.orgId,
      property_id: d.property_id,
      contact_id: d.contact_id ?? null,
      deal_id: d.deal_id ?? null,
      offer_id: d.offer_id ?? null,
      status: "held",
      amount: d.amount ?? null,
      expires_at: expiresAt.toISOString(),
      notes: d.notes ?? null,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error) return fail(humaniseInsertError(error));

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: d.property_id,
    eventType: "reservation_created",
    payload: {
      reservation_id: created.id,
      contact_id: d.contact_id ?? null,
      amount: d.amount ?? null,
      expires_at: expiresAt.toISOString(),
    },
  });
  revalidatePath(`/properties/${d.property_id}`);
  return ok();
}

/** Push the expiry out. Only a LIVE hold can be extended — a lapsed one is history. */
export async function extendReservation(
  _prev: ReservationActionState,
  formData: FormData,
): Promise<ReservationActionState> {
  const parsed = extendReservationSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return fail("Invalid request");
  const { reservation_id, expires_on } = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: existing } = await supabase
    .from("reservations")
    .select("id, property_id, status, expires_at")
    .eq("id", reservation_id)
    .maybeSingle();
  if (!existing) return fail("That reservation no longer exists.");
  if (!isLiveReservation(existing.status as ReservationStatus)) {
    return fail(`A ${existing.status} reservation cannot be extended — take a new one instead.`);
  }

  const expiresAt = cyprusEndOfDay(expires_on);
  if (expiresAt.getTime() <= Date.now()) {
    return fail("That date has already passed — pick a later one.");
  }

  const { data: updated, error } = await supabase
    .from("reservations")
    .update({ expires_at: expiresAt.toISOString(), updated_at: new Date().toISOString() })
    .eq("id", reservation_id)
    .select("id");
  if (error) return fail(humaniseInsertError(error));
  if (!updated?.length) return fail("Reservation changed underneath — refresh and retry.");

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: existing.property_id,
    eventType: "reservation_extended",
    payload: {
      reservation_id,
      from: existing.expires_at,
      to: expiresAt.toISOString(),
    },
  });
  revalidatePath(`/properties/${existing.property_id}`);
  return ok();
}

/**
 * Confirm, release or convert.
 *
 * The transition table is enforced HERE and not only in the UI: a form can
 * post any target, and terminal states must stay terminal or the partial
 * unique index becomes reachable from a direction it does not expect.
 */
export async function transitionReservation(
  _prev: ReservationActionState,
  formData: FormData,
): Promise<ReservationActionState> {
  const parsed = transitionReservationSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return fail("Invalid request");
  const { reservation_id, to, release_reason } = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: existing } = await supabase
    .from("reservations")
    .select("id, property_id, status")
    .eq("id", reservation_id)
    .maybeSingle();
  if (!existing) return fail("That reservation no longer exists.");

  const from = existing.status as ReservationStatus;
  if (!RESERVATION_TRANSITIONS[from].includes(to)) {
    return fail(
      RESERVATION_TRANSITIONS[from].length === 0
        ? `A ${from} reservation is final — take a new hold instead.`
        : `A ${from} reservation cannot become ${to}.`,
    );
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("reservations")
    .update({
      status: to,
      // leaving a live state stamps when it happened; confirming does not
      released_at: isLiveReservation(to) ? null : nowIso,
      release_reason: isLiveReservation(to) ? null : (release_reason ?? null),
      updated_at: nowIso,
    })
    .eq("id", reservation_id)
    // conditional on the status we read, so a concurrent transition loses
    // rather than both appearing to succeed
    .eq("status", from)
    .select("id");
  if (error) return fail(humaniseInsertError(error));
  if (!updated?.length) return fail("Reservation changed underneath — refresh and retry.");

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: existing.property_id,
    eventType: "reservation_status_changed",
    payload: { reservation_id, from, to, reason: release_reason ?? null },
  });
  revalidatePath(`/properties/${existing.property_id}`);
  return ok();
}
