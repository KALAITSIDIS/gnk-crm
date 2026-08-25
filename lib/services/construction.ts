import { zonedParts } from "@/lib/utils/tz";

/**
 * Where a build has got to, and when it is due
 * (BACKLOG: *Construction progress + delivery date, S* — finding 10 made useful).
 *
 * PURE. No I/O.
 *
 * Finding 10 put `construction_status` and `delivery_date` on the Details tab
 * and the Overview facts, which made them editable and visible. What it did not
 * do is say what they MEAN together: a status is a word in a list, and "12 Mar
 * 2027" is a date until something works out that it is seven months away.
 *
 * ============================================================================
 * THE STAGES ARE NOT EVENLY SPACED, AND PRETENDING THEY ARE WOULD LIE.
 *
 * There are eight of them, so the tempting bar fills 12.5% per stage. That puts
 * `permit_granted` at 37.5% — for a project where NOTHING HAS BEEN BUILT. The
 * first three stages are paperwork; the building happens in the last five.
 *
 * The weights below reflect that. The shape is deliberate and simple: the three
 * stages where building actually happens — under_construction, structure_complete
 * and finishing — carry 25 points EACH, so the build itself is 75 of the 100.
 * Paperwork gets 10 between three stages, and handover the remaining 15.
 *
 * THEY ARE STILL A CONVENTION, NOT A SURVEY. Nobody measured that
 * `structure_complete` is 60% of the work; it is a defensible ordering of
 * milestones, and the UI says so rather than implying a quantity surveyor was
 * involved. Read it as "how far along the sequence", not "percent built".
 * ============================================================================
 *
 * A NON-STANDARD STATUS IS A REAL STATE, not an error. `construction_status` is
 * `text`, not an enum, and finding 10 deliberately keeps whatever a row already
 * holds as an "(as recorded)" option rather than dropping it. So an unknown
 * value is displayed as-is with NO stage and NO percentage — inventing a
 * position for a word nobody recognises is exactly the failure the free-text
 * column was preserved to avoid.
 */

export interface Milestone {
  key: string;
  label: string;
  /** how far along the SEQUENCE, weighted — see the header */
  pct: number;
}

export const CONSTRUCTION_MILESTONES: readonly Milestone[] = [
  { key: "planning", label: "Planning", pct: 0 },
  { key: "permit_applied", label: "Permit applied", pct: 5 },
  { key: "permit_granted", label: "Permit granted", pct: 10 },
  // the three building stages are 25 points each — 75 of the 100 between them
  { key: "under_construction", label: "Under construction", pct: 35 },
  { key: "structure_complete", label: "Structure complete", pct: 60 },
  { key: "finishing", label: "Finishing", pct: 85 },
  { key: "completed", label: "Completed", pct: 95 },
  // handed over: the only stage where the buyer has keys
  { key: "delivered", label: "Delivered", pct: 100 },
];

export interface BuildProgress {
  /** the raw stored value */
  status: string | null;
  /** true when the value is one of the standard milestones */
  known: boolean;
  /** the milestone's label, or the raw value humanised when it is not standard */
  label: string | null;
  /** 1-based position, null for a non-standard or absent status */
  stage: number | null;
  totalStages: number;
  /** weighted position, null when there is no recognised status */
  pct: number | null;
  deliveryDate: string | null;
  /** whole months until delivery; NEGATIVE means the date has passed */
  monthsToDelivery: number | null;
  /** delivery is in the past and the build is not finished */
  overdue: boolean;
  /**
   * The build says finished but the date has not arrived, or the reverse.
   * Neither is impossible — a project can hand over early — so this is worded
   * as something to look at, never as an error.
   */
  mismatch: string | null;
}

const humanise = (v: string) =>
  v.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Whole months between two `YYYY-MM-DD` days, signed. */
function monthsBetween(fromDay: string, toDay: string): number {
  const [fy, fm, fd] = fromDay.split("-").map(Number);
  const [ty, tm, td] = toDay.split("-").map(Number);
  let months = (ty! - fy!) * 12 + (tm! - fm!);
  // a part-month does not count until the day-of-month is reached, so
  // "1 Sep to 30 Sep" is 0 months away rather than optimistically 1
  if (td! < fd!) months -= 1;
  return months;
}

export function buildProgress(
  status: string | null | undefined,
  deliveryDate: string | null | undefined,
  now: Date = new Date(),
): BuildProgress {
  const raw = status?.trim() ? status.trim() : null;
  const idx = raw === null ? -1 : CONSTRUCTION_MILESTONES.findIndex((m) => m.key === raw);
  const known = idx >= 0;
  const milestone = known ? CONSTRUCTION_MILESTONES[idx]! : null;

  const delivery = deliveryDate?.trim() ? deliveryDate.trim().slice(0, 10) : null;
  // Cyprus wall-clock today: a delivery date is a calendar obligation there,
  // not a UTC instant (doc 02 §A11, same rule the retention page follows)
  const today = zonedParts(now).dayKey;
  const monthsToDelivery = delivery === null ? null : monthsBetween(today, delivery);

  const finished = known && (milestone!.key === "completed" || milestone!.key === "delivered");
  const overdue = monthsToDelivery !== null && monthsToDelivery < 0 && !finished;

  let mismatch: string | null = null;
  if (known && delivery !== null) {
    if (milestone!.key === "delivered" && monthsToDelivery! > 0) {
      mismatch = "Marked delivered, but the delivery date is still in the future.";
    } else if (!finished && monthsToDelivery !== null && monthsToDelivery < 0) {
      mismatch = "The delivery date has passed and the build is not recorded as finished.";
    }
  }

  return {
    status: raw,
    known,
    label: raw === null ? null : known ? milestone!.label : humanise(raw),
    stage: known ? idx + 1 : null,
    totalStages: CONSTRUCTION_MILESTONES.length,
    pct: known ? milestone!.pct : null,
    deliveryDate: delivery,
    monthsToDelivery,
    overdue,
    mismatch,
  };
}

/** True when there is anything worth rendering. */
export function hasBuildInfo(b: BuildProgress): boolean {
  return b.status !== null || b.deliveryDate !== null;
}
