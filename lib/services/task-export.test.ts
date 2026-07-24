import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { taskCsvColumns, type TaskExportRow } from "./task-export";

const base: TaskExportRow = {
  title: "Call back Savvides re offer",
  due_at: "2026-07-25T15:00:00Z",
  is_done: false,
  done_at: null,
  mandate_id: null,
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

  it("marks a done task and an auto-generated renewal", () => {
    const done = toCsv(taskCsvColumns(), [
      { ...base, is_done: true, done_at: "2026-07-24T10:00:00Z" },
    ]);
    expect(done).toContain("done");

    const auto = toCsv(taskCsvColumns(), [{ ...base, mandate_id: "m1" }]);
    // Auto is the 6th column → after Property; a set mandate marks "yes"
    expect(line(auto)).toContain(",yes,");
  });
});
