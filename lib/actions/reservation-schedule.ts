"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { buildSchedule } from "@/lib/services/payment-schedule";
import { createClient } from "@/lib/supabase/server";
import {
  applyPaymentPlanSchema,
  clearScheduleSchema,
  markInstallmentSchema,
  setInstallmentDueSchema,
} from "@/lib/validators/reservations";

/**
 * A reservation's payment schedule (0050).
 *
 * Its own module rather than more of `reservations.ts`, because these four
 * actions share one concern — the frozen schedule — and that file is already
 * about the hold's lifecycle.
 *
 * Events are written against the PROPERTY, matching every other reservation
 * action: `ENTITY_TYPES` has no `reservation` member, and a schedule is a fact
 * about the property a dispute will look at.
 */

export type ScheduleActionState = { error: string | null; savedAt: number | null };

const ok = (): ScheduleActionState => ({ error: null, savedAt: Date.now() });
const fail = (error: string): ScheduleActionState => ({ error, savedAt: null });

/** How many lines of this schedule are already marked paid. */
async function paidLineCount(
  supabase: Awaited<ReturnType<typeof createClient>>,
  reservationId: string,
): Promise<number> {
  const { count } = await supabase
    .from("reservation_installments")
    .select("id", { count: "exact", head: true })
    .eq("reservation_id", reservationId)
    .not("paid_at", "is", null);
  return count ?? 0;
}

/**
 * Apply a project's payment plan, FREEZING the amounts against today's price.
 *
 * A unit's asking price moves — `applyPriceUplift` moves sixty at once — and a
 * schedule already quoted to a buyer must not move with it. That is the whole
 * reason amounts are stored rather than recomputed on read.
 *
 * Re-applying REPLACES the schedule, and refuses once anything is paid:
 * rebuilding lines under a recorded payment would detach that payment from
 * whatever it was against.
 */
export async function applyPaymentPlan(
  _prev: ScheduleActionState,
  formData: FormData,
): Promise<ScheduleActionState> {
  const parsed = applyPaymentPlanSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return fail("Invalid request");
  const { reservation_id, payment_plan_id } = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: reservation } = await supabase
    .from("reservations")
    .select("id, property_id")
    .eq("id", reservation_id)
    .maybeSingle();
  if (!reservation) return fail("That reservation no longer exists.");

  if ((await paidLineCount(supabase, reservation_id)) > 0) {
    return fail(
      "Some instalments are already marked paid — un-mark them first, or the payments would no longer line up with the schedule.",
    );
  }

  const { data: plan } = await supabase
    .from("payment_plans")
    .select("id, name, installments")
    .eq("id", payment_plan_id)
    .maybeSingle();
  if (!plan) return fail("That payment plan is no longer available.");

  const { data: property } = await supabase
    .from("properties")
    .select("id, reference, asking_price")
    .eq("id", reservation.property_id)
    .maybeSingle();
  if (!property) return fail("That property is no longer available to you.");

  const price = property.asking_price === null ? 0 : Number(property.asking_price);
  const built = buildSchedule(
    (plan.installments ?? []) as { label: string; pct: number; due?: string | null }[],
    price,
  );
  if (built.lines.length === 0) {
    // An unpriced unit is real — 0041 ships one on purpose — so say which
    // problem it is rather than showing a schedule of zeros.
    return fail(
      price > 0
        ? "That plan has no usable instalments."
        : `${property.reference} has no asking price, so a schedule cannot be worked out yet.`,
    );
  }

  // Replaced wholesale: a partial overwrite could interleave two plans, and the
  // (reservation_id, sort_order) unique index would reject it halfway.
  const { error: clearErr } = await supabase
    .from("reservation_installments")
    .delete()
    .eq("reservation_id", reservation_id);
  if (clearErr) return fail(clearErr.message);

  const { error: insertErr } = await supabase.from("reservation_installments").insert(
    built.lines.map((l) => ({
      org_id: profile.orgId,
      reservation_id,
      sort_order: l.sortOrder,
      label: l.label,
      pct: l.pct,
      amount: l.amount,
      milestone: l.milestone,
      created_by: profile.id,
    })),
  );
  if (insertErr) return fail(insertErr.message);

  const { error: linkErr } = await supabase
    .from("reservations")
    .update({ payment_plan_id, updated_at: new Date().toISOString() })
    .eq("id", reservation_id);
  if (linkErr) return fail(linkErr.message);

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: reservation.property_id,
    eventType: "reservation_schedule_applied",
    payload: {
      reservation_id,
      plan: plan.name,
      lines: built.lines.length,
      total: built.scheduleTotal,
      total_pct: built.totalPct,
    },
  });
  revalidatePath(`/properties/${reservation.property_id}`);
  return ok();
}

/**
 * Mark one line paid, or un-mark it.
 *
 * `paid_at` and `paid_amount` always move together, because
 * `installment_paid_coherent` requires it: a line marked paid with no amount
 * makes "what is still outstanding?" unanswerable.
 */
export async function markInstallment(
  _prev: ScheduleActionState,
  formData: FormData,
): Promise<ScheduleActionState> {
  const parsed = markInstallmentSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid request");
  }
  const { installment_id, paid, paid_amount, note } = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: line } = await supabase
    .from("reservation_installments")
    .select("id, label, reservation_id, reservations(property_id)")
    .eq("id", installment_id)
    .maybeSingle();
  if (!line) return fail("That instalment no longer exists.");

  const nowIso = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("reservation_installments")
    .update({
      paid_at: paid ? nowIso : null,
      paid_amount: paid ? (paid_amount ?? null) : null,
      note: note ?? null,
      updated_at: nowIso,
    })
    .eq("id", installment_id)
    .select("id");
  if (error) return fail(error.message);
  if (!updated?.length) return fail("Instalment changed underneath — refresh and retry.");

  const joined = line.reservations as { property_id: string } | { property_id: string }[] | null;
  const propertyId = Array.isArray(joined) ? joined[0]?.property_id : joined?.property_id;

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId ?? null,
    eventType: paid ? "installment_paid" : "installment_unpaid",
    payload: {
      reservation_id: line.reservation_id,
      installment_id,
      label: line.label,
      amount: paid ? (paid_amount ?? null) : null,
    },
  });
  if (propertyId) revalidatePath(`/properties/${propertyId}`);
  return ok();
}

/**
 * Put a real date against a milestone.
 *
 * This is what instalment reminders will read: a plan's `due` is free text
 * ("On contract signing") and can never drive a clock, so the date has to be
 * agreed per reservation.
 *
 * NO EVENT, deliberately. Scheduling detail on a line the desk is still
 * arranging is not a state change worth a permanent row in an append-only log;
 * paying it is, and that writes one.
 */
export async function setInstallmentDue(
  _prev: ScheduleActionState,
  formData: FormData,
): Promise<ScheduleActionState> {
  const parsed = setInstallmentDueSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return fail("Enter a valid date, or leave it blank.");
  const { installment_id, due_date } = parsed.data;

  const supabase = await createClient();
  await getCurrentProfile(supabase);

  const { data: updated, error } = await supabase
    .from("reservation_installments")
    .update({ due_date: due_date ?? null, updated_at: new Date().toISOString() })
    .eq("id", installment_id)
    .select("id, reservations(property_id)");
  if (error) return fail(error.message);
  if (!updated?.length) return fail("Instalment changed underneath — refresh and retry.");

  const joined = updated[0]!.reservations as
    | { property_id: string }
    | { property_id: string }[]
    | null;
  const propertyId = Array.isArray(joined) ? joined[0]?.property_id : joined?.property_id;
  if (propertyId) revalidatePath(`/properties/${propertyId}`);
  return ok();
}

/** Remove the whole schedule. Refused once anything is paid. */
export async function clearSchedule(
  _prev: ScheduleActionState,
  formData: FormData,
): Promise<ScheduleActionState> {
  const parsed = clearScheduleSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return fail("Invalid request");
  const { reservation_id } = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: reservation } = await supabase
    .from("reservations")
    .select("id, property_id")
    .eq("id", reservation_id)
    .maybeSingle();
  if (!reservation) return fail("That reservation no longer exists.");

  if ((await paidLineCount(supabase, reservation_id)) > 0) {
    return fail("Instalments are marked paid — un-mark them before removing the schedule.");
  }

  // RLS filters a denied DELETE to zero rows rather than erroring, so the count
  // is what distinguishes "not allowed" from "nothing there".
  const { error, count } = await supabase
    .from("reservation_installments")
    .delete({ count: "exact" })
    .eq("reservation_id", reservation_id);
  if (error) return fail(error.message);
  if (!count) {
    return fail("Only an admin or listing manager can remove a schedule.");
  }

  await supabase
    .from("reservations")
    .update({ payment_plan_id: null, updated_at: new Date().toISOString() })
    .eq("id", reservation_id);

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: reservation.property_id,
    eventType: "reservation_schedule_cleared",
    payload: { reservation_id, lines: count },
  });
  revalidatePath(`/properties/${reservation.property_id}`);
  return ok();
}
