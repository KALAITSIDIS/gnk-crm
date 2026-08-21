"use client";

import { useState, useTransition } from "react";
import { ArrowDownToLine } from "lucide-react";
import { toast } from "sonner";
import { syncInheritedField } from "@/lib/actions/unit-inheritance";
import { Button } from "@/components/ui/button";
import type { FieldDrift } from "@/lib/services/unit-inheritance";

function labelize(field: string) {
  return field
    .replace(/_id$/, "")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * "These units still follow the project and disagree with it" (BACKLOG audit
 * finding 5, the drift half).
 *
 * Copy-on-create means editing the project does not reach units that already
 * exist. Rather than catching the moment of the edit — which needs state that
 * survives a navigation and misses anything changed elsewhere — this is
 * computed fresh from the rows every time the page renders. It is therefore
 * always right, and says nothing at all when there is nothing to say.
 *
 * ONE BUTTON PER FIELD. "Sync everything" reads as one decision but is several,
 * and the one nobody meant to make is the one that hurts.
 */
export function InheritanceDrift({
  projectId,
  drift,
  canManage,
}: {
  projectId: string;
  drift: FieldDrift[];
  canManage: boolean;
}) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  if (drift.length === 0) return null;

  const sync = (field: string) => {
    setBusy(field);
    start(async () => {
      const { error, synced } = await syncInheritedField(projectId, field);
      setBusy(null);
      if (error) toast.error(error);
      else if (synced === 0) toast.success("Nothing to update — units already agree");
      else toast.success(`${synced} unit${synced === 1 ? "" : "s"} updated`);
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-warning/40 bg-warning/5 p-4">
      <div>
        <h3 className="text-base font-semibold text-text-1">
          Units are behind this project
        </h3>
        <p className="mt-1 text-xs text-text-3">
          These units still take the field from the project and no longer match it. Units where
          somebody set the value by hand are not listed and will not be touched.
        </p>
      </div>

      <ul className="flex flex-col divide-y divide-border/60">
        {drift.map((d) => (
          <li key={d.field} className="flex items-center justify-between gap-4 py-2">
            <span className="text-sm text-text-1">
              {labelize(d.field)}
              <span className="ml-2 text-xs text-text-3">
                {d.count} unit{d.count === 1 ? "" : "s"} behind
              </span>
            </span>
            {canManage ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => sync(d.field)}
              >
                <ArrowDownToLine className="size-4" />
                {busy === d.field ? "Updating…" : `Update ${d.count}`}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
