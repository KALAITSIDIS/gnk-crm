import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * Ticking a task done, or reopening it, logs WHICH task and WHAT happened —
 * never the task's title (audit SEC-03, DECISIONS T-event-typed-text-shape).
 *
 * A task title is text somebody typed, and it often names a person ("Call
 * Maria about the deposit"), or was BUILT from one by the system (the
 * `deal_no_contact` nudge from a deal titled with the buyer's name, the
 * `retention_expired` task from a contact's display name). Until this change
 * `toggleTaskDone` copied it into the hash-chained `completed` / `reopened`
 * event, where neither erasure nor a correction can reach it. The task ROW
 * keeps the title; the timeline reads it from there with the viewer's own
 * permissions (lib/services/event-context.ts).
 *
 * Unlike task-created-event-payload.test.ts, `logEvent` is NOT mocked: the
 * real action calls the real logger, and the assertions read the row that
 * reached `events.insert` — the exact bytes the chain would hash. Transport is
 * lib/testing/fake-client.ts; the real RLS behaviour of the conditional update
 * is pinned by the database suite, not here.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "agent-1", orgId: "org-1", role: "agent" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { toggleTaskDone } = await import("@/lib/actions/tasks");

const TASK_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01";
// synthetic: a name, a phone number and a word from the task — none may reach the chain
const TITLE = "Call Kyriakoula Palaiopoulou about the deposit on 99 111 222";
const WORDS = ["Kyriakoula", "Palaiopoulou", "deposit", "99 111 222"];

/** the task read, then the conditional update */
function toggle(done: boolean, pages: { read: FakePage; update?: FakePage }) {
  const fake = fakeClient({
    tasks: [pages.read, ...(pages.update ? [pages.update] : [])],
  });
  state.client = fake.client;
  return { fake, result: toggleTaskDone(TASK_ID, done) };
}

const openTask = { data: { id: TASK_ID, org_id: "org-1", title: TITLE, is_done: false }, error: null };
const doneTask = { data: { id: TASK_ID, org_id: "org-1", title: TITLE, is_done: true }, error: null };
const updatedOne = { data: [{ id: TASK_ID }], error: null };

/** every row the real logEvent handed to `events.insert` */
const inserted = (fake: ReturnType<typeof fakeClient>) =>
  fake.argsOf("events", "insert").map((args) => args[0] as Record<string, unknown>);

beforeEach(() => {
  state.client = null;
});

describe("toggleTaskDone logs the act, not the task's title", () => {
  it("completing: the task is updated and ONE completed event names the task by id only", async () => {
    const { fake, result } = toggle(true, { read: openTask, update: updatedOne });
    expect(await result).toEqual({ error: null });

    // the row really moved, with the no-op precondition folded into the write
    const [patch] = fake.argsOf("tasks", "update")[0] as [Record<string, unknown>];
    expect(patch.is_done).toBe(true);
    expect(typeof patch.done_at).toBe("string");
    expect(fake.argsOf("tasks", "neq")).toEqual([["is_done", true]]);

    const rows = inserted(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: "org-1",
      actor_id: "agent-1",
      entity_type: "task",
      entity_id: TASK_ID,
      event_type: "completed",
    });
    expect(rows[0].payload).toEqual({});
  });

  it("reopening: the task is updated and ONE reopened event names the task by id only", async () => {
    const { fake, result } = toggle(false, { read: doneTask, update: updatedOne });
    expect(await result).toEqual({ error: null });

    const [patch] = fake.argsOf("tasks", "update")[0] as [Record<string, unknown>];
    expect(patch).toEqual({ is_done: false, done_at: null });
    expect(fake.argsOf("tasks", "neq")).toEqual([["is_done", false]]);

    const rows = inserted(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: "task", entity_id: TASK_ID, event_type: "reopened" });
    expect(rows[0].payload).toEqual({});
  });

  it("puts none of the title's words anywhere in the inserted event row, nested values included", async () => {
    for (const [done, read] of [
      [true, openTask],
      [false, doneTask],
    ] as const) {
      const { fake, result } = toggle(done, { read, update: updatedOne });
      expect((await result).error).toBeNull();
      const text = JSON.stringify(inserted(fake));
      expect(
        WORDS.filter((w) => text.includes(w)),
        `a task title reached the hash chain (${done ? "completed" : "reopened"})`,
      ).toEqual([]);
    }
  });

  it("a no-op toggle (already in that state) writes nothing and logs nothing", async () => {
    const { fake, result } = toggle(true, { read: doneTask });
    expect(await result).toEqual({ error: null });
    expect(fake.argsOf("tasks", "update")).toEqual([]);
    expect(inserted(fake)).toEqual([]);
  });

  it("a refused update (0 rows: RLS, or a concurrent toggle won) logs no phantom event", async () => {
    const { fake, result } = toggle(true, { read: openTask, update: { data: [], error: null } });
    expect((await result).error).toMatch(/not updated/);
    expect(inserted(fake)).toEqual([]);
  });

  it("a failed update logs no event", async () => {
    const { fake, result } = toggle(true, {
      read: openTask,
      update: { data: null, error: { message: "permission denied" } },
    });
    expect((await result).error).toBe("permission denied");
    expect(inserted(fake)).toEqual([]);
  });

  it("a task the caller cannot read logs nothing", async () => {
    const { fake, result } = toggle(true, { read: { data: null, error: null } });
    expect((await result).error).toBe("Task not found");
    expect(fake.argsOf("tasks", "update")).toEqual([]);
    expect(inserted(fake)).toEqual([]);
  });
});
