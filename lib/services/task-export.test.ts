import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { taskCsvColumns, type TaskExportRow } from "./task-export";

const base: TaskExportRow = {
  title: "Call back Savvides re offer",
  due_at: "2026-07-25T15:00:00Z",
  is_done: false,
  done_at: null,
  kind: null,
  created_at: "2026-07-20T09:00:00Z",
  properties: { reference: "GNK-PAF-0001" },
};

const line = (csv: string, i = 1) => csv.replace(/^﻿/, "").split("\r\n")[i];

describe("taskCsvColumns", () => {
  it("names every column in the header", () => {
    expect(line(toCsv(taskCsvColumns(), []), 0)).toBe(
      "Title,Status,Due,Done at,Property,Auto,Created",
    );
  });

  it("renders an open manual task with its due date and property", () => {
    const csv = toCsv(taskCsvColumns(), [base]);
    const row = line(csv);
    expect(row).toContain("Call back Savvides re offer");
    expect(row).toContain("open");
    expect(row).toContain("GNK-PAF-0001");
  });

  it("marks a done task, and names the rule behind a system-generated one", () => {
    const done = toCsv(taskCsvColumns(), [
      { ...base, is_done: true, done_at: "2026-07-24T10:00:00Z" },
    ]);
    expect(done).toContain("done");

    // Auto is the 6th column → after Property. It carries the rule slug, so the
    // three nudge types are distinguishable in a spreadsheet (B7).
    expect(line(toCsv(taskCsvColumns(), [{ ...base, kind: "mandate_renewal" }]))).toContain(
      ",mandate_renewal,",
    );
    expect(line(toCsv(taskCsvColumns(), [{ ...base, kind: "deal_no_contact" }]))).toContain(
      ",deal_no_contact,",
    );
    expect(line(toCsv(taskCsvColumns(), [{ ...base, kind: "viewing_feedback" }]))).toContain(
      ",viewing_feedback,",
    );
    // a human-typed task stays blank
    expect(line(toCsv(taskCsvColumns(), [base]))).toContain(",,");
  });
});
