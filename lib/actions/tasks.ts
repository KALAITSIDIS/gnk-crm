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
    .transform((v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)),
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

  const { error } = await supabase
    .from("tasks")
    .update({ is_done: done, done_at: done ? new Date().toISOString() : null })
    .eq("id", taskId);
  if (error) return { error: error.message };

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
