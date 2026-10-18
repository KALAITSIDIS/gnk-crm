"use client";

import { Input } from "@/components/ui/input";
import type { TaskAssignee } from "@/lib/validators/tasks";

/**
 * The two optional task fields (A02), shared by the quick add on /tasks, the
 * "Add task" dialog on a record and the edit dialog: a Cyprus time of day and
 * the colleague the task is for.
 *
 * Native controls on purpose. Both live inside a native <details> in the add
 * forms, whose content stays in the form while it is closed, so the default
 * (no time = all day; me) posts either way — a Radix Collapsible would unmount
 * them. And a native <select> keeps its default through `form.reset()`.
 */

const SELECT_CLASS =
  "h-10 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 text-sm text-text-1 shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function DueTimeField({ id, defaultValue = "" }: { id: string; defaultValue?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text-1">
        Due time
      </label>
      <Input id={id} name="due_time" type="time" defaultValue={defaultValue} className="h-10" />
      <p className="text-xs text-text-3">Cyprus time. Empty = any time that day.</p>
    </div>
  );
}

/**
 * Who the task is for. `assignees` null = the list is not loaded (yet): no
 * control renders, nothing posts, and the server keeps its default — the
 * creator for a new task, the current holder for an edit. A failed load says
 * so instead of offering an empty choice.
 */
export function AssigneeField({
  id,
  assignees,
  meId,
  defaultValue,
  loadError,
  missingLabel,
}: {
  id: string;
  assignees: TaskAssignee[] | null;
  meId: string | null;
  /**
   * The preselected person. ABSENT (undefined) = me — a new task. NULL = the
   * task is held by nobody: the "" option (`missingLabel`) is preselected and
   * posts as "unchanged", so saving an edit of an unassigned task never hands
   * it to whoever opened the dialog (A02 review).
   */
  defaultValue?: string | null;
  loadError?: string | null;
  /** an edit's current holder who is not on the list (deactivated, or nobody) */
  missingLabel?: string;
}) {
  if (loadError) {
    return (
      <p role="status" className="text-xs text-text-3">
        {loadError} The task stays with you.
      </p>
    );
  }
  if (assignees === null) {
    return <p className="text-xs text-text-3">Loading colleagues…</p>;
  }
  // `??` would read a null holder as "no default given" and preselect me
  const preselected = defaultValue === undefined ? (meId ?? "") : (defaultValue ?? "");
  const known = assignees.some((a) => a.id === preselected);
  // me first, then everyone else by name (the list arrives sorted by name)
  const ordered = [
    ...assignees.filter((a) => a.id === meId),
    ...assignees.filter((a) => a.id !== meId),
  ];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text-1">
        Assign to
      </label>
      <select id={id} name="assignee_id" defaultValue={known ? preselected : ""} className={SELECT_CLASS}>
        {known ? null : (
          // "" posts as "unchanged" — never a silent move to whoever is first
          <option value="">{missingLabel ?? "Choose…"}</option>
        )}
        {ordered.map((a) => (
          <option key={a.id} value={a.id}>
            {a.id === meId ? `Me (${a.fullName})` : a.fullName}
          </option>
        ))}
      </select>
    </div>
  );
}
