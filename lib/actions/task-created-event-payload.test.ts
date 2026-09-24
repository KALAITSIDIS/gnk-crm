import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * A quick-added task's `created` event carries its due date and the ids it is
 * linked to, never its title (audit SEC-03, DECISIONS T-task-created-title-shape).
 *
 * A task title is text somebody typed, and people type people into it ("Call
 * Maria about the deposit"). Until 2026-09-24 `quickAddTask` wrote it into the
 * task's hash-chained `created` event, where neither erasure nor a correction
 * can reach it. Nothing reads it there: the timeline's `created` line prints an
 * amount only, and no entity override exists for tasks. The title stays on the
 * task ROW, where the task list shows it — there is no task edit, and erasure
 * does not touch tasks (BACKLOG), but a row can be corrected and the event
 * could not. Driven through the real action, like
 * deal-created-event-payload.test.ts, and every logged payload is searched for
 * the fixture's own words.
 *
 * The `completed` / `reopened` events no longer carry it either since
 * T-event-typed-text-shape; task-done-event-payload.test.ts pins those.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "agent-1", orgId: "org-1", role: "agent" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { quickAddTask } = await import("@/lib/actions/tasks");

const TASK_ID = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f01";
const CONTACT_ID = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f02";
const DEAL_ID = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f03";
const TITLE = "Call Kyriakoula Palaiopoulou about the deposit on 99 111 222";

/** the link checks (one read per linked table), then the insert */
function add(fields: Record<string, string>, pages: Record<string, FakePage[]> = {}) {
  logEvent.mockClear();
  const fake = fakeClient({
    tasks: [{ data: { id: TASK_ID }, error: null }],
    ...pages,
  });
  state.client = fake.client;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return { fake, result: quickAddTask({ error: null, savedAt: null }, fd) };
}

const logged = () => logEvent.mock.calls.map((c) => c[1]);
const created = () => logged().find((e) => e.entityType === "task" && e.eventType === "created");

beforeEach(() => {
  logEvent.mockClear();
});

describe("quickAddTask writes the task's title to the row, not the chain", () => {
  it("puts none of the title's words in any event it logs", async () => {
    const { result } = add({ title: TITLE, contact_id: CONTACT_ID }, {
      contacts: [{ data: { id: CONTACT_ID }, error: null }],
    });
    expect((await result).error).toBeNull();
    const text = JSON.stringify(logged().map((e) => e.payload));
    expect(
      ["Kyriakoula", "Palaiopoulou", "deposit", "99 111 222"].filter((v) => text.includes(v)),
      "a task title reached the hash chain",
    ).toEqual([]);
  });

  it("logs the created event with the due date and the linked ids only", async () => {
    const { result } = add(
      { title: TITLE, due_date: "2026-10-01", contact_id: CONTACT_ID, deal_id: DEAL_ID },
      {
        contacts: [{ data: { id: CONTACT_ID }, error: null }],
        deals: [{ data: { id: DEAL_ID }, error: null }],
      },
    );
    expect((await result).error).toBeNull();
    expect(created()?.payload).toEqual({
      // Cyprus end of day, 23:59 on 1 October 2026 (UTC+3)
      due_at: "2026-10-01T20:59:00.000Z",
      contact_id: CONTACT_ID,
      deal_id: DEAL_ID,
    });
  });

  it("logs a task with no date and no link as a null due date and nothing else", async () => {
    const { result } = add({ title: TITLE });
    expect((await result).error).toBeNull();
    expect(created()?.payload).toEqual({ due_at: null });
  });

  it("still writes the title to the task ROW", async () => {
    const { fake, result } = add({ title: TITLE });
    expect((await result).error).toBeNull();
    const [row] = fake.argsOf("tasks", "insert")[0] as [Record<string, unknown>];
    expect(row.title).toBe(TITLE);
  });
});
