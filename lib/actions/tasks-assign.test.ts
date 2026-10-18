import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import { NOT_CONFIRMED_NOTICE, NOT_RECORDED_NOTICE } from "@/lib/services/optimistic-save";
import {
  ASSIGNEE_REFUSED,
  DONE_REFUSED,
  EDIT_REFUSED,
  LINK_REFUSED,
  REASSIGN_REFUSED,
  SAVE_REFUSED,
  SAVE_UNCONFIRMED,
  STALE_REFUSED,
  SYSTEM_TASK_FIXED,
} from "@/lib/validators/tasks";

/**
 * A02 through the real actions: a task for a colleague, with a time of day,
 * linked to a viewing or a lead; the edit; and what each writes to the chain.
 *
 * `logEvent` is NOT mocked (the task-done-event-payload.test.ts approach): the
 * assertions read the rows the real logger handed to `events.insert`, and a
 * failed event write is scripted as the database would answer it. Transport is
 * lib/testing/fake-client.ts — each awaited chain on a table takes that table's
 * next scripted answer. The RLS these rules restate is measured in
 * supabase/tests/task-assign.test.ts.
 */

const state = vi.hoisted(() => ({
  client: null as unknown,
  me: { id: "", orgId: "org-1", role: "agent" as string, fullName: "Me" },
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({ getCurrentProfile: async () => state.me }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { quickAddTask, updateTask } = await import("@/lib/actions/tasks");

const ME = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f00";
const COLLEAGUE = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f0c";
const TASK = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f01";
const VIEWING = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f02";
const LEAD = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f03";
// synthetic: a name, a phone number and a word — none may reach the chain
const TITLE = "Call Kyriakoula Palaiopoulou about the deposit on 99 111 222";
const NEW_TITLE = "Send Andreas Constantinou the floor plan";
const WORDS = ["Kyriakoula", "Palaiopoulou", "deposit", "99 111 222", "Andreas", "Constantinou", "floor plan"];

const colleague = (over: Record<string, unknown> = {}): FakePage => ({
  data: { id: COLLEAGUE, full_name: "Maria Agent", role: "agent", is_active: true, ...over },
  error: null,
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

function run(pages: Record<string, FakePage[]>) {
  const fake = fakeClient(pages);
  state.client = fake.client;
  return fake;
}

/** every row the real logEvent handed to `events.insert` */
const events = (fake: ReturnType<typeof fakeClient>) =>
  fake.argsOf("events", "insert").map((args) => args[0] as Record<string, unknown>);

const noTypedText = (fake: ReturnType<typeof fakeClient>) => {
  const text = JSON.stringify(events(fake).map((e) => e.payload));
  expect(WORDS.filter((w) => text.includes(w)), "a task title reached the hash chain").toEqual([]);
};

beforeEach(() => {
  state.me = { id: ME, orgId: "org-1", role: "agent", fullName: "Me" };
});

// ---------------------------------------------------------------------------
describe("quickAddTask: a task for a colleague", () => {
  const created = { data: { id: TASK }, error: null };

  it("reads the colleague through RLS, gives them the task, and logs assignee_id — not the title", async () => {
    const fake = run({ profiles: [colleague()], tasks: [created] });
    const r = await quickAddTask(
      { error: null, savedAt: null },
      form({ title: TITLE, due_date: "2026-10-19", due_time: "10:30", assignee_id: COLLEAGUE }),
    );
    expect(r).toMatchObject({ error: null, notice: null });
    const [row] = fake.argsOf("tasks", "insert")[0] as [Record<string, unknown>];
    expect(row).toMatchObject({
      title: TITLE,
      assignee_id: COLLEAGUE,
      created_by: ME,
      // 10:30 Cyprus (EEST) on 19 October 2026
      due_at: "2026-10-19T07:30:00.000Z",
    });
    expect(events(fake)).toHaveLength(1);
    expect(events(fake)[0]).toMatchObject({ entity_type: "task", event_type: "created", entity_id: TASK });
    expect(events(fake)[0]!.payload).toEqual({ due_at: "2026-10-19T07:30:00.000Z", assignee_id: COLLEAGUE });
    noTypedText(fake);
  });

  it("a task for me needs no read, and still names its assignee", async () => {
    const fake = run({ tasks: [created] });
    const r = await quickAddTask({ error: null, savedAt: null }, form({ title: TITLE, assignee_id: ME }));
    expect(r.error).toBeNull();
    expect(fake.served.profiles ?? 0).toBe(0);
    expect(events(fake)[0]!.payload).toEqual({ due_at: null, assignee_id: ME });
  });

  it.each([
    ["deactivated", colleague({ is_active: false })],
    ["an owner-portal login", colleague({ role: "owner_portal" })],
    ["unknown — or another organisation's (RLS answers no row)", { data: null, error: null }],
  ] as const)("refuses a colleague who is %s: no insert, no event", async (_label, page) => {
    const fake = run({ profiles: [page], tasks: [created] });
    const r = await quickAddTask(
      { error: null, savedAt: null },
      form({ title: TITLE, assignee_id: COLLEAGUE }),
    );
    expect(r.error).toBe(ASSIGNEE_REFUSED);
    expect(fake.argsOf("tasks", "insert")).toEqual([]);
    expect(events(fake)).toEqual([]);
  });

  it("links a viewing and a lead after reading each through RLS", async () => {
    const fake = run({
      viewings: [{ data: { id: VIEWING }, error: null }],
      leads: [{ data: { id: LEAD }, error: null }],
      tasks: [created],
    });
    const r = await quickAddTask(
      { error: null, savedAt: null },
      form({ title: TITLE, viewing_id: VIEWING, lead_id: LEAD }),
    );
    expect(r.error).toBeNull();
    const [row] = fake.argsOf("tasks", "insert")[0] as [Record<string, unknown>];
    expect(row).toMatchObject({ viewing_id: VIEWING, lead_id: LEAD });
    expect(events(fake)[0]!.payload).toEqual({
      due_at: null,
      assignee_id: ME,
      viewing_id: VIEWING,
      lead_id: LEAD,
    });
  });

  it("refuses a link the caller cannot see", async () => {
    const fake = run({ leads: [{ data: null, error: null }], tasks: [created] });
    const r = await quickAddTask({ error: null, savedAt: null }, form({ title: TITLE, lead_id: LEAD }));
    expect(r.error).toBe(LINK_REFUSED);
    expect(fake.argsOf("tasks", "insert")).toEqual([]);
  });

  it("a created task whose line is REFUSED is still saved — with the notice, never an error", async () => {
    const fake = run({
      tasks: [created],
      events: [{ data: null, error: { message: "permission denied", code: "42501" } }],
    });
    const r = await quickAddTask({ error: null, savedAt: null }, form({ title: TITLE }));
    expect(r.error).toBeNull();
    expect(r.savedAt).not.toBeNull();
    expect(r.notice).toBe(NOT_RECORDED_NOTICE);
    expect(fake.argsOf("tasks", "delete"), "never undone").toEqual([]);
  });

  it("a created task whose line is UNCONFIRMED says so — it may be there", async () => {
    run({ tasks: [created], events: [{ data: null, error: null, status: 504 }] });
    const r = await quickAddTask({ error: null, savedAt: null }, form({ title: TITLE }));
    expect(r).toMatchObject({ error: null, notice: NOT_CONFIRMED_NOTICE });
  });

  it("a refused insert is the action's error in words, not Postgres'", async () => {
    run({ tasks: [{ data: null, error: { message: "new row violates row-level security policy", code: "42501" } }] });
    const r = await quickAddTask({ error: null, savedAt: null }, form({ title: TITLE }));
    expect(r.error).toBe("Your role cannot add tasks.");
  });
});

// ---------------------------------------------------------------------------
describe("updateTask", () => {
  const DUE = "2026-10-19T20:59:00+00:00"; // all day, 19 October (as PostgREST spells it)
  const task = (over: Record<string, unknown> = {}): FakePage => ({
    data: {
      id: TASK,
      org_id: "org-1",
      title: TITLE,
      due_at: DUE,
      assignee_id: ME,
      created_by: ME,
      kind: null,
      is_done: false,
      ...over,
    },
    error: null,
  });
  const updatedOne: FakePage = { data: [{ id: TASK }], error: null };
  const edit = (fields: Record<string, string>) =>
    updateTask({ error: null, savedAt: null }, form({ task_id: TASK, ...fields }));

  it("a new title and time: one `updated` line, the title as shape only, the due instant from/to", async () => {
    const fake = run({ tasks: [task(), updatedOne] });
    const r = await edit({ title: NEW_TITLE, due_date: "2026-10-19", due_time: "11:00" });
    expect(r).toMatchObject({ error: null, notice: null });
    expect(fake.argsOf("tasks", "update")[0]![0]).toEqual({
      title: NEW_TITLE,
      due_at: "2026-10-19T08:00:00.000Z",
    });
    expect(events(fake)).toHaveLength(1);
    expect(events(fake)[0]).toMatchObject({ event_type: "updated", entity_type: "task", entity_id: TASK });
    expect(events(fake)[0]!.payload).toEqual({
      changed: {
        title: { from_set: true, to_set: true },
        // one spelling on both sides, though PostgREST read it as "+00:00"
        due_at: { from: "2026-10-19T20:59:00.000Z", to: "2026-10-19T08:00:00.000Z" },
      },
    });
    noTypedText(fake);
  });

  it("the write is conditional on the row it diffed — ids and instants, never the title", async () => {
    const fake = run({ tasks: [task({ assignee_id: ME }), updatedOne] });
    await edit({ title: NEW_TITLE, due_date: "2026-10-19" });
    const filters = fake.calls.filter((c) => c.table === "tasks" && (c.method === "eq" || c.method === "is"));
    expect(filters.map((c) => c.args)).toEqual([
      ["id", TASK], // the read
      ["id", TASK],
      ["is_done", false],
      ["due_at", DUE],
      ["assignee_id", ME],
    ]);
  });

  it("clearing the date writes a null due date", async () => {
    const fake = run({ tasks: [task(), updatedOne] });
    await edit({ title: TITLE, due_date: "", due_time: "" });
    expect(fake.argsOf("tasks", "update")[0]![0]).toEqual({ due_at: null });
    expect(events(fake)[0]!.payload).toEqual({ changed: { due_at: { from: "2026-10-19T20:59:00.000Z", to: null } } });
  });

  it("the same values again: nothing written, nothing logged", async () => {
    const fake = run({ tasks: [task()] });
    const r = await edit({ title: TITLE, due_date: "2026-10-19", due_time: "" });
    expect(r.error).toBeNull();
    expect(fake.argsOf("tasks", "update")).toEqual([]);
    expect(events(fake)).toEqual([]);
  });

  it("handing on my own task: `assigned` in reassignTask's shape, and no `updated`", async () => {
    const fake = run({ tasks: [task(), updatedOne], profiles: [colleague()] });
    const r = await edit({ assignee_id: COLLEAGUE });
    expect(r.error).toBeNull();
    expect(fake.argsOf("tasks", "update")[0]![0]).toEqual({ assignee_id: COLLEAGUE });
    expect(events(fake).map((e) => [e.event_type, e.payload])).toEqual([
      ["assigned", { to_name: "Maria Agent", to_id: COLLEAGUE, from_id: ME }],
    ]);
  });

  it("an agent cannot hand on a task someone else created — tasks_select would hide it from them", async () => {
    const fake = run({ tasks: [task({ created_by: COLLEAGUE })], profiles: [colleague()] });
    expect((await edit({ assignee_id: COLLEAGUE })).error).toBe(REASSIGN_REFUSED);
    expect(fake.argsOf("tasks", "update")).toEqual([]);
    expect(events(fake)).toEqual([]);
  });

  it("the creator of a delegated task cannot edit it", async () => {
    const fake = run({ tasks: [task({ assignee_id: COLLEAGUE })] });
    expect((await edit({ title: NEW_TITLE })).error).toBe(EDIT_REFUSED);
    expect(fake.argsOf("tasks", "update")).toEqual([]);
  });

  it("a system task keeps its title and due date — even for an admin — and logs nothing", async () => {
    state.me = { ...state.me, role: "admin" };
    const attempts: Record<string, string>[] = [{ title: NEW_TITLE }, { title: TITLE, due_date: "2026-10-20" }];
    for (const fields of attempts) {
      const fake = run({ tasks: [task({ kind: "mandate_renewal", created_by: null })] });
      expect((await edit(fields)).error).toBe(SYSTEM_TASK_FIXED);
      expect(fake.argsOf("tasks", "update")).toEqual([]);
      expect(events(fake)).toEqual([]);
    }
  });

  it("a system task can be reassigned by an admin", async () => {
    state.me = { ...state.me, role: "admin" };
    const fake = run({
      tasks: [task({ kind: "mandate_renewal", created_by: null }), updatedOne],
      profiles: [colleague()],
    });
    expect((await edit({ assignee_id: COLLEAGUE })).error).toBeNull();
    expect(events(fake).map((e) => e.event_type)).toEqual(["assigned"]);
  });

  it("refuses an inactive colleague and a done task", async () => {
    let fake = run({ tasks: [task()], profiles: [colleague({ is_active: false })] });
    expect((await edit({ assignee_id: COLLEAGUE })).error).toBe(ASSIGNEE_REFUSED);
    expect(fake.argsOf("tasks", "update")).toEqual([]);
    fake = run({ tasks: [task({ is_done: true })] });
    expect((await edit({ title: NEW_TITLE })).error).toBe(DONE_REFUSED);
    expect(fake.argsOf("tasks", "update")).toEqual([]);
  });

  it("0 rows from the conditional write: the task moved under us — an error and no event", async () => {
    const fake = run({ tasks: [task(), { data: [], error: null }] });
    expect((await edit({ title: NEW_TITLE })).error).toBe(STALE_REFUSED);
    expect(events(fake)).toEqual([]);
  });

  // The write's answer does not always settle it (A02 review). Only an empty
  // ARRAY says "nothing matched"; a hollow answer, or an error whose code can
  // follow a commit, may hide a saved edit — and "nothing was saved" would
  // send the person to a retry that finds nothing to change and logs nothing.
  const titleOnly = { title: NEW_TITLE, due_date: "2026-10-19", due_time: "" };
  const readBack = (over: Record<string, unknown> = {}): FakePage => ({
    data: { title: TITLE, due_at: DUE, assignee_id: ME, ...over },
    error: null,
  });

  it("a hollow answer whose row holds the edit: saved, and its line written", async () => {
    const fake = run({ tasks: [task(), { data: null, error: null }, readBack({ title: NEW_TITLE })] });
    expect(await edit(titleOnly)).toMatchObject({ error: null, notice: null });
    expect(fake.served.tasks).toBe(3); // read, write, read back
    expect(events(fake).map((e) => [e.event_type, e.payload])).toEqual([
      ["updated", { changed: { title: { from_set: true, to_set: true } } }],
    ]);
    noTypedText(fake);
  });

  it("a hollow answer whose row does NOT hold the edit: unconfirmed — never 'nothing was saved', no line", async () => {
    const fake = run({ tasks: [task(), { data: null, error: null }, readBack()] });
    const r = await edit(titleOnly);
    expect(r.error).toBe(SAVE_UNCONFIRMED);
    expect(r.error).not.toBe(STALE_REFUSED);
    expect(events(fake)).toEqual([]);
  });

  it("a gateway's error with no code, and a read back that fails: unconfirmed", async () => {
    const fake = run({
      tasks: [task(), { data: null, error: { message: "Bad Gateway" } }, { data: null, error: { message: "Bad Gateway" } }],
    });
    expect((await edit(titleOnly)).error).toBe(SAVE_UNCONFIRMED);
    expect(events(fake)).toEqual([]);
  });

  it("a code that can follow a commit (08006) is settled by the read back — the edit is there", async () => {
    const fake = run({
      tasks: [task(), { data: null, error: { message: "connection failure", code: "08006" } }, readBack({ title: NEW_TITLE })],
    });
    expect((await edit(titleOnly)).error).toBeNull();
    expect(events(fake).map((e) => e.event_type)).toEqual(["updated"]);
  });

  it("a hand-on whose answer is lost is settled by the holder read back — `assigned` written", async () => {
    const fake = run({
      tasks: [task(), { data: null, error: null, status: 504 }, readBack({ assignee_id: COLLEAGUE })],
      profiles: [colleague()],
    });
    expect((await edit({ assignee_id: COLLEAGUE })).error).toBeNull();
    expect(events(fake).map((e) => [e.event_type, e.payload])).toEqual([
      ["assigned", { to_name: "Maria Agent", to_id: COLLEAGUE, from_id: ME }],
    ]);
  });

  it("a CERTAIN refusal (a statement-level code) says nothing changed, without a read back", async () => {
    const fake = run({ tasks: [task(), { data: null, error: { message: "check violation", code: "23514" } }] });
    expect((await edit(titleOnly)).error).toBe(SAVE_REFUSED);
    expect(fake.served.tasks).toBe(2);
    expect(events(fake)).toEqual([]);
  });

  it("an admin who fixes the title of an UNASSIGNED task leaves it unassigned (the form posts '' for nobody)", async () => {
    state.me = { ...state.me, role: "admin" };
    const fake = run({ tasks: [task({ assignee_id: null, created_by: COLLEAGUE }), updatedOne] });
    const r = await edit({ ...titleOnly, assignee_id: "" });
    expect(r.error).toBeNull();
    expect(fake.argsOf("tasks", "update")[0]![0]).toEqual({ title: NEW_TITLE });
    expect(fake.served.profiles ?? 0).toBe(0); // no assignee looked up
    expect(events(fake).map((e) => e.event_type)).toEqual(["updated"]);
    // and the write still requires the row to be held by nobody
    const filters = fake.calls.filter((c) => c.table === "tasks" && c.method === "is");
    expect(filters.map((c) => c.args)).toEqual([["assignee_id", null]]);
  });

  it("42501 from the write is the new row leaving the caller's sight", async () => {
    run({ tasks: [task(), { data: null, error: { message: "new row violates row-level security", code: "42501" } }], profiles: [colleague()] });
    expect((await edit({ assignee_id: COLLEAGUE })).error).toBe(REASSIGN_REFUSED);
  });

  it("an edit whose line fails is saved, with the notice", async () => {
    run({ tasks: [task(), updatedOne], events: [{ data: null, error: null, status: 502 }] });
    expect(await edit({ title: NEW_TITLE })).toMatchObject({ error: null, notice: NOT_CONFIRMED_NOTICE });
  });
});
