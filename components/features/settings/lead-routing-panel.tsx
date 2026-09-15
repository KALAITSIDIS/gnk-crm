"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { saveLeadRouting, type SettingsActionState } from "@/lib/actions/settings";
import { Button } from "@/components/ui/button";
import type { LeadRouting, LeadRoutingMode } from "@/lib/services/lead-routing";
import { cn } from "@/lib/utils";

/**
 * Settings → Lead routing (0098).
 *
 * A typed form over the `lead_routing` row: a mode, and the members in the
 * rotation. Native radios and checkboxes rather than the Radix primitives —
 * a rule the desk owner sets twice a year needs no client state beyond
 * which fieldset is greyed out, and a plain checkbox posts its value with
 * no JavaScript at all.
 */
export interface RoutableMember {
  id: string;
  full_name: string;
  role: string;
  is_active: boolean;
}

const initialState: SettingsActionState = {
  error: null,
  savedAt: null,
  tempPassword: null,
  invitedEmail: null,
};

export function LeadRoutingPanel({
  value,
  members,
}: {
  value: LeadRouting;
  members: RoutableMember[];
}) {
  const [state, formAction, pending] = useActionState(saveLeadRouting, initialState);
  const [mode, setMode] = useState<LeadRoutingMode>(value.mode);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== last.current) {
      last.current = state.savedAt;
      toast.success("Lead routing saved — the next website enquiry follows it");
    }
  }, [state.savedAt]);

  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state.error]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-2">
        How a website enquiry is assigned the moment it arrives. Off: it sits in the inbox until
        someone claims it. Round-robin: the listed member with the fewest open leads takes it,
        and the lead&rsquo;s timeline says so.
      </p>

      <form action={formAction} data-testid="lead-routing-form" className="flex flex-col gap-4">
        <section className="flex flex-col gap-5 rounded-[10px] border border-border bg-surface p-5">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-text-1">Mode</legend>
            <label className="flex items-start gap-2 text-sm text-text-1">
              <input
                type="radio"
                name="mode"
                value="off"
                checked={mode === "off"}
                onChange={() => setMode("off")}
                className="mt-1"
              />
              <span>
                Off <span className="text-text-3">— every website lead waits to be claimed</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-text-1">
              <input
                type="radio"
                name="mode"
                value="round_robin"
                checked={mode === "round_robin"}
                onChange={() => setMode("round_robin")}
                className="mt-1"
              />
              <span>
                Round-robin{" "}
                <span className="text-text-3">
                  — the member with the fewest open leads, then the one assigned longest ago
                </span>
              </span>
            </label>
          </fieldset>

          <fieldset className={cn("flex flex-col gap-2", mode === "off" && "opacity-60")}>
            <legend className="mb-1 text-sm font-medium text-text-1">Members in the rotation</legend>
            {members.length === 0 ? (
              <p className="text-sm text-text-3">No admins or agents to route to.</p>
            ) : (
              members.map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-sm text-text-1">
                  <input
                    type="checkbox"
                    name="agents"
                    value={m.id}
                    defaultChecked={value.agents.includes(m.id)}
                    disabled={!m.is_active}
                  />
                  <span>{m.full_name}</span>
                  <span className="text-xs text-text-3">
                    {m.role.replace(/_/g, " ")}
                    {m.is_active ? "" : " · inactive"}
                  </span>
                </label>
              ))
            )}
            <p className="text-xs text-text-3">
              A member deactivated later is skipped. Round-robin over nobody usable assigns nobody
              — the lead waits in the inbox as if the rule were off.
            </p>
          </fieldset>
        </section>

        <section className="rounded-[10px] border border-border bg-surface-2 p-4">
          <h2 className="text-sm font-semibold text-text-1">What this does not do</h2>
          <p className="mt-1 text-xs text-text-2">
            It never moves a lead somebody already holds, and it sends no e-mail. The response
            clock runs from the moment the enquiry arrives whoever holds it; after an hour with no
            first response, the ten-minute sweep raises a task for the assignee — or, for an
            unassigned lead, the oldest admin.
          </p>
        </section>

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save routing"}
          </Button>
        </div>
      </form>
    </div>
  );
}
