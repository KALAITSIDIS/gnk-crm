import { z } from "zod";
import { SELECT_NONE } from "@/lib/validators/contacts";
import { zonedWallClockToUtc, zonedParts } from "@/lib/utils/tz";
import { addDayKey } from "@/lib/services/calendar-window";

/**
 * Reservations (0044, T-C3).
 *
 * The transition table mirrors `OFFER_TRANSITIONS` in deals.ts deliberately —
 * same shape, same rule that terminal states have none. A desk that has learned
 * "a decided offer is never reopened" should not have to learn a different rule
 * for a lapsed hold.
 */

export const RESERVATION_STATUSES = [
  "held",
  "confirmed",
  "expired",
  "released",
  "converted",
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * Allowed transitions. Terminal states have none: an expired or released hold
 * is never reopened, because re-opening it would have to dodge the partial
 * unique index and, more to the point, the property may have been re-reserved
 * in the meantime. Take a NEW hold instead — the old row stays as history.
 */
export const RESERVATION_TRANSITIONS: Record<
  ReservationStatus,
  readonly ReservationStatus[]
> = {
  held: ["confirmed", "released", "expired", "converted"],
  confirmed: ["released", "expired", "converted"],
  expired: [],
  released: [],
  converted: [],
};

/** The states that occupy a property — what the partial unique index indexes. */
export const LIVE_RESERVATION_STATUSES: readonly ReservationStatus[] = ["held", "confirmed"];

export const isLiveReservation = (s: ReservationStatus): boolean =>
  LIVE_RESERVATION_STATUSES.includes(s);

const emptyToUndefined = (v: unknown) =>
  v === "" || v === null || v === SELECT_NONE ? undefined : v;

/** `Number("")` is 0 — a blank deposit must stay unset, not become €0. */
const optNumber = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
  z.number().min(0).finite().optional(),
);
const optText = (max: number) => z.preprocess(emptyToUndefined, z.string().max(max).optional());

export const createReservationSchema = z.object({
  property_id: z.guid(),
  contact_id: z.preprocess(emptyToUndefined, z.guid().optional()),
  deal_id: z.preprocess(emptyToUndefined, z.guid().optional()),
  offer_id: z.preprocess(emptyToUndefined, z.guid().optional()),
  amount: optNumber,
  /** a date, not a duration: "until Friday" is what the desk actually agrees */
  expires_on: z.iso.date(),
  notes: optText(2000),
});

export const extendReservationSchema = z.object({
  reservation_id: z.guid(),
  expires_on: z.iso.date(),
});

export const transitionReservationSchema = z.object({
  reservation_id: z.guid(),
  to: z.enum(RESERVATION_STATUSES),
  release_reason: optText(300),
});

/**
 * Cyprus end-of-day for a date the desk typed.
 *
 * A hold agreed "until Friday" must last THROUGH Friday. Stamping midnight UTC
 * would expire it on Thursday evening Cyprus time — the same class of bug 0012
 * and 0020 fixed for task due dates, which is why those carry Cyprus
 * end-of-day stamps rather than plain dates.
 *
 * DELEGATES TO tz.ts AND DOES NOT RE-DERIVE THE OFFSET. The first version of
 * this hardcoded `+03:00`, which is right in summer and an hour wrong every
 * winter — Cyprus is EET (UTC+2) outside DST. `zonedWallClockToUtc` settles the
 * offset in two passes so a date on the far side of a DST switch resolves
 * correctly, and HANDOFF's standing rule is that this boundary has exactly one
 * home.
 */
export function cyprusEndOfDay(isoDate: string): Date {
  return zonedWallClockToUtc(`${isoDate}T23:59:59`);
}

/**
 * End of the Cyprus day that is current NOW — what every "due today" prompt
 * actually wants.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day, and Cyprus is UTC+2/+3.
 * Between midnight and 03:00 local the UTC date is still YESTERDAY, so that
 * expression yields an end-of-day already two or three hours past, and a task
 * stamped with it is born overdue — in exactly the window the end-of-day rule
 * exists to protect. Three prompt raisers had that hole; this is the one
 * definition they now share.
 */
export function cyprusEndOfToday(now: Date = new Date()): Date {
  return cyprusEndOfDay(zonedParts(now).dayKey);
}

/**
 * End of the Cyprus day AFTER the current one — what a "worth acting on, but not
 * today" prompt wants.
 *
 * The sibling of the bug above, and it was still open one file over:
 * `new Date(Date.now() + 864e5).toISOString().slice(0, 10)` steps 24 hours and
 * then takes the UTC day of the result, so between Cyprus midnight and 03:00 it
 * names TODAY — and the task is due tonight instead of tomorrow night, born
 * roughly a day short of the grace its own comment promises. Cyprus is always
 * ahead of UTC, so the error only ever runs early, never late.
 *
 * Stepping the Cyprus DAY KEY rather than the instant also survives the DST
 * changeover: `addDayKey` does its arithmetic at UTC noon, so the 23-hour and
 * 25-hour days at the end of March and October still advance by exactly one day.
 */
export function cyprusEndOfTomorrow(now: Date = new Date()): Date {
  return cyprusEndOfDay(addDayKey(zonedParts(now).dayKey, 1));
}

// ---------------------------------------------------------------- schedule --

export const applyPaymentPlanSchema = z.object({
  reservation_id: z.guid(),
  payment_plan_id: z.guid(),
});

export const clearScheduleSchema = z.object({
  reservation_id: z.guid(),
});

/**
 * Mark one line paid, or un-mark it.
 *
 * `paid` and `paid_amount` move together because the DB constraint
 * `installment_paid_coherent` requires it: a line marked paid with no amount
 * makes "what is outstanding?" unanswerable.
 */
export const markInstallmentSchema = z
  .object({
    installment_id: z.guid(),
    paid: z.preprocess((v) => v === "on" || v === true || v === "true", z.boolean()),
    paid_amount: optNumber,
    note: optText(500),
  })
  .refine((d) => !d.paid || d.paid_amount !== undefined, {
    message: "Say how much was paid",
    path: ["paid_amount"],
  });

export const setInstallmentDueSchema = z.object({
  installment_id: z.guid(),
  /** blank clears it — a milestone with no agreed date is normal */
  due_date: z.preprocess(emptyToUndefined, z.iso.date().optional()),
});
