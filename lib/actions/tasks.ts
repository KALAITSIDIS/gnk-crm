"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { changesForChain, type FieldChange } from "@/lib/services/event-changes";
import { logEvent } from "@/lib/services/events";
import { eventNotice, joinNotices } from "@/lib/services/one-time-secrets";
import { certainlyRolledBack } from "@/lib/services/rpc-outcome";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { changedValue } from "@/lib/utils/diff";
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
  TASK_STAFF_ROLES,
  createTaskSchema,
  dueAtFrom,
  isTaskStaffRole,
  sameDue,
  taskRights,
  updateTaskSchema,
  type TaskAssignee,
} from "@/lib/validators/tasks";

export type TaskActionState = {
  error: string | null;
  savedAt: number | null;
  /**
   * Saved, but its timeline line could not be recorded or confirmed
   * (NOT_RECORDED_NOTICE / NOT_CONFIRMED_NOTICE): the task is real and stays —
   * the form must not invite a retry that would file it twice (BACKLOG "A
   * retried offer, viewing, payment plan, task or saved search files a second
   * one").
   */
  notice?: string | null;
};

type Client = SupabaseClient<Database>;

/**
 * The person a task is being given to, read through RLS (profiles_select is
 * the caller's organisation): active, and a staff role. Null for anyone else —
 * another organisation's profile reads as no row at all. tasks_insert and
 * tasks_update check the organisation of the TASK, not of its assignee
 * (`assignee_id` is not org-keyed — docs/04_RLS_POLICY_MATRIX.md), so this
 * read is the gate.
 */
async function readAssignee(supabase: Client, id: string): Promise<{ id: string; full_name: string } | null> {
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, role, is_active")
    .eq("id", id)
    .maybeSingle();
  if (!data || !data.is_active || !isTaskStaffRole(data.role)) return null;
  return { id: data.id, full_name: data.full_name };
}

/**
 * One timeline line for a write that has COMMITTED. A failure here is not the
 * action's failure: the change is real, so the answer is "saved" with the
 * notice that says the line is missing (refused) or unconfirmed (anything
 * else) — never an error that invites the retry, never an undo.
 */
async function record(supabase: Client, params: Parameters<typeof logEvent>[1]): Promise<string | null> {
  try {
    await logEvent(supabase, params);
    return null;
  } catch (err) {
    console.error("[tasks] saved but not recorded", {
      eventType: params.eventType,
      taskId: params.entityId,
      err,
    });
    return eventNotice(err);
  }
}

type TaskLink = {
  property_id?: string;
  contact_id?: string;
  deal_id?: string;
  viewing_id?: string;
  lead_id?: string;
};

function revalidateTaskPaths(link: TaskLink = {}) {
  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  if (link.property_id) revalidatePath(`/properties/${link.property_id}`);
  if (link.contact_id) revalidatePath(`/contacts/${link.contact_id}`);
  if (link.deal_id) revalidatePath(`/deals/${link.deal_id}`);
  if (link.viewing_id) revalidatePath(`/viewings/${link.viewing_id}`);
  if (link.lead_id) revalidatePath("/leads");
}

/**
 * Quick add (T5.5) and "Add task" on a record (WF-5): a task for me or for an
 * active colleague (A02), optionally with a time of day, linked to the record
 * it concerns.
 */
export async function quickAddTask(
  _prev: TaskActionState,
  formData: FormData,
): Promise<TaskActionState> {
  const parsed = createTaskSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  let assigneeId = profile.id;
  if (d.assignee_id && d.assignee_id !== profile.id) {
    const target = await readAssignee(supabase, d.assignee_id);
    if (!target) return { error: ASSIGNEE_REFUSED, savedAt: null };
    assigneeId = target.id;
  }

  // Verify-then-insert (the saveOffer idiom): read each linked record through
  // RLS first and fail closed. The composite (org_id, x_id) keys (0119–0126)
  // refuse another organisation's id anyway; this read also refuses a record
  // the caller cannot see, with words instead of a constraint name.
  const link: TaskLink = {};
  for (const [table, col, id] of [
    ["properties", "property_id", d.property_id],
    ["contacts", "contact_id", d.contact_id],
    ["deals", "deal_id", d.deal_id],
    ["viewings", "viewing_id", d.viewing_id],
    ["leads", "lead_id", d.lead_id],
  ] as const) {
    if (!id) continue;
    const { data: row } = await supabase.from(table).select("id").eq("id", id).maybeSingle();
    if (!row) return { error: LINK_REFUSED, savedAt: null };
    link[col] = id;
  }

  const dueAt = d.due_date ? dueAtFrom(d.due_date, d.due_time) : null;

  const { data: created, error } = await supabase
    .from("tasks")
    .insert({
      org_id: profile.orgId,
      title: d.title,
      due_at: dueAt,
      assignee_id: assigneeId,
      created_by: profile.id,
      ...link,
    })
    .select("id")
    .single();
  if (error || !created) {
    return {
      error: error?.code === "42501" ? "Your role cannot add tasks." : "The task could not be added — try again.",
      savedAt: null,
    };
  }

  const notice = await record(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "task",
    entityId: created.id,
    eventType: "created",
    // no `title`: it is typed text, often about a person, and the chain is
    // beyond erasure and correction (SEC-03). The row holds it; the timeline's
    // `created` line never printed it. The assignee is an id, always set.
    payload: { due_at: dueAt, assignee_id: assigneeId, ...link },
  });

  revalidateTaskPaths(link);
  return { error: null, savedAt: Date.now(), notice };
}

/**
 * Edit a task (A02): its title and due date — a human task's only — and who
 * holds it. Who may do which is `taskRights` (lib/validators/tasks.ts), checked
 * here for the words and enforced by RLS.
 *
 * Events: a title or due change is `updated` with `changesForChain` — the due
 * instant keeps from/to, the title records only that it changed (SEC-03). A
 * new assignee is `assigned` in reassignTask's shape, so the timeline line
 * that already reads it ("Reassigned to …") applies. Nothing changed: nothing
 * written, nothing logged.
 */
export async function updateTask(
  _prev: TaskActionState,
  formData: FormData,
): Promise<TaskActionState> {
  const parsed = updateTaskSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: task } = await supabase
    .from("tasks")
    .select("id, org_id, title, due_at, assignee_id, created_by, kind, is_done")
    .eq("id", d.task_id)
    .maybeSingle();
  if (!task) return { error: "Task not found", savedAt: null };
  if (task.is_done) return { error: DONE_REFUSED, savedAt: null };
  const rights = taskRights(task, profile);

  const changed: Record<string, FieldChange> = {};
  const updates: { title?: string; due_at?: string | null; assignee_id?: string } = {};
  if (d.title !== undefined) {
    const nextDue = d.due_date ? dueAtFrom(d.due_date, d.due_time) : null;
    if (changedValue(task.title, d.title)) {
      changed.title = { from: task.title, to: d.title };
      updates.title = d.title;
    }
    if (!sameDue(task.due_at, nextDue)) {
      // both sides in one spelling (PostgREST answers "+00:00", the form's is "Z")
      const from = task.due_at === null ? null : new Date(task.due_at).toISOString();
      changed.due_at = { from, to: nextDue };
      updates.due_at = nextDue;
    }
  }
  if (Object.keys(changed).length > 0) {
    if (task.kind !== null) return { error: SYSTEM_TASK_FIXED, savedAt: null };
    if (!rights.editDetails) return { error: EDIT_REFUSED, savedAt: null };
  }

  let target: { id: string; full_name: string } | null = null;
  if (d.assignee_id && d.assignee_id !== task.assignee_id) {
    if (!rights.reassign) return { error: REASSIGN_REFUSED, savedAt: null };
    target = await readAssignee(supabase, d.assignee_id);
    if (!target) return { error: ASSIGNEE_REFUSED, savedAt: null };
    updates.assignee_id = target.id;
  }

  if (Object.keys(updates).length === 0) return { error: null, savedAt: Date.now() };

  // The row must still be the one the diff was taken from — open, due when it
  // was, held by whom it was — so the event's `from` is true and a double
  // submit cannot log twice (the toggleTaskDone idiom). Ids and instants only:
  // the title is typed text and stays out of the request URL. 0 rows = it
  // moved under us (the rights were checked above).
  let write = supabase.from("tasks").update(updates).eq("id", task.id).eq("is_done", false);
  write = task.due_at === null ? write.is("due_at", null) : write.eq("due_at", task.due_at);
  write = task.assignee_id === null ? write.is("assignee_id", null) : write.eq("assignee_id", task.assignee_id);
  const { data: updated, error } = await write.select("id");
  if (error && certainlyRolledBack(error.code)) {
    // refused before or while it ran: nothing was written. 42501 here is the
    // new row failing tasks_select — handing on a task the caller could then
    // no longer see (see taskRights)
    return { error: error.code === "42501" ? REASSIGN_REFUSED : SAVE_REFUSED, savedAt: null };
  }
  if (!error && Array.isArray(updated)) {
    // the database's answer: no row = it moved under us, and nothing changed
    if (updated.length === 0) return { error: STALE_REFUSED, savedAt: null };
  } else if (!(await editLanded(supabase, task.id, updates))) {
    // A hollow answer, a gateway's words, a code that can follow a commit: the
    // edit may have committed. "Nothing was saved" would invite a retry that
    // re-reads the edited row, finds nothing to change and records nothing —
    // a change with no line on the chain (A02 review; "A code is not a
    // refusal"). The row read back settles it when it holds the edit; when it
    // does not, the outcome is unknown and is said to be.
    return { error: SAVE_UNCONFIRMED, savedAt: null };
  }

  const notices: string[] = [];
  if (Object.keys(changed).length > 0) {
    const notice = await record(supabase, {
      orgId: task.org_id,
      actorId: profile.id,
      entityType: "task",
      entityId: task.id,
      eventType: "updated",
      // the title records shape only (SEC-03); the due instant keeps from/to
      payload: JSON.parse(JSON.stringify({ changed: changesForChain(changed, isTaskTitle) })),
    });
    if (notice) notices.push(notice);
  }
  if (target) {
    const notice = await record(supabase, {
      orgId: task.org_id,
      actorId: profile.id,
      entityType: "task",
      entityId: task.id,
      eventType: "assigned",
      payload: { to_name: target.full_name, to_id: target.id, from_id: task.assignee_id },
    });
    if (notice) notices.push(notice);
  }

  revalidateTaskPaths();
  return { error: null, savedAt: Date.now(), notice: joinNotices(notices) };
}

/** A task's title is typed text — `updated` records only that it changed. */
function isTaskTitle(field: string): boolean {
  return field === "title";
}

/**
 * Does the row, read back now, hold every value this edit wrote? Asked only
 * when the write's own answer did not settle it. True = the edit is in the
 * row, so it is saved and its lines are owed. False — a different value, no
 * row, a failed read — leaves the outcome unknown; it is never read as "not
 * written". By id only: the title is compared here, never sent in a URL.
 */
async function editLanded(
  supabase: Client,
  taskId: string,
  updates: { title?: string; due_at?: string | null; assignee_id?: string },
): Promise<boolean> {
  const { data: row, error } = await supabase
    .from("tasks")
    .select("title, due_at, assignee_id")
    .eq("id", taskId)
    .maybeSingle();
  if (error || !row) return false;
  if (updates.title !== undefined && row.title !== updates.title) return false;
  if (updates.due_at !== undefined && !sameDue(row.due_at, updates.due_at)) return false;
  if (updates.assignee_id !== undefined && row.assignee_id !== updates.assignee_id) return false;
  return true;
}

/**
 * Who a task can be given to, for a form its page did not hand the list (the
 * "Add task" dialog on a record page). Active staff of the caller's
 * organisation, by name. A failed read is an error, never an empty list — the
 * form then offers no choice and the task stays with its creator.
 */
export async function listTaskAssignees(): Promise<{
  assignees: TaskAssignee[];
  meId: string;
  error: string | null;
}> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("is_active", true)
    .in("role", [...TASK_STAFF_ROLES])
    .order("full_name")
    .order("id");
  if (error || !Array.isArray(data)) {
    return { assignees: [], meId: profile.id, error: "Colleagues could not be loaded." };
  }
  return {
    assignees: data.map((p) => ({ id: p.id, fullName: p.full_name })),
    meId: profile.id,
    error: null,
  };
}

/** Done toggle (T5.5 acceptance: done writes an event). */
export async function toggleTaskDone(
  taskId: string,
  done: boolean,
): Promise<{ error: string | null }> {
  if (!z.guid().safeParse(taskId).success) return { error: "Invalid task" };

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: task } = await supabase
    .from("tasks")
    .select("id, org_id, is_done")
    .eq("id", taskId)
    .maybeSingle();
  if (!task) return { error: "Task not found" };
  if (task.is_done === done) return { error: null };

  // `.neq("is_done", done)` folds the no-op precondition into the write, so a
  // double-click can't log the event twice; 0 rows after it = a concurrent
  // toggle won, or update RLS filtered us out (select is wider: creators see
  // tasks only their assignee may complete) — either way, no phantom event.
  const { data: updated, error } = await supabase
    .from("tasks")
    .update({ is_done: done, done_at: done ? new Date().toISOString() : null })
    .eq("id", taskId)
    .neq("is_done", done)
    .select("id");
  if (error) return { error: error.message };
  if (!updated || updated.length === 0) {
    return { error: "Task was not updated — only its assignee or an admin can." };
  }

  await logEvent(supabase, {
    orgId: task.org_id,
    actorId: profile.id,
    entityType: "task",
    entityId: taskId,
    eventType: done ? "completed" : "reopened",
    // no `title`, for the reason `created` has none: it is typed text (or built
    // from a person's name by a nudge), and the chain is beyond erasure and
    // correction (SEC-03). The entity id names the task; a timeline reads the
    // title from the row with the viewer's permissions (lib/services/event-context.ts).
    payload: {},
  });

  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  return { error: null };
}

/**
 * Reassign a stranded task (BACKLOG T-audit-tasks).
 *
 * Admin-only, and deliberately manual: 0024's sweep re-homes SYSTEM nudges
 * automatically, but a hand-assigned task represents somebody's decision about
 * who owns the work, so moving it is a decision too. See
 * `lib/queries/stranded-tasks.ts` for why these rows are invisible otherwise.
 */
export async function reassignTask(
  taskId: string,
  toProfileId: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (profile.role !== "admin") return { error: "Only an admin can reassign tasks." };

  const { data: task } = await supabase
    .from("tasks")
    .select("id, org_id, title, assignee_id, is_done")
    .eq("id", taskId)
    .maybeSingle();
  if (!task) return { error: "Task not found" };
  if (task.is_done) return { error: "That task is already done." };

  // The target must be someone who can actually see it afterwards — reassigning
  // to another deactivated profile would just move the row between two
  // invisibilities. RLS scopes this read to the caller's org; a staff role,
  // because an owner-portal login does not work tasks (A02).
  const { data: target } = await supabase
    .from("profiles")
    .select("id, full_name, is_active, role")
    .eq("id", toProfileId)
    .maybeSingle();
  if (!target) return { error: "Unknown user" };
  if (!target.is_active) return { error: "That user is deactivated — pick an active one." };
  if (!isTaskStaffRole(target.role)) return { error: ASSIGNEE_REFUSED };

  // Precondition folded into the write, as in toggleTaskDone, so a double
  // submit cannot log the event twice. NOT a bare `.neq`: for an unassigned row
  // `assignee_id <> :id` evaluates to NULL and the row is filtered out — which
  // would silently refuse the exact case this feature exists for.
  const { data: updated, error } = await supabase
    .from("tasks")
    .update({ assignee_id: toProfileId })
    .eq("id", taskId)
    .or(`assignee_id.is.null,assignee_id.neq.${toProfileId}`)
    .select("id");
  if (error) return { error: error.message };
  if (!updated || updated.length === 0) {
    return { error: "Task was not reassigned — it may already belong to that user." };
  }

  await logEvent(supabase, {
    orgId: task.org_id,
    actorId: profile.id,
    entityType: "task",
    entityId: taskId,
    eventType: "assigned",
    payload: { to_name: target.full_name, to_id: target.id, from_id: task.assignee_id },
  });

  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  return { error: null };
}
