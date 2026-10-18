import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidElement, type ReactElement } from "react";
import { NextRequest } from "next/server";
import { addDayKey } from "@/lib/services/calendar-window";
import { zonedParts, zonedWallClockToUtc } from "@/lib/utils/tz";
import { createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

/**
 * Tasks between colleagues (A02), through the REAL actions, the REAL /tasks
 * page and the REAL export route, against a REAL PostgREST with each user's
 * own aal2 session — so every rule the app restates (`taskRights`) is checked
 * against the RLS it restates.
 *
 * WHAT IT PINS
 *   1. Agent A adds a task for colleague B with a time of day: the row is B's,
 *      created by A, due at that Cyprus time; the `created` line carries
 *      `assignee_id` and the due instant, never the title.
 *   2. A sees it under Delegated (read-only: no tick, no edit), B under Mine
 *      (tick and edit); the delegated CSV names B; an admin's Team view lists
 *      it; an agent asking for Team gets Mine; another organisation's task is
 *      nowhere.
 *   3. A cannot edit or complete it — the action refuses and writes nothing,
 *      and the database agrees (0 rows). B moves it to 11:00: one `updated`
 *      line, title untouched.
 *   4. B cannot hand it on (A created it): the action refuses, and the
 *      database raises 42501 for the same write — the new row would leave B's
 *      sight. An admin can.
 *   5. Nobody can give a task to a deactivated colleague or another
 *      organisation's profile.
 *   6. A system task keeps its title and date — reassign only.
 *   7. The due filters select by the Cyprus day.
 *   8. The organisation's event chain still verifies.
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres.
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const RUN = Date.now().toString(36);
const ORG = randomUUID();
const OTHER = randomUUID();
const ORGS = [ORG, OTHER];

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>() };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound");
    return c;
  },
}));

import TasksPage from "@/app/(app)/tasks/page";
import { GET as exportTasks } from "@/app/(app)/tasks/export/route";
import { TaskSection, QuickAddTask, type TaskItem } from "@/components/features/tasks/task-list";
import { TaskFilters } from "@/components/features/tasks/task-filters";
import { Pager } from "@/components/features/shared/pager";
import { quickAddTask, toggleTaskDone, updateTask } from "@/lib/actions/tasks";
import {
  ASSIGNEE_REFUSED,
  EDIT_REFUSED,
  REASSIGN_REFUSED,
  SYSTEM_TASK_FIXED,
} from "@/lib/validators/tasks";

let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let a: TestUser; // the agent who delegates
let b: TestUser; // the colleague
let gone: TestUser; // deactivated
let stranger: TestUser; // another organisation
const userIds: string[] = [];
const nameOf: Record<string, string> = {};

const TITLE = `TA ${RUN} call the owner about Kyriakoula`;
const T = {
  overdue: `TA ${RUN} overdue`,
  todayTimed: `TA ${RUN} today at 23:00`,
  inThreeDays: `TA ${RUN} in three days`,
  undated: `TA ${RUN} undated`,
  system: `TA ${RUN} system nudge`,
  otherOrg: `TA ${RUN} other organisation`,
};

const as = <R>(user: TestUser, fn: () => Promise<R>): Promise<R> => ctx.als.run(user.client, fn);

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

type Element = ReactElement<Record<string, unknown>>;
function* walk(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!isValidElement(node)) return;
  const el = node as Element;
  yield el;
  yield* walk(el.props.children);
}

/** Every task row the page rendered, by section title. */
async function pageAs(user: TestUser, sp: Record<string, string> = {}) {
  const tree = await as(user, () => TasksPage({ searchParams: Promise.resolve(sp) }));
  const sections = [...walk(tree)].filter((e) => e.type === TaskSection);
  const rows = sections.flatMap((s) => s.props.items as TaskItem[]);
  const filters = [...walk(tree)].find((e) => e.type === TaskFilters)?.props.filters as {
    scope: string;
    due: string | null;
  };
  const quickAdd = [...walk(tree)].find((e) => e.type === QuickAddTask)?.props as {
    assignees: { id: string }[];
  };
  const pager = [...walk(tree)].find((e) => e.type === Pager)?.props as { total: number; page: number };
  return {
    pager,
    emptyTexts: sections.map((s) => String(s.props.emptyText)),
    sections: Object.fromEntries(sections.map((s) => [String(s.props.title), s.props.items as TaskItem[]])),
    row: (title: string) => rows.find((r) => r.title === title),
    titles: rows.map((r) => r.title),
    filters,
    quickAdd,
  };
}

async function one<R = { id: string }>(sql: string, params: unknown[]): Promise<R> {
  const { rows } = await pg.query(sql, params);
  return rows[0] as R;
}

const eventsOf = async (taskId: string) =>
  (
    await pg.query<{ event_type: string; payload: Record<string, unknown>; actor_id: string | null }>(
      "select event_type, payload, actor_id from events where entity_type = 'task' and entity_id = $1 order by occurred_at, id",
      [taskId],
    )
  ).rows;

/** Cyprus wall-clock helpers, so the fixtures do not depend on the hour the suite runs */
const todayKey = () => zonedParts(new Date()).dayKey;
const cyprus = (key: string, time: string) => zonedWallClockToUtc(`${key}T${time}`).toISOString();

const id: Record<string, string> = {};

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();
  await ensureTestOrg(svc, ORG, `Task assign ${RUN}`, `task-assign-${RUN}`);
  await ensureTestOrg(svc, OTHER, `Task assign other ${RUN}`, `task-assign-other-${RUN}`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s
  admin = await createTestUser(svc, `ta-adm-${RUN}@test.local`, "admin", ORG);
  a = await createTestUser(svc, `ta-a-${RUN}@test.local`, "agent", ORG);
  b = await createTestUser(svc, `ta-b-${RUN}@test.local`, "listing_manager", ORG);
  gone = await createTestUser(svc, `ta-gone-${RUN}@test.local`, "agent", ORG, { enrolFactor: false });
  stranger = await createTestUser(svc, `ta-x-${RUN}@test.local`, "agent", OTHER, { enrolFactor: false });
  for (const u of [admin, a, b, gone, stranger]) {
    userIds.push(u.id);
    nameOf[u.id] = (await one<{ full_name: string }>("select full_name from profiles where id = $1", [u.id])).full_name;
  }
  await pg.query("update profiles set is_active = false where id = $1", [gone.id]);

  // B's own day, for the due filters
  const now = Date.now();
  const insertTask = (cols: Record<string, unknown>) => {
    const names = Object.keys(cols);
    return one(
      `insert into tasks (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(cols),
    );
  };
  id.overdue = (await insertTask({ org_id: ORG, title: T.overdue, assignee_id: b.id, created_by: b.id, due_at: new Date(now - 2 * 86_400_000).toISOString() })).id;
  id.todayTimed = (await insertTask({ org_id: ORG, title: T.todayTimed, assignee_id: b.id, created_by: b.id, due_at: cyprus(todayKey(), "23:00") })).id;
  id.inThreeDays = (await insertTask({ org_id: ORG, title: T.inThreeDays, assignee_id: b.id, created_by: b.id, due_at: cyprus(addDayKey(todayKey(), 3), "23:59") })).id;
  id.undated = (await insertTask({ org_id: ORG, title: T.undated, assignee_id: b.id, created_by: b.id })).id;
  // a nudge the cron would have minted: no creator, a kind, its cycle-keyed date
  id.system = (await insertTask({ org_id: ORG, title: T.system, assignee_id: b.id, kind: "deal_no_contact", due_at: cyprus(addDayKey(todayKey(), 1), "23:59") })).id;
  id.otherOrg = (await insertTask({ org_id: OTHER, title: T.otherOrg, assignee_id: stranger.id, created_by: stranger.id })).id;
}, 300_000);

afterAll(async () => {
  if (pg) {
    await pg.query("delete from tasks where org_id = any($1::uuid[])", [ORGS]);
    for (const u of userIds) await svc.auth.admin.deleteUser(u);
    for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
      await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
    }
    await pg.query("delete from organizations where id = any($1::uuid[])", [ORGS]);
    await pg.end();
  }
}, 300_000);

// ---------------------------------------------------------------------------
describe("a task for a colleague", () => {
  it("A adds it for B, due tomorrow at 10:30 Cyprus; the line carries ids and the instant, not the title", async () => {
    const tomorrow = addDayKey(todayKey(), 1);
    const r = await as(a, () =>
      quickAddTask(
        { error: null, savedAt: null },
        form({ title: TITLE, due_date: tomorrow, due_time: "10:30", assignee_id: b.id }),
      ),
    );
    expect(r).toMatchObject({ error: null, notice: null });

    const row = await one<{ id: string; assignee_id: string; created_by: string; due_at: Date; kind: string | null }>(
      "select id, assignee_id, created_by, due_at, kind from tasks where title = $1",
      [TITLE],
    );
    id.task = row.id;
    expect(row).toMatchObject({ assignee_id: b.id, created_by: a.id, kind: null });
    expect(row.due_at.toISOString()).toBe(cyprus(tomorrow, "10:30"));
    expect(zonedParts(row.due_at).timeLabel).toBe("10:30");

    const events = await eventsOf(row.id);
    expect(events).toEqual([
      {
        event_type: "created",
        actor_id: a.id,
        payload: { due_at: cyprus(tomorrow, "10:30"), assignee_id: b.id },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("Kyriakoula");
  });

  it("A sees it under Delegated, read-only, with B's name; B sees it under Mine with the tick and the edit", async () => {
    const delegated = await pageAs(a, { scope: "delegated" });
    expect(delegated.filters).toEqual({ scope: "delegated", due: null });
    expect(delegated.row(TITLE)).toMatchObject({
      ownerLabel: `For ${nameOf[b.id]}`,
      assigneeId: b.id,
      rights: { complete: false, editDetails: false, reassign: false },
    });
    // A's own page lists none of B's work
    expect((await pageAs(a)).titles).not.toContain(TITLE);

    const mine = await pageAs(b);
    expect(mine.row(TITLE)).toMatchObject({
      ownerLabel: null,
      rights: { complete: true, editDetails: true, reassign: false },
    });
    // the colleague list: active staff of the organisation only
    const offered = mine.quickAdd.assignees.map((p) => p.id);
    expect(offered).toEqual(expect.arrayContaining([admin.id, a.id, b.id]));
    expect(offered).not.toContain(gone.id);
    expect(offered).not.toContain(stranger.id);
  });

  it("the delegated CSV is the page's view and names the holder", async () => {
    const res = await as(a, () => exportTasks(new NextRequest("http://localhost/tasks/export?scope=delegated")));
    expect(res.status).toBe(200);
    const csv = await res.text();
    const line = csv.split("\r\n").find((l) => l.startsWith(TITLE));
    expect(line, "the delegated task is in A's delegated export").toBeDefined();
    expect(line!.endsWith(`,${nameOf[b.id]}`)).toBe(true);
    // A's default export is A's own tasks: not this one
    const own = await as(a, () => exportTasks(new NextRequest("http://localhost/tasks/export")));
    expect(await own.text()).not.toContain(TITLE);
  });

  it("an admin's Team view lists it — and never another organisation's; an agent asking for Team gets Mine", async () => {
    const team = await pageAs(admin, { scope: "team" });
    expect(team.filters.scope).toBe("team");
    expect(team.row(TITLE)).toMatchObject({
      ownerLabel: `For ${nameOf[b.id]}`,
      rights: { complete: true, editDetails: true, reassign: true },
    });
    expect(team.titles).not.toContain(T.otherOrg);

    const agentTeam = await pageAs(a, { scope: "team" });
    expect(agentTeam.filters.scope).toBe("mine");
    expect(agentTeam.titles).not.toContain(TITLE);
  });
});

// ---------------------------------------------------------------------------
describe("who may change it", () => {
  it("A, its creator, cannot edit or complete it — and the database agrees", async () => {
    const r = await as(a, () => updateTask({ error: null, savedAt: null }, form({ task_id: id.task!, title: "Changed" })));
    expect(r.error).toBe(EDIT_REFUSED);
    const tick = await as(a, () => toggleTaskDone(id.task!, true));
    expect(tick.error).toMatch(/only its assignee or an admin/);
    // RLS: tasks_update's USING admits the assignee and admins only
    const { data, error } = await a.client.from("tasks").update({ title: "Changed" }).eq("id", id.task!).select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
    expect((await eventsOf(id.task!)).map((e) => e.event_type)).toEqual(["created"]);
  });

  it("B moves it to 11:00: one `updated` line, the title untouched", async () => {
    const tomorrow = addDayKey(todayKey(), 1);
    const r = await as(b, () =>
      updateTask(
        { error: null, savedAt: null },
        form({ task_id: id.task!, title: TITLE, due_date: tomorrow, due_time: "11:00" }),
      ),
    );
    expect(r).toMatchObject({ error: null, notice: null });
    const row = await one<{ title: string; due_at: Date }>("select title, due_at from tasks where id = $1", [id.task]);
    expect(row.title).toBe(TITLE);
    expect(row.due_at.toISOString()).toBe(cyprus(tomorrow, "11:00"));
    const events = await eventsOf(id.task!);
    expect(events.map((e) => e.event_type)).toEqual(["created", "updated"]);
    expect(events[1]).toMatchObject({
      actor_id: b.id,
      payload: { changed: { due_at: { from: cyprus(tomorrow, "10:30"), to: cyprus(tomorrow, "11:00") } } },
    });
  });

  it("B cannot hand on a task A created: refused in words, and the database raises 42501 for it", async () => {
    const r = await as(b, () => updateTask({ error: null, savedAt: null }, form({ task_id: id.task!, assignee_id: admin.id })));
    expect(r.error).toBe(REASSIGN_REFUSED);
    // what taskRights restates: the new row would fail tasks_select for B
    const { error } = await b.client.from("tasks").update({ assignee_id: admin.id }).eq("id", id.task!).select("id");
    expect(error?.code).toBe("42501");
    expect((await one<{ assignee_id: string }>("select assignee_id from tasks where id = $1", [id.task])).assignee_id).toBe(b.id);
  });

  it("an admin hands it to A: an `assigned` line in reassignTask's shape", async () => {
    const r = await as(admin, () => updateTask({ error: null, savedAt: null }, form({ task_id: id.task!, assignee_id: a.id })));
    expect(r.error).toBeNull();
    const events = await eventsOf(id.task!);
    expect(events.at(-1)).toEqual({
      event_type: "assigned",
      actor_id: admin.id,
      payload: { to_name: nameOf[a.id], to_id: a.id, from_id: b.id },
    });
    // now A holds what A created: A may tick it
    expect(await as(a, () => toggleTaskDone(id.task!, true))).toEqual({ error: null });
  });

  it("nobody can give a task to a deactivated colleague or another organisation's profile", async () => {
    for (const target of [gone.id, stranger.id]) {
      const r = await as(a, () =>
        quickAddTask({ error: null, savedAt: null }, form({ title: `TA ${RUN} refused ${target}`, assignee_id: target })),
      );
      expect(r.error).toBe(ASSIGNEE_REFUSED);
    }
    const { rows } = await pg.query("select 1 from tasks where title like $1", [`TA ${RUN} refused %`]);
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("a system task", () => {
  it("keeps its title and date — for its holder and for an admin — and only an admin hands it on", async () => {
    const bView = (await pageAs(b)).row(T.system);
    expect(bView).toMatchObject({ isAuto: true, rights: { complete: true, editDetails: false, reassign: false } });

    for (const user of [b, admin]) {
      const r = await as(user, () =>
        updateTask({ error: null, savedAt: null }, form({ task_id: id.system!, title: "Renamed", due_date: todayKey() })),
      );
      expect(r.error).toBe(SYSTEM_TASK_FIXED);
    }
    expect((await one<{ title: string }>("select title from tasks where id = $1", [id.system])).title).toBe(T.system);

    const r = await as(admin, () => updateTask({ error: null, savedAt: null }, form({ task_id: id.system!, assignee_id: a.id })));
    expect(r.error).toBeNull();
    expect((await eventsOf(id.system!)).map((e) => e.event_type)).toEqual(["assigned"]);
  });
});

// ---------------------------------------------------------------------------
describe("due filters read the Cyprus day", () => {
  it("overdue, today, the next 7 days and undated", async () => {
    const mine = (due: string) => pageAs(b, { due }).then((p) => p.titles.filter((t) => t.startsWith(`TA ${RUN}`)));
    // tonight's 23:00 task is overdue only once 23:00 has passed — said, not assumed
    const tonightPassed = Date.now() >= new Date(cyprus(todayKey(), "23:00")).getTime();
    expect(await mine("overdue")).toEqual(tonightPassed ? [T.overdue, T.todayTimed] : [T.overdue]);
    // due at 23:00 tonight: today's, and not overdue until then
    expect(await mine("today")).toEqual([T.todayTimed]);
    expect(await mine("week")).toEqual([T.todayTimed, T.inThreeDays]);
    expect(await mine("undated")).toEqual([T.undated]);
    // under a due filter the page is one section, named for it, and no "Recently done"
    const page = await pageAs(b, { due: "week" });
    expect(Object.keys(page.sections)).toEqual(["Next 7 days"]);
  });
});

describe("a page past the end", () => {
  it("is an empty page that still states the true total — PostgREST's 416 carries no count", async () => {
    const { rows } = await pg.query<{ n: number }>(
      "select count(*)::int as n from tasks where assignee_id = $1 and not is_done",
      [b.id],
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
    const past = await pageAs(b, { page: "999" });
    expect(past.titles).toEqual([]);
    // Overdue, Upcoming, then Recently done (whose words do not depend on the page)
    expect(past.emptyTexts).toEqual(["None on this page.", "None on this page.", "Nothing completed yet."]);
    expect(past.pager).toMatchObject({ page: 999, total: rows[0]!.n });
  });
});

describe("the chain", () => {
  it("still verifies for the organisation", async () => {
    const { rows } = await pg.query("select ok, reason from verify_events_chain($1::uuid, null::bigint)", [ORG]);
    expect(rows[0]).toMatchObject({ ok: true });
  });
});
