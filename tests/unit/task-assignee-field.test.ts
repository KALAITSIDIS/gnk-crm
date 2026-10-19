import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssigneeField } from "@/components/features/tasks/task-fields";

/**
 * Who a task form preselects (A02 review). The edit dialog passes the task's
 * holder as `defaultValue`; for an UNASSIGNED task that holder is null, and
 * `null ?? meId` read it as "no default given" — so an admin who opened an
 * unassigned task to fix its title saved it as theirs, with an `assigned`
 * line on the chain. Null now preselects the "" option, which posts as
 * "unchanged" (updateTaskSchema's formId: blank → undefined; updateTask moves
 * a task only for a non-empty, different id — pinned in
 * lib/actions/tasks-assign.test.ts).
 *
 * Rendered to markup: a native <select defaultValue> marks its option
 * `selected` there, which is what the browser posts when nobody touches it.
 */

const ME = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f00";
const COLLEAGUE = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f0c";
const GONE = "6e3f9d2b-4c5a-4d7e-9f0a-1b2c3d4e5f0d";
const assignees = [
  { id: COLLEAGUE, fullName: "Maria Agent" },
  { id: ME, fullName: "Andreas Admin" },
];

function render(defaultValue: string | null | undefined, missingLabel?: string): string {
  return renderToStaticMarkup(
    createElement(AssigneeField, {
      id: "f",
      assignees,
      meId: ME,
      ...(defaultValue === undefined ? {} : { defaultValue }),
      missingLabel,
    }),
  );
}

/** the option values the markup marks `selected` */
function selected(html: string): string[] {
  return [...html.matchAll(/<option value="([^"]*)" selected="">/g)].map((m) => m[1]!);
}

describe("AssigneeField: what an untouched form posts", () => {
  it("a new task (no default given) is mine", () => {
    const html = render(undefined);
    expect(selected(html)).toEqual([ME]);
    expect(html).not.toContain('<option value="">');
  });

  it("an UNASSIGNED task stays unassigned — the blank option, never me", () => {
    const html = render(null, "Nobody — choose a colleague");
    expect(selected(html)).toEqual([""]);
    expect(html).toContain('<option value="" selected="">Nobody — choose a colleague</option>');
  });

  it("a colleague's task stays theirs", () => {
    expect(selected(render(COLLEAGUE))).toEqual([COLLEAGUE]);
  });

  it("a holder no longer on the list (deactivated) is the blank option, not a silent move", () => {
    const html = render(GONE, "Former colleague — choose an active colleague");
    expect(selected(html)).toEqual([""]);
    expect(html).toContain("Former colleague — choose an active colleague");
  });

  it("lists me first, then everyone else", () => {
    const values = [...render(undefined).matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual([ME, COLLEAGUE]);
  });
});
