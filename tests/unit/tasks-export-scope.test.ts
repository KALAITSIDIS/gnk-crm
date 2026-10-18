import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeClient } from "@/lib/testing/fake-client";

/**
 * The tasks CSV is the page's VIEW (A02): `?scope=` and `?due=` are read by the
 * same parser and applied by the same builders as /tasks, Team is an admin's
 * only, and the audit line records the view's vocabulary — never anything
 * else from the URL. Drives the REAL route handler.
 */

const state = vi.hoisted(() => ({
  client: null as unknown,
  role: "agent" as string,
}));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

const ME = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f00";

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: ME, orgId: "org-1", role: state.role, fullName: "Me" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));

const { GET } = await import("@/app/(app)/tasks/export/route");

async function exportOf(query: string) {
  const fake = fakeClient({});
  state.client = fake.client;
  logEvent.mockClear();
  const res = await GET(new NextRequest(`http://localhost/tasks/export${query}`));
  expect(res.status).toBe(200);
  const filters = fake.calls
    .filter((c) => c.table === "tasks" && ["eq", "or", "is", "gte", "lt"].includes(c.method))
    .map((c) => [c.method, ...c.args]);
  const payload = logEvent.mock.calls[0]![1].payload as { filters?: Record<string, unknown> };
  return {
    filters,
    audit: payload.filters,
    filename: /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "",
  };
}

beforeEach(() => {
  state.role = "agent";
});

describe("the tasks export reads the page's view", () => {
  it("by default: my tasks, open and done, recorded as scope mine", async () => {
    const r = await exportOf("");
    expect(r.filters).toEqual([["eq", "assignee_id", ME]]);
    expect(r.audit).toEqual({ scope: "mine" });
    expect(r.filename).toMatch(/^my-tasks-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("delegated: what I created for someone else, NULL holder included", async () => {
    const r = await exportOf("?scope=delegated");
    expect(r.filters).toEqual([
      ["eq", "created_by", ME],
      ["or", `assignee_id.is.null,assignee_id.neq.${ME}`],
    ]);
    expect(r.audit).toEqual({ scope: "delegated" });
    expect(r.filename).toMatch(/^delegated-tasks-/);
  });

  it("team is an admin's: no predicate but RLS; an agent asking for it gets mine", async () => {
    state.role = "admin";
    const admin = await exportOf("?scope=team");
    expect(admin.filters).toEqual([]);
    expect(admin.audit).toEqual({ scope: "team" });
    state.role = "agent";
    const agent = await exportOf("?scope=team");
    expect(agent.filters).toEqual([["eq", "assignee_id", ME]]);
    expect(agent.audit).toEqual({ scope: "mine" });
  });

  it("a due filter narrows to open tasks in its window", async () => {
    const r = await exportOf("?due=undated");
    expect(r.filters).toEqual([
      ["eq", "assignee_id", ME],
      ["eq", "is_done", false],
      ["is", "due_at", null],
    ]);
    expect(r.audit).toEqual({ scope: "mine", due: "undated" });
    expect(r.filename).toMatch(/^my-tasks-undated-/);

    const overdue = await exportOf("?due=overdue");
    expect(overdue.filters.slice(1, 2)).toEqual([["eq", "is_done", false]]);
    expect(overdue.filters[2]![0]).toBe("lt");
  });

  it("junk never reaches the record: an unknown view is the default, other parameters are not read", async () => {
    const r = await exportOf("?scope=Maria%20Georgiou&due=Forged&q=Maria");
    expect(r.audit).toEqual({ scope: "mine" });
    expect(JSON.stringify(r.audit)).not.toMatch(/Maria|Forged/);
  });
});
