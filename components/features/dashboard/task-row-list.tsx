import Link from "next/link";
import { isTaskKind } from "@/lib/services/task-target";
import { formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * Task rows on the dashboard (A01): My day's "due today & overdue" and the
 * admin's "Overdue across the team". Each row is ONE link, to the record the
 * task is about (lib/services/task-target.ts), with the reminder's kind
 * labelled so a lead SLA, a feedback nudge or a hold expiring reads as what it
 * is before anyone opens it.
 */
export interface DashboardTaskRow {
  id: string;
  title: string;
  dueAt: string | null;
  href: string;
  /** the translated kind label; null for a task a person typed */
  kindLabel: string | null;
  /** the team card's "whose list is it on" — absent on My day */
  owner?: string;
}

/**
 * The translated label of a task's kind. A kind this build does not know
 * (a migration ahead of the app) reads as a generic reminder rather than a
 * missing-message key.
 */
export function kindLabel(t: (key: string) => string, kind: string | null): string | null {
  if (!kind) return null;
  return t(isTaskKind(kind) ? kind : "other");
}

export function TaskRowList({ rows, now }: { rows: DashboardTaskRow[]; now: Date }) {
  return (
    <ul className="flex flex-col divide-y divide-border/60 text-sm">
      {rows.map((task) => (
        <li key={task.id}>
          <Link
            href={task.href}
            className="flex min-h-11 items-center justify-between gap-3 py-2 hover:text-brand-700"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-text-1">{task.title}</span>
              {task.kindLabel || task.owner ? (
                <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-text-3">
                  {task.kindLabel ? (
                    <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-2">
                      {task.kindLabel}
                    </span>
                  ) : null}
                  {task.owner ? <span className="truncate">{task.owner}</span> : null}
                </span>
              ) : null}
            </span>
            {/* red means PAST due, not merely due — My day holds both, and a
                nudge due at 23:59 tonight is not late yet */}
            <span
              className={cn(
                "shrink-0 tabular-nums text-xs",
                task.dueAt && new Date(task.dueAt).getTime() < now.getTime()
                  ? "text-danger"
                  : "text-text-3",
              )}
            >
              {formatDate(task.dueAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
