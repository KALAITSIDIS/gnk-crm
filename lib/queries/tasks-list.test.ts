import { describe, expect, it } from "vitest";
import {
  applyTaskDue,
  applyTaskScope,
  parseTaskListFilters,
  taskDueWindow,
  taskListQuery,
} from "./tasks-list";

const ME = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f01";

function spy() {
  const calls: { method: string; args: unknown[] }[] = [];
  const s: Record<string, (...a: unknown[]) => unknown> = {};
  for (const method of ["eq", "is", "or", "gte", "lt"]) {
    s[method] = (...args: unknown[]) => (calls.push({ method, args }), s);
  }
  return { s: s as never, calls };
}

describe("parseTaskListFilters", () => {
  it("defaults to my tasks with no due filter", () => {
    expect(parseTaskListFilters({}, false)).toEqual({ scope: "mine", due: null });
    expect(parseTaskListFilters({}, true)).toEqual({ scope: "mine", due: null });
  });

  it("keeps a known scope and due filter, and drops unknown ones", () => {
    expect(parseTaskListFilters({ scope: "delegated", due: "today" }, false)).toEqual({
      scope: "delegated",
      due: "today",
    });
    expect(parseTaskListFilters({ scope: "everyone", due: "yesterday" }, true)).toEqual({ scope: "mine", due: null });
  });

  it("gives Team to an admin only — an agent's RLS could not show it", () => {
    expect(parseTaskListFilters({ scope: "team" }, true).scope).toBe("team");
    expect(parseTaskListFilters({ scope: "team" }, false).scope).toBe("mine");
  });

  it("reads the first of a repeated parameter", () => {
    expect(parseTaskListFilters({ scope: ["delegated", "team"], due: ["week", "overdue"] }, true)).toEqual({
      scope: "delegated",
      due: "week",
    });
  });

  it("round-trips through the query string the links and the export use", () => {
    expect(taskListQuery({ scope: "mine", due: null })).toBe("");
    expect(taskListQuery({ scope: "team", due: "undated" })).toBe("?scope=team&due=undated");
    expect(taskListQuery({ scope: "mine", due: "overdue" })).toBe("?due=overdue");
    const back = Object.fromEntries(new URLSearchParams("scope=delegated&due=week"));
    expect(parseTaskListFilters(back, false)).toEqual({ scope: "delegated", due: "week" });
  });
});

describe("applyTaskScope", () => {
  it("mine is the assignee", () => {
    const { s, calls } = spy();
    applyTaskScope(s, "mine", ME);
    expect(calls).toEqual([{ method: "eq", args: ["assignee_id", ME] }]);
  });

  it("delegated is what I created for someone else — or for nobody, NULL included", () => {
    const { s, calls } = spy();
    applyTaskScope(s, "delegated", ME);
    expect(calls).toEqual([
      { method: "eq", args: ["created_by", ME] },
      // a bare neq would drop the NULL-assignee row (NULL <> me is NULL)
      { method: "or", args: [`assignee_id.is.null,assignee_id.neq.${ME}`] },
    ]);
  });

  it("team adds no predicate: RLS is the organisation", () => {
    const { s, calls } = spy();
    applyTaskScope(s, "team", ME);
    expect(calls).toEqual([]);
  });
});

describe("taskDueWindow: Cyprus days", () => {
  // 2026-10-18 09:00 UTC = 12:00 EEST
  const noon = new Date("2026-10-18T09:00:00.000Z");

  it("overdue is due before now", () => {
    expect(taskDueWindow("overdue", noon)).toEqual({ lt: "2026-10-18T09:00:00.000Z" });
  });

  it("today is the whole Cyprus day, midnight to midnight", () => {
    expect(taskDueWindow("today", noon)).toEqual({
      gte: "2026-10-17T21:00:00.000Z",
      lt: "2026-10-18T21:00:00.000Z",
    });
  });

  it("at 01:30 Cyprus the day is already Cyprus's, though UTC still says yesterday", () => {
    const early = new Date("2026-10-17T22:30:00.000Z"); // 01:30 EEST on the 18th
    expect(taskDueWindow("today", early).gte).toBe("2026-10-17T21:00:00.000Z");
  });

  it("the next 7 days end at a Cyprus midnight, even across the October switch", () => {
    // today 2026-10-18; the window ends as 2026-10-25 begins — still EEST at
    // 00:00 (the switch is at 01:00 UTC that day)
    expect(taskDueWindow("week", noon)).toEqual({
      gte: "2026-10-17T21:00:00.000Z",
      lt: "2026-10-24T21:00:00.000Z",
    });
    // today 2026-10-24 (EEST); the window ends as 2026-10-31 begins, in EET:
    // seven days and one hour, never 7 × 24 h
    expect(taskDueWindow("week", new Date("2026-10-24T09:00:00.000Z"))).toEqual({
      gte: "2026-10-23T21:00:00.000Z",
      lt: "2026-10-30T22:00:00.000Z",
    });
  });

  it("undated is no due date", () => {
    expect(taskDueWindow("undated", noon)).toEqual({ undated: true });
  });
});

describe("applyTaskDue", () => {
  const noon = new Date("2026-10-18T09:00:00.000Z");

  it("reads open tasks only, in the window", () => {
    const { s, calls } = spy();
    applyTaskDue(s, "today", noon);
    expect(calls).toEqual([
      { method: "eq", args: ["is_done", false] },
      { method: "gte", args: ["due_at", "2026-10-17T21:00:00.000Z"] },
      { method: "lt", args: ["due_at", "2026-10-18T21:00:00.000Z"] },
    ]);
  });

  it("undated is due_at IS NULL", () => {
    const { s, calls } = spy();
    applyTaskDue(s, "undated", noon);
    expect(calls).toEqual([
      { method: "eq", args: ["is_done", false] },
      { method: "is", args: ["due_at", null] },
    ]);
  });

  it("overdue has no lower bound", () => {
    const { s, calls } = spy();
    applyTaskDue(s, "overdue", noon);
    expect(calls).toEqual([
      { method: "eq", args: ["is_done", false] },
      { method: "lt", args: ["due_at", "2026-10-18T09:00:00.000Z"] },
    ]);
  });
});
