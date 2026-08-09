"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createClient } from "@/lib/supabase/server";
import { zonedWallClockToUtc } from "@/lib/utils/tz";

export type TaskActionState = { error: string | null; savedAt: number | null };

const quickAddSchema = z.object({
  title: z.string().trim().min(2, "Task title is required").max(300),
  // optional date; stored as Cyprus end-of-day so "due today" stays overdue
  // only after the working day actually ends
  due_date: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || /^\d{4}-\d{2}-\d{2}$/.test(v), "Invalid due date"),
});

/** Quick-add (T5.5): a personal task, assigned to whoever created it. */
export async function quickAddTask(
  _prev: TaskActionState,
  formData: FormData,
): Promise<TaskActionState> {
  const parsed = quickAddSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const dueAt = d.due_date ? zonedWallClockToUtc(`${d.due_date}T23:59`).toISOString() : null;

  const { data: created, error } = await supabase
    .from("tasks")
    .insert({
      org_id: profile.orgId,
      title: d.title,
      due_at: dueAt,
      assignee_id: profile.id,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error) return { error: error.message, savedAt: null };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "task",
    entityId: created.id,
    eventType: "created",
    payload: { title: d.title, due_at: dueAt },
  });

  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  return { error: null, savedAt: Date.now() };
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
    .select("id, org_id, title, is_done")
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
    payload: { title: task.title },
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
  // invisibilities. RLS scopes this read to the caller's org.
  const { data: target } = await supabase
    .from("profiles")
    .select("id, full_name, is_active")
    .eq("id", toProfileId)
    .maybeSingle();
  if (!target) return { error: "Unknown user" };
  if (!target.is_active) return { error: "That user is deactivated — pick an active one." };

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
