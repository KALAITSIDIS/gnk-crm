import { z } from "zod";
import { isGuid } from "@/lib/validators/ids";
import { formatDate, formatDateTime } from "@/lib/utils/format";
import { zonedParts, zonedWallClockToUtc } from "@/lib/utils/tz";

/**
 * Tasks a person types (A02). The task row has had an assignee, a timestamp
 * due date and links to every record kind since 0001–0098; what was missing
 * was the form, the edit and the rules below.
 *
 * ─── THE DUE INSTANT ─────────────────────────────────────────────────────────
 * `tasks.due_at` is one timestamptz. There is no due-time column, and none is
 * needed: since T5.5 a date-only task is stamped Cyprus 23:59 of its day, and
 * every sweep and nudge stamps the same wall-clock time (0012, 0020 and their
 * successors in SQL; `cyprusEndOfDay` in TS stamps 23:59:59). So 23:59 in Cyprus
 * IS the "all day" sentinel, and every row already in the table reads
 * correctly with no backfill: a task due at any other time of day was given
 * that time on purpose. The cost is that nobody can ask for exactly 23:59 —
 * the form refuses it and says why, rather than storing a time that would
 * then display as "all day".
 *
 * The date is the CYPRUS day (memory "Cyprus day vs UTC day";
 * tests/unit/due-at-is-a-cyprus-day.test.ts): `zonedWallClockToUtc` reads the
 * typed date and time as Asia/Nicosia wall-clock time, so the stamp is right on
 * a UTC server and on either side of a DST switch.
 *
 * ─── WHO MAY DO WHAT ──────────────────────────────────────────────────────────
 * `taskRights` restates the RLS policies (0032) so the page offers only the
 * controls that will work — the database stays the authority:
 *   - tasks_update USING (admin OR assignee): only the assignee or an admin
 *     completes or edits a task. Its creator sees a task they delegated
 *     (tasks_select's creator arm) but cannot change it.
 *   - tasks_update has no new-row check of its own, but an UPDATE that reads
 *     the row must leave it visible under tasks_select (Postgres applies the
 *     SELECT policy to the new row and raises 42501 otherwise — measured on the
 *     iso stack, 2026-10-18). So a non-admin can hand on only a task they
 *     created AND hold: anyone else's would vanish from their own sight.
 *   - A system task (`kind` set) keeps the title and due date its rule gave it.
 *     The due DATE is the sweep's cycle key — `(due_at at time zone
 *     'Asia/Nicosia')::date = expiry_date` and its siblings (0012, 0020, …):
 *     moving it makes the next sweep supersede the task and mint a second one.
 *     Its assignee may change, by the same rule as any task's.
 */

/** The roles that work tasks: the staff roles of `user_role`, not `owner_portal`. */
export const TASK_STAFF_ROLES = ["admin", "agent", "listing_manager"] as const;

export function isTaskStaffRole(role: unknown): boolean {
  return typeof role === "string" && (TASK_STAFF_ROLES as readonly string[]).includes(role);
}

/** The Cyprus wall-clock time that means "due some time that day". */
export const ALL_DAY_TIME = "23:59";

export const TITLE_REQUIRED = "Task title is required";
export const ALL_DAY_TIME_REFUSED =
  "23:59 means “all day” here — leave the time empty, or pick 23:58.";
export const TIME_WITHOUT_DATE = "Pick a due date for that time.";
export const TIME_SKIPPED =
  "That time does not exist in Cyprus on that day — the clocks go forward an hour. Pick another time.";
export const ASSIGNEE_REFUSED = "Pick an active colleague.";
export const LINK_REFUSED = "That record no longer exists.";
export const SYSTEM_TASK_FIXED =
  "An automatic reminder keeps the title and due date its rule set — you can only reassign it.";
export const EDIT_REFUSED = "Only its assignee or an admin can edit this task.";
export const REASSIGN_REFUSED =
  "Only an admin can reassign this task — you can hand on only a task you created for yourself.";
export const DONE_REFUSED = "This task is done — reopen it to edit it.";
export const STALE_REFUSED =
  "This task changed while you were editing it — nothing was saved. Reload and try again.";
/** The edit was refused before or while it ran (`certainlyRolledBack`): nothing changed. */
export const SAVE_REFUSED = "The task could not be saved — nothing was changed. Try again.";
/**
 * The edit's answer did not settle it — a hollow answer, a gateway's words, a
 * code that can follow a commit — and the row read back does not hold it. It
 * may be saved, or be saved yet; "nothing was saved" would invite a retry that
 * finds nothing to change and records nothing (A02 review).
 */
export const SAVE_UNCONFIRMED =
  "Could not confirm whether the task was saved — reload the page to see it before trying again.";

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_SHAPE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real calendar day "YYYY-MM-DD" — `2026-02-31` has the shape and is not one. */
export function isCalendarDay(key: string): boolean {
  if (!DATE_SHAPE.test(key)) return false;
  const [y, m, d] = key.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/** The due instant for a Cyprus date and an optional Cyprus time (none = all day). */
export function dueAtFrom(date: string, time?: string | null): string {
  return zonedWallClockToUtc(`${date}T${time || ALL_DAY_TIME}`).toISOString();
}

/**
 * Whether a Cyprus wall-clock time happens on that day. On the last Sunday of
 * March the clocks jump from 03:00 to 04:00, so 03:00–03:59 never happens;
 * `zonedWallClockToUtc` would settle such a time an hour later, and the task
 * would show a time nobody typed. Refused instead. The repeated hour in
 * October is not refused: it resolves to its second (EET) occurrence, which
 * reads back as the time typed (lib/validators/tasks.test.ts pins both).
 */
export function wallClockExists(date: string, time: string): boolean {
  if (!isCalendarDay(date) || !TIME_SHAPE.test(time)) return false;
  const back = zonedParts(dueAtFrom(date, time));
  return back.dayKey === date && back.timeLabel === time;
}

const isValidInstant = (iso: string): boolean => !Number.isNaN(new Date(iso).getTime());

/** An all-day task: its due instant is 23:59 on its Cyprus day. */
export function isAllDayDue(iso: string): boolean {
  return isValidInstant(iso) && zonedParts(iso).timeLabel === ALL_DAY_TIME;
}

/** "18 Oct 2026" for an all-day task, "18 Oct 2026, 10:30" for one with a time. */
export function formatTaskDue(iso: string | null | undefined): string {
  if (!iso || !isValidInstant(iso)) return "—";
  return isAllDayDue(iso) ? formatDate(iso) : formatDateTime(iso);
}

/** The edit form's date and time fields for a stored due instant ("" = none). */
export function dueFormValues(iso: string | null): { due_date: string; due_time: string } {
  if (!iso || !isValidInstant(iso)) return { due_date: "", due_time: "" };
  const parts = zonedParts(iso);
  return { due_date: parts.dayKey, due_time: parts.timeLabel === ALL_DAY_TIME ? "" : parts.timeLabel };
}

/** Two due instants name the same moment (null = undated). */
export function sameDue(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

// ---------------------------------------------------------------- schemas --

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** An id from a form: absent or blank is "none"; anything else must be one. */
const formId = (message: string) =>
  z.preprocess(blankToUndefined, z.string().refine(isGuid, message).optional());

const title = z.string().trim().min(2, TITLE_REQUIRED).max(300, "Keep the title under 300 characters");

const dueFields = {
  due_date: z.preprocess(
    blankToUndefined,
    z.string().refine(isCalendarDay, "Invalid due date").optional(),
  ),
  due_time: z.preprocess(
    blankToUndefined,
    z
      .string()
      .regex(TIME_SHAPE, "Invalid due time")
      .refine((t) => t !== ALL_DAY_TIME, ALL_DAY_TIME_REFUSED)
      .optional(),
  ),
};

/**
 * Zod 4 runs an object's refinement even when a field already failed, with
 * that field's raw value — so the shapes are checked again here before any
 * value reaches the converter (which throws on a malformed one).
 */
function checkDue(d: { due_date?: string; due_time?: string }, ctx: z.RefinementCtx) {
  if (typeof d.due_time !== "string" || !TIME_SHAPE.test(d.due_time)) return;
  if (d.due_date === undefined) {
    ctx.addIssue({ code: "custom", message: TIME_WITHOUT_DATE, path: ["due_time"] });
  } else if (isCalendarDay(d.due_date) && !wallClockExists(d.due_date, d.due_time)) {
    ctx.addIssue({ code: "custom", message: TIME_SKIPPED, path: ["due_time"] });
  }
}

/**
 * Quick add and "Add task" on a record. `assignee_id` blank = the creator. The
 * links are the records the task concerns; the action reads each one through
 * RLS before the insert names it (verify-then-insert).
 */
export const createTaskSchema = z
  .object({
    title,
    ...dueFields,
    assignee_id: formId(ASSIGNEE_REFUSED),
    property_id: formId(LINK_REFUSED),
    contact_id: formId(LINK_REFUSED),
    deal_id: formId(LINK_REFUSED),
    viewing_id: formId(LINK_REFUSED),
    lead_id: formId(LINK_REFUSED),
  })
  .superRefine(checkDue);
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/**
 * The edit dialog. `title` present = the form carries the details (title, date,
 * time — an empty date clears the due date); absent = it carries only the
 * assignee, which is all a system task's dialog offers. `assignee_id` blank
 * or absent = unchanged.
 */
export const updateTaskSchema = z
  .object({
    task_id: z.string().refine(isGuid, "Task not found"),
    title: title.optional(),
    ...dueFields,
    assignee_id: formId(ASSIGNEE_REFUSED),
  })
  .superRefine(checkDue);
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

// ----------------------------------------------------------------- rights --

export interface TaskRightsInput {
  assignee_id: string | null;
  created_by: string | null;
  kind: string | null;
  is_done: boolean;
}

export interface TaskRights {
  /** tick done / reopen — the assignee or an admin */
  complete: boolean;
  /** change the title and due date — the same people, a human task, still open */
  editDetails: boolean;
  /** hand it to someone else — an admin, or the creator who also holds it */
  reassign: boolean;
}

export function taskRights(task: TaskRightsInput, me: { id: string; role: string }): TaskRights {
  const admin = me.role === "admin";
  const holds = task.assignee_id === me.id;
  const complete = admin || holds;
  return {
    complete,
    editDetails: complete && !task.is_done && task.kind === null,
    reassign: !task.is_done && (admin || (holds && task.created_by === me.id)),
  };
}

/** Someone a task can be given to: an active staff member of the organisation. */
export interface TaskAssignee {
  id: string;
  fullName: string;
}
