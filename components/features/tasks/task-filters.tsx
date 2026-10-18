import Link from "next/link";
import {
  TASK_DUE_FILTERS,
  TASK_DUE_LABELS,
  TASK_SCOPES,
  TASK_SCOPE_LABELS,
  taskListQuery,
  type TaskListFilters,
} from "@/lib/queries/tasks-list";
import { cn } from "@/lib/utils";

/**
 * The /tasks views (A02) as plain links — server-rendered, so a view is a URL
 * the desk can bookmark and the export can read. Choosing one drops `page`.
 * Team is offered to admins only (lib/queries/tasks-list.ts says why).
 */
export function TaskFilters({ filters, isAdmin }: { filters: TaskListFilters; isAdmin: boolean }) {
  const scopes = TASK_SCOPES.filter((s) => s !== "team" || isAdmin);
  return (
    <nav aria-label="Task views" className="flex flex-col gap-2">
      <Group label="Show">
        {scopes.map((scope) => (
          <Chip key={scope} href={`/tasks${taskListQuery({ ...filters, scope })}`} active={filters.scope === scope}>
            {TASK_SCOPE_LABELS[scope]}
          </Chip>
        ))}
      </Group>
      <Group label="Due">
        <Chip href={`/tasks${taskListQuery({ ...filters, due: null })}`} active={filters.due === null}>
          Any
        </Chip>
        {TASK_DUE_FILTERS.map((due) => (
          <Chip key={due} href={`/tasks${taskListQuery({ ...filters, due })}`} active={filters.due === due}>
            {TASK_DUE_LABELS[due]}
          </Chip>
        ))}
      </Group>
    </nav>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-12 shrink-0 text-xs text-text-3">{label}</span>
      {children}
    </div>
  );
}

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex min-h-8 items-center rounded-full border px-3 text-xs font-medium",
        active
          ? "border-brand-700 bg-brand-100 text-brand-700"
          : "border-border bg-surface text-text-2 hover:text-text-1",
      )}
    >
      {children}
    </Link>
  );
}
