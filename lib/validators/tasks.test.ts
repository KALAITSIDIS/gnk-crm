import { describe, expect, it } from "vitest";
import {
  ALL_DAY_TIME_REFUSED,
  ASSIGNEE_REFUSED,
  LINK_REFUSED,
  TIME_SKIPPED,
  TIME_WITHOUT_DATE,
  TITLE_REQUIRED,
  createTaskSchema,
  dueAtFrom,
  dueFormValues,
  formatTaskDue,
  isAllDayDue,
  isCalendarDay,
  isTaskStaffRole,
  sameDue,
  taskRights,
  updateTaskSchema,
  wallClockExists,
} from "./tasks";

/**
 * A task's due instant (A02). Every expected instant below is written out by
 * hand from the Cyprus rules — EET (UTC+2) in winter, EEST (UTC+3) from 01:00
 * UTC on the last Sunday of March to 01:00 UTC on the last Sunday of October;
 * in 2026 those Sundays are 29 March and 25 October — never computed by the
 * code under test.
 */

const ID = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f01";
const firstError = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? null : r.error!.issues[0]!.message;

describe("dueAtFrom: a Cyprus date, and an optional Cyprus time", () => {
  it("an all-day task is 23:59 on its Cyprus day — summer and winter", () => {
    expect(dueAtFrom("2026-10-01")).toBe("2026-10-01T20:59:00.000Z"); // EEST
    expect(dueAtFrom("2026-01-15")).toBe("2026-01-15T21:59:00.000Z"); // EET
    // the same instant the quick add has stamped since T5.5 (task-created-event-payload.test.ts)
    expect(dueAtFrom("2026-10-01", null)).toBe(dueAtFrom("2026-10-01"));
    expect(dueAtFrom("2026-10-01", "")).toBe(dueAtFrom("2026-10-01"));
  });

  it("a time of day is that wall-clock time in Nicosia", () => {
    expect(dueAtFrom("2026-10-01", "10:30")).toBe("2026-10-01T07:30:00.000Z");
    expect(dueAtFrom("2026-01-15", "10:30")).toBe("2026-01-15T08:30:00.000Z");
    expect(dueAtFrom("2026-10-01", "00:00")).toBe("2026-09-30T21:00:00.000Z");
  });

  it("spring forward (29 March 2026): 03:00–03:59 does not happen, and is refused", () => {
    expect(dueAtFrom("2026-03-29", "02:59")).toBe("2026-03-29T00:59:00.000Z"); // last EET minute
    expect(dueAtFrom("2026-03-29", "04:00")).toBe("2026-03-29T01:00:00.000Z"); // first EEST minute
    expect(wallClockExists("2026-03-29", "02:59")).toBe(true);
    expect(wallClockExists("2026-03-29", "04:00")).toBe(true);
    // what the converter would make of 03:30 — an hour later than typed — is
    // why the schema refuses it rather than storing it
    expect(dueAtFrom("2026-03-29", "03:30")).toBe("2026-03-29T01:30:00.000Z"); // = 04:30 EEST
    expect(wallClockExists("2026-03-29", "03:30")).toBe(false);
    expect(wallClockExists("2026-03-29", "03:00")).toBe(false);
    expect(
      firstError(createTaskSchema.safeParse({ title: "Call", due_date: "2026-03-29", due_time: "03:30" })),
    ).toBe(TIME_SKIPPED);
    // the day itself is fine all day: 23:59 EEST
    expect(dueAtFrom("2026-03-29")).toBe("2026-03-29T20:59:00.000Z");
  });

  it("fall back (25 October 2026): the repeated 03:xx is its second, EET, occurrence — deterministic", () => {
    expect(dueAtFrom("2026-10-25", "03:30")).toBe("2026-10-25T01:30:00.000Z"); // 03:30 EET
    expect(wallClockExists("2026-10-25", "03:30")).toBe(true);
    expect(createTaskSchema.safeParse({ title: "Call", due_date: "2026-10-25", due_time: "03:30" }).success).toBe(true);
    expect(dueAtFrom("2026-10-25", "02:30")).toBe("2026-10-24T23:30:00.000Z"); // still EEST
    expect(dueAtFrom("2026-10-25")).toBe("2026-10-25T21:59:00.000Z"); // 23:59 EET
  });
});

describe("the all-day sentinel", () => {
  it("reads 23:59 Cyprus as all day — the quick add's 23:59 and cyprusEndOfDay's 23:59:59 alike", () => {
    expect(isAllDayDue("2026-10-01T20:59:00.000Z")).toBe(true);
    expect(isAllDayDue("2026-10-01T20:59:59.000Z")).toBe(true);
    expect(isAllDayDue("2026-01-15T21:59:00+00:00")).toBe(true); // PostgREST's spelling
    expect(isAllDayDue("2026-10-01T07:30:00.000Z")).toBe(false);
    // 23:59 UTC is 02:59 Cyprus — not the sentinel
    expect(isAllDayDue("2026-10-01T23:59:00.000Z")).toBe(false);
    expect(isAllDayDue("not a date")).toBe(false);
  });

  it("formats an all-day task as its date and a timed one with its time", () => {
    expect(formatTaskDue("2026-10-01T20:59:00.000Z")).toBe("1 Oct 2026");
    expect(formatTaskDue("2026-10-01T07:30:00.000Z")).toBe("1 Oct 2026, 10:30");
    expect(formatTaskDue(null)).toBe("—");
    expect(formatTaskDue("garbage")).toBe("—");
  });

  it("prefills the edit form: an all-day task has no time", () => {
    expect(dueFormValues("2026-10-01T20:59:00.000Z")).toEqual({ due_date: "2026-10-01", due_time: "" });
    expect(dueFormValues("2026-10-01T07:30:00.000Z")).toEqual({ due_date: "2026-10-01", due_time: "10:30" });
    // 00:30 Cyprus is still the Cyprus day, though UTC says the day before
    expect(dueFormValues("2026-09-30T21:30:00.000Z")).toEqual({ due_date: "2026-10-01", due_time: "00:30" });
    expect(dueFormValues(null)).toEqual({ due_date: "", due_time: "" });
  });

  it("refuses 23:59 typed as a time — it would come back as 'all day'", () => {
    expect(
      firstError(createTaskSchema.safeParse({ title: "Call", due_date: "2026-10-01", due_time: "23:59" })),
    ).toBe(ALL_DAY_TIME_REFUSED);
    expect(createTaskSchema.safeParse({ title: "Call", due_date: "2026-10-01", due_time: "23:58" }).success).toBe(true);
  });

  it("compares due instants, not their spelling", () => {
    expect(sameDue("2026-10-01T20:59:00+00:00", "2026-10-01T20:59:00.000Z")).toBe(true);
    expect(sameDue("2026-10-01T20:59:00+00:00", "2026-10-01T07:30:00.000Z")).toBe(false);
    expect(sameDue(null, null)).toBe(true);
    expect(sameDue(null, "2026-10-01T20:59:00.000Z")).toBe(false);
  });
});

describe("createTaskSchema", () => {
  it("accepts a title alone, and treats blank fields as absent", () => {
    const r = createTaskSchema.safeParse({
      title: "  Call the owner  ",
      due_date: "",
      due_time: "",
      assignee_id: "",
      property_id: "",
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ title: "Call the owner" });
  });

  it("refuses a missing title, a malformed or impossible date and a malformed time", () => {
    expect(firstError(createTaskSchema.safeParse({ title: " a " }))).toBe(TITLE_REQUIRED);
    for (const due_date of ["2026-1-5", "05/01/2026", "2026-02-29", "2026-13-01"]) {
      expect(firstError(createTaskSchema.safeParse({ title: "Call", due_date })), due_date).toBe("Invalid due date");
    }
    for (const due_time of ["25:00", "10:3", "1030", "10:30:00", "24:00"]) {
      expect(
        firstError(createTaskSchema.safeParse({ title: "Call", due_date: "2026-10-01", due_time })),
        due_time,
      ).toBe("Invalid due time");
    }
  });

  it("a malformed field never reaches the converter (zod 4 refines the object anyway)", () => {
    // these threw "Invalid wall-clock datetime" from the object refinement
    // before checkDue re-checked the shapes
    expect(firstError(createTaskSchema.safeParse({ title: "Call", due_date: "2026-10-01", due_time: "10:3" }))).toBe(
      "Invalid due time",
    );
    expect(firstError(createTaskSchema.safeParse({ title: "Call", due_date: "2026-1-1", due_time: "10:30" }))).toBe(
      "Invalid due date",
    );
    expect(wallClockExists("2026-10-01", "10:3")).toBe(false);
    expect(wallClockExists("2026-02-30", "10:30")).toBe(false);
  });

  it("refuses a time with no date to put it on", () => {
    expect(firstError(createTaskSchema.safeParse({ title: "Call", due_time: "10:30" }))).toBe(TIME_WITHOUT_DATE);
  });

  it("refuses a malformed assignee or link instead of quietly dropping it", () => {
    expect(firstError(createTaskSchema.safeParse({ title: "Call", assignee_id: "maria" }))).toBe(ASSIGNEE_REFUSED);
    for (const col of ["property_id", "contact_id", "deal_id", "viewing_id", "lead_id"]) {
      expect(firstError(createTaskSchema.safeParse({ title: "Call", [col]: "x');--" })), col).toBe(LINK_REFUSED);
      expect(createTaskSchema.safeParse({ title: "Call", [col]: ID }).success, col).toBe(true);
    }
  });

  it("accepts the hosted organisation's style of id (z.guid, not z.uuid)", () => {
    expect(
      createTaskSchema.safeParse({ title: "Call", assignee_id: "11111111-1111-1111-1111-111111111111" }).success,
    ).toBe(true);
  });
});

describe("updateTaskSchema", () => {
  it("needs the task id; without a title it carries only the assignee", () => {
    expect(firstError(updateTaskSchema.safeParse({ task_id: "nope" }))).toBe("Task not found");
    const r = updateTaskSchema.safeParse({ task_id: ID, assignee_id: ID });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ task_id: ID, assignee_id: ID });
  });

  it("a posted title must be a title; an empty date clears the due date", () => {
    expect(firstError(updateTaskSchema.safeParse({ task_id: ID, title: "" }))).toBe(TITLE_REQUIRED);
    const r = updateTaskSchema.safeParse({ task_id: ID, title: "Call", due_date: "", due_time: "" });
    expect(r.data).toEqual({ task_id: ID, title: "Call" });
  });
});

describe("taskRights restates tasks_update and tasks_select (0032)", () => {
  const ME = "me";
  const human = { assignee_id: ME, created_by: ME, kind: null, is_done: false };

  it("the creator who holds a task may do everything", () => {
    expect(taskRights(human, { id: ME, role: "agent" })).toEqual({
      complete: true,
      editDetails: true,
      reassign: true,
    });
  });

  it("the holder of a task someone else made may tick and edit it, not hand it on", () => {
    expect(taskRights({ ...human, created_by: "boss" }, { id: ME, role: "agent" })).toEqual({
      complete: true,
      editDetails: true,
      reassign: false,
    });
  });

  it("the creator of a task given to someone else may only look at it", () => {
    expect(taskRights({ ...human, assignee_id: "colleague" }, { id: ME, role: "listing_manager" })).toEqual({
      complete: false,
      editDetails: false,
      reassign: false,
    });
  });

  it("an admin may do everything to anyone's task", () => {
    expect(
      taskRights({ assignee_id: "colleague", created_by: null, kind: null, is_done: false }, { id: ME, role: "admin" }),
    ).toEqual({ complete: true, editDetails: true, reassign: true });
  });

  it("a system task keeps its title and date — reassign only, by the same rule", () => {
    const nudge = { assignee_id: ME, created_by: null, kind: "deal_no_contact", is_done: false };
    expect(taskRights(nudge, { id: ME, role: "agent" })).toEqual({
      complete: true,
      editDetails: false,
      reassign: false, // created_by null: nobody but an admin can hand it on
    });
    expect(taskRights(nudge, { id: ME, role: "admin" })).toEqual({
      complete: true,
      editDetails: false,
      reassign: true,
    });
  });

  it("a done task can be reopened by who may complete it, and nothing else", () => {
    expect(taskRights({ ...human, is_done: true }, { id: ME, role: "admin" })).toEqual({
      complete: true,
      editDetails: false,
      reassign: false,
    });
  });

  it("staff roles work tasks; the owner portal does not", () => {
    expect(["admin", "agent", "listing_manager"].map(isTaskStaffRole)).toEqual([true, true, true]);
    expect(isTaskStaffRole("owner_portal")).toBe(false);
    expect(isTaskStaffRole(null)).toBe(false);
  });
});

describe("isCalendarDay", () => {
  it("knows which days exist", () => {
    expect(isCalendarDay("2028-02-29")).toBe(true);
    expect(isCalendarDay("2026-02-29")).toBe(false);
    expect(isCalendarDay("2026-04-31")).toBe(false);
    expect(isCalendarDay("2026-12-31")).toBe(true);
  });
});
