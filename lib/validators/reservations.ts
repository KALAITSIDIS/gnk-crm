import { z } from "zod";
import { SELECT_NONE } from "@/lib/validators/contacts";
import { zonedWallClockToUtc } from "@/lib/utils/tz";

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
