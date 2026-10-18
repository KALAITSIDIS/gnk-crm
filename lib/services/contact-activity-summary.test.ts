import { describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * The contact page's Last logged contact / Last chat opened / Next step strip
 * (A06). Three properties are pinned here; the database half — what RLS lets
 * the viewer read, and that a real chat click never stamps a clock — is in
 * supabase/tests/contact-activity.test.ts.
 *
 * 1. A chat-link click is never "Last logged contact": it is asked for
 *    separately, and the logged-contact query names only the logged types.
 * 2. Tasks and viewings are read on the VIEWER's client (tasks_select hides a
 *    colleague's task and its typed title); events on the system's, org-bound.
 * 3. A read that did not answer is `{ ok: false }` — never a "none".
 */

const admin = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin.client }));

const { readContactActivitySummary, nextTaskLabel } = await import("./contact-activity-summary");

const NOW = new Date("2026-10-18T09:00:00Z");

const event = (id: number, occurred_at: string, event_type: string, entity_type: string, payload: unknown = {}) => ({
  id,
  occurred_at,
  event_type,
  entity_type,
  actor_id: "p1",
  payload,
});

/**
 * The events pages in the order the reader asks: the logged-contact query for
 * contact, lead, deal, then the chat query for contact, lead, deal.
 */
function system(logged: FakePage[], chat: FakePage[]) {
  const svc = fakeClient({ events: [...logged, ...chat] });
  admin.client = svc.client;
  return svc;
}
const none: FakePage = { data: [], error: null };

const read = (viewer: unknown, ids: { leadIds?: string[]; dealIds?: string[] } = {}) =>
  readContactActivitySummary({
    orgId: "org-1",
    viewer: viewer as never,
    contactId: "c1",
    contactIds: ["c1"],
    leadIds: ids.leadIds ?? ["l1"],
    dealIds: ids.dealIds ?? ["d1"],
    now: NOW,
  });

describe("last logged contact and last chat opened", () => {
  it("takes the newest logged contact across the contact, its leads and its deals", async () => {
    const svc = system(
      [
        { data: [event(3, "2026-10-10T10:00:00Z", "conversation_logged", "contact", { channel: "phone" })], error: null },
        { data: [event(9, "2026-10-17T15:00:00Z", "called", "lead", { first_call: true })], error: null },
        { data: [event(5, "2026-10-12T10:00:00Z", "conversation_logged", "deal", { channel: "whatsapp" })], error: null },
      ],
      [none, none, none],
    );
    const s = await read(fakeClient({}).client);
    expect(s.lastContact).toEqual({
      ok: true,
      value: expect.objectContaining({ id: 9, event_type: "called", entity_type: "lead", payload: { first_call: true } }),
    });
    expect(svc.argsOf("events", "eq").filter(([k]) => k === "org_id").length, "every events read is org-bound").toBe(6);
  });

  it("asks for the logged types only — a chat-link click can never be the last contact", async () => {
    const svc = system([none, none, none], [none, none, none]);
    await read(fakeClient({}).client);
    const typeFilters = svc.argsOf("events", "in").filter(([k]) => k === "event_type");
    expect(typeFilters.slice(0, 3)).toEqual([
      ["event_type", ["conversation_logged", "called", "contacted"]],
      ["event_type", ["conversation_logged", "called", "contacted"]],
      ["event_type", ["conversation_logged", "called", "contacted"]],
    ]);
    expect(typeFilters.slice(3)).toEqual([
      ["event_type", ["chat_link_opened"]],
      ["event_type", ["chat_link_opened"]],
      ["event_type", ["chat_link_opened"]],
    ]);
  });

  it("reports the last chat opened on its own line, while the last contact stays older", async () => {
    system(
      [
        { data: [event(3, "2026-10-10T10:00:00Z", "conversation_logged", "contact", { channel: "phone" })], error: null },
        none,
        none,
      ],
      [{ data: [event(11, "2026-10-18T08:00:00Z", "chat_link_opened", "contact", { channel: "whatsapp" })], error: null }, none, none],
    );
    const s = await read(fakeClient({}).client);
    expect(s.lastContact.ok && s.lastContact.value?.id).toBe(3);
    expect(s.lastChatOpened.ok && s.lastChatOpened.value?.event_type).toBe("chat_link_opened");
  });

  it("hands on only what the line reads from the payload", async () => {
    system(
      [
        {
          data: [event(3, "2026-10-10T10:00:00Z", "conversation_logged", "contact", { channel: "phone", note_id: "n1", note_sha256: "x", note: "typed words" })],
          error: null,
        },
        none,
        none,
      ],
      [none, none, none],
    );
    const s = await read(fakeClient({}).client);
    expect(s.lastContact.ok && s.lastContact.value?.payload).toEqual({ channel: "phone" });
  });

  it("hands on a conversation's outcome (0155), so the strip says 'Message sent', not 'Conversation logged'", async () => {
    system(
      [
        none,
        {
          data: [
            event(7, "2026-10-17T10:00:00Z", "conversation_logged", "lead", {
              channel: "whatsapp",
              outcome: "message_sent",
              note_id: "n1",
              note_sha256: "x",
            }),
          ],
          error: null,
        },
        none,
      ],
      [none, none, none],
    );
    const s = await read(fakeClient({}).client);
    expect(s.lastContact.ok && s.lastContact.value?.payload).toEqual({ channel: "whatsapp", outcome: "message_sent" });

    // a crafted outcome that is not a string is dropped, not passed on
    system(
      [none, none, { data: [event(2, "2026-10-01T10:00:00Z", "conversation_logged", "deal", { channel: "phone", outcome: { a: 1 } })], error: null }],
      [none, none, none],
    );
    const crafted = await read(fakeClient({}).client);
    expect(crafted.lastContact.ok && crafted.lastContact.value?.payload).toEqual({ channel: "phone" });
  });

  it("a failed read is `{ ok: false }`, never a 'none logged yet'", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    system([none, { data: null, error: { message: "timeout" } }, none], [none, none, { data: null, error: null }]);
    const s = await read(fakeClient({}).client);
    expect(s.lastContact).toEqual({ ok: false });
    expect(s.lastChatOpened, "a hollow answer is not 'none' either").toEqual({ ok: false });
    err.mockRestore();
  });

  it("asks about EVERY deal of a developer, in slices under the 414 — the newest call wins wherever it sits (A06 review)", async () => {
    // 250 unit deals with this contact as the seller: three slices per question
    const deals = Array.from({ length: 250 }, (_, i) => `d${i}`);
    const svc = system(
      [
        none, // contact
        none, // lead
        { data: [event(2, "2026-09-01T10:00:00Z", "conversation_logged", "deal", { channel: "phone" })], error: null },
        none,
        // yesterday's call, logged on a deal only the third slice asks about
        { data: [event(8, "2026-10-17T10:00:00Z", "called", "deal", { first_call: false })], error: null },
      ],
      [none, none, none, none, none],
    );
    const s = await read(fakeClient({}).client, { dealIds: deals });
    expect(s.lastContact.ok && s.lastContact.value?.id).toBe(8);
    const dealSlices = svc
      .argsOf("events", "in")
      .filter(([k]) => k === "entity_id")
      .map(([, v]) => v as string[])
      .filter((v) => v[0]?.startsWith("d"));
    expect(dealSlices.map((v) => v.length), "two questions × three slices").toEqual([100, 100, 50, 100, 100, 50]);
    expect(dealSlices.slice(0, 3).flat()).toEqual(deals);
    expect(svc.argsOf("events", "eq").filter(([k]) => k === "org_id").length, "every slice org-bound").toBe(10);
  });

  it("one failed slice is `{ ok: false }` — the other slices' answer is not 'the last contact'", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const deals = Array.from({ length: 101 }, (_, i) => `d${i}`);
    system(
      [none, none, { data: [event(2, "2026-09-01T10:00:00Z", "called", "deal")], error: null }, { data: null, error: { message: "414" } }],
      [none, none, none, none],
    );
    const s = await read(fakeClient({}).client, { dealIds: deals });
    expect(s.lastContact).toEqual({ ok: false });
    err.mockRestore();
  });

  it("asks nothing for an empty source", async () => {
    const svc = system([none], [none]);
    await read(fakeClient({}).client, { leadIds: [], dealIds: [] });
    expect(svc.served.events, "the contact only, once per question").toBe(2);
    expect(svc.argsOf("events", "eq").filter(([k]) => k === "entity_type")).toEqual([
      ["entity_type", "contact"],
      ["entity_type", "contact"],
    ]);
  });
});

describe("next step — read as the VIEWER", () => {
  it("reads tasks and viewings on the viewer's client, never the system's", async () => {
    const svc = system([none, none, none], [none, none, none]);
    const mine = fakeClient({
      tasks: [
        { data: [{ id: "t-c", title: "Send the brochure", due_at: "2026-10-25T21:59:59Z" }], error: null },
        { data: [{ id: "t-l", title: "Call back", due_at: "2026-10-19T21:59:59Z" }], error: null },
        { data: [], error: null },
      ],
      viewings: [{ data: [{ id: "v1", scheduled_at: "2026-10-20T08:00:00Z", properties: { reference: "PAF0001" } }], error: null }],
    });
    const s = await read(mine.client);
    expect(s.nextTask).toEqual({ ok: true, value: { id: "t-l", title: "Call back", due_at: "2026-10-19T21:59:59Z", assignee_id: null } });
    expect(s.nextViewing).toEqual({ ok: true, value: { id: "v1", scheduled_at: "2026-10-20T08:00:00Z", reference: "PAF0001" } });
    expect(svc.calls.filter((c) => c.table === "tasks" || c.table === "viewings"), "never the admin client").toEqual([]);
    // one short id list per link column — never one `.or()` that grows with the deals
    expect(mine.argsOf("tasks", "in")).toEqual([
      ["contact_id", ["c1"]],
      ["lead_id", ["l1"]],
      ["deal_id", ["d1"]],
    ]);
    expect(mine.argsOf("tasks", "eq")).toEqual(
      expect.arrayContaining([
        ["org_id", "org-1"],
        ["is_done", false],
      ]),
    );
    expect(mine.argsOf("viewings", "eq")).toEqual(
      expect.arrayContaining([
        ["contact_id", "c1"],
        ["status", "scheduled"],
      ]),
    );
    expect(mine.argsOf("viewings", "gte")).toEqual([["scheduled_at", NOW.toISOString()]]);
    expect(mine.argsOf("tasks", "select"), "whose task it is comes back with it").toEqual([
      ["id, title, due_at, assignee_id"],
      ["id, title, due_at, assignee_id"],
      ["id, title, due_at, assignee_id"],
    ]);
  });

  it("hands on whose task it is", async () => {
    system([none, none, none], [none, none, none]);
    const mine = fakeClient({
      tasks: [{ data: [{ id: "t1", title: "Chase the deposit", due_at: "2026-10-20T21:59:59Z", assignee_id: "p-colleague" }], error: null }, none, none],
      viewings: [none],
    });
    const s = await read(mine.client);
    expect(s.nextTask).toEqual({ ok: true, value: expect.objectContaining({ id: "t1", assignee_id: "p-colleague" }) });
  });

  it("slices a long deal list for the task read too", async () => {
    system([none, none, none, none], [none, none, none, none]);
    const deals = Array.from({ length: 150 }, (_, i) => `d${i}`);
    const mine = fakeClient({
      tasks: [none, none, none, { data: [{ id: "t9", title: "Sign the unit 9 papers", due_at: null, assignee_id: null }], error: null }],
      viewings: [none],
    });
    const s = await read(mine.client, { dealIds: deals });
    expect(mine.argsOf("tasks", "in").map(([k, v]) => [k, (v as string[]).length])).toEqual([
      ["contact_id", 1],
      ["lead_id", 1],
      ["deal_id", 100],
      ["deal_id", 50],
    ]);
    expect(s.nextTask.ok && s.nextTask.value?.id, "the task on the 150th deal").toBe("t9");
  });

  it("an undated task comes after a dated one", async () => {
    system([none, none, none], [none, none, none]);
    const mine = fakeClient({
      tasks: [
        { data: [{ id: "a", title: "Undated", due_at: null }], error: null },
        { data: [{ id: "b", title: "Dated", due_at: "2026-12-01T21:59:59Z" }], error: null },
        { data: [], error: null },
      ],
      viewings: [none],
    });
    const s = await read(mine.client);
    expect(s.nextTask.ok && s.nextTask.value?.id).toBe("b");
    expect(s.nextViewing).toEqual({ ok: true, value: null });
  });

  it("a task read that fails is `{ ok: false }` — not 'nothing scheduled'", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    system([none, none, none], [none, none, none]);
    const mine = fakeClient({
      tasks: [none, { data: null, error: { message: "boom" } }, none],
      viewings: [{ data: null, error: null }],
    });
    const s = await read(mine.client);
    expect(s.nextTask).toEqual({ ok: false });
    expect(s.nextViewing).toEqual({ ok: false });
    err.mockRestore();
  });
});

describe("nextTaskLabel — 'Your task' only when it is the viewer's (A06 review)", () => {
  const names = new Map([["p-colleague", "Maria Ioannou"]]);
  it("says whose the task is", () => {
    expect(nextTaskLabel({ assignee_id: "p-me" }, "p-me", names)).toBe("Your task");
    // tasks_select admits the CREATOR: a task an agent set a colleague is not theirs
    expect(nextTaskLabel({ assignee_id: "p-colleague" }, "p-me", names)).toBe("Task for Maria Ioannou");
    expect(nextTaskLabel({ assignee_id: "p-gone" }, "p-me", names), "an unreadable profile is still not 'yours'").toBe(
      "Task for a colleague",
    );
    expect(nextTaskLabel({ assignee_id: null }, "p-me", names)).toBe("Unassigned task");
  });
});

describe("no org, no reads", () => {
  it("refuses a missing org: nothing is asked of either client, and nothing reads as 'none'", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = system([], []);
    const mine = fakeClient({});
    const s = await readContactActivitySummary({
      orgId: "",
      viewer: mine.client as never,
      contactId: "c1",
      contactIds: ["c1"],
      leadIds: ["l1"],
      dealIds: [],
      now: NOW,
    });
    expect(svc.calls).toEqual([]);
    expect(mine.calls).toEqual([]);
    expect(s).toEqual({ lastContact: { ok: false }, lastChatOpened: { ok: false }, nextTask: { ok: false }, nextViewing: { ok: false } });
    err.mockRestore();
  });
});
