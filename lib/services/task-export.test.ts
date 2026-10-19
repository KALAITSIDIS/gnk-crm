import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { taskCsvColumns, taskExportSlug, type TaskExportRow } from "./task-export";

const base: TaskExportRow = {
  title: "Call back Savvides re offer",
  due_at: "2026-07-25T15:00:00Z",
  is_done: false,
  done_at: null,
  kind: null,
  created_at: "2026-07-20T09:00:00Z",
  properties: { reference: "PAF0001" },
  assignee: { full_name: "Maria Agent", is_active: true },
};

const line = (csv: string, i = 1) => csv.replace(/^﻿/, "").split("\r\n")[i];
const rowOf = (row: TaskExportRow) => line(toCsv(taskCsvColumns(), [row]));

describe("taskCsvColumns", () => {
  it("names every column in the header — Assignee appended last (A02)", () => {
    expect(line(toCsv(taskCsvColumns(), []), 0)).toBe(
      "Title,Status,Due,Done at,Property,Auto,Created,Assignee",
    );
  });

  it("renders an open manual task with its due date and property", () => {
    const row = rowOf(base);
    expect(row).toContain("Call back Savvides re offer");
    expect(row).toContain("open");
    expect(row).toContain("PAF0001");
  });

  it("marks a done task, and names the rule behind a system-generated one", () => {
    expect(rowOf({ ...base, is_done: true, done_at: "2026-07-24T10:00:00Z" })).toContain("done");

    // Auto is the 6th column → after Property. It carries the rule slug, so the
    // three nudge types are distinguishable in a spreadsheet (B7).
    expect(rowOf({ ...base, kind: "mandate_renewal" })).toContain(",mandate_renewal,");
    expect(rowOf({ ...base, kind: "deal_no_contact" })).toContain(",deal_no_contact,");
    expect(rowOf({ ...base, kind: "viewing_feedback" })).toContain(",viewing_feedback,");
    // a human-typed task stays blank
    expect(rowOf(base)).toContain(",,");
  });

  it("reads Due as the page does: the date for an all-day task, date and time for a timed one", () => {
    // 23:59 Cyprus on 1 October 2026 (EEST, UTC+3) is the all-day sentinel
    const allDay = rowOf({ ...base, due_at: "2026-10-01T20:59:00.000Z" });
    expect(allDay.split(",")[2]).toBe("1 Oct 2026");
    expect(allDay).not.toContain("23:59");
    // 10:30 Cyprus the same day: the time is part of the task (quoted: it holds a comma)
    expect(rowOf({ ...base, due_at: "2026-10-01T07:30:00.000Z" })).toContain('"1 Oct 2026, 10:30"');
  });

  it("names the holder, says when they are deactivated, and leaves an unassigned task blank", () => {
    const last = (row: TaskExportRow) => rowOf(row).split(",").at(-1);
    expect(last(base)).toBe("Maria Agent");
    expect(last({ ...base, assignee: { full_name: "Old Hand", is_active: false } })).toBe("Old Hand (inactive)");
    expect(last({ ...base, assignee: null })).toBe("");
  });
});

describe("taskExportSlug", () => {
  it("keeps my-tasks for the default view and names any other", () => {
    expect(taskExportSlug({ scope: "mine", due: null })).toBe("my-tasks");
    expect(taskExportSlug({ scope: "delegated", due: null })).toBe("delegated-tasks");
    expect(taskExportSlug({ scope: "team", due: "overdue" })).toBe("team-tasks-overdue");
    expect(taskExportSlug({ scope: "mine", due: "week" })).toBe("my-tasks-week");
  });
});
