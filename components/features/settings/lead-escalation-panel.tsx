"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { saveLeadEscalation, type SettingsActionState } from "@/lib/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RoutableMember } from "@/components/features/settings/lead-routing-panel";
import {
  ESCALATION_FORM_BOUNDS,
  SEEDED_WORKING_HOURS,
  isOutsideEscalationFormBounds,
  type LeadEscalationConfig,
} from "@/lib/services/lead-escalation";
import { cn } from "@/lib/utils";

/**
 * Settings → Lead escalation (0107).
 *
 * A typed form over the `lead_escalation` policy row: on or off, the wait in
 * working minutes, who is told, and the working hours the wait is counted
 * in. Native inputs like the routing panel beside it — a policy the desk
 * owner sets once needs no client state beyond which fieldsets are greyed
 * out. What the page shows is what the sweep will do: the reader applies
 * the same fallback rules as the SQL, so a value set through the raw JSON
 * editor that the sweep would ignore shows here as ignored.
 */
const DAYS: ReadonlyArray<{ iso: number; label: string }> = [
  { iso: 1, label: "Mon" },
  { iso: 2, label: "Tue" },
  { iso: 3, label: "Wed" },
  { iso: 4, label: "Thu" },
  { iso: 5, label: "Fri" },
  { iso: 6, label: "Sat" },
  { iso: 7, label: "Sun" },
];

const initialState: SettingsActionState = {
  error: null,
  savedAt: null,
  tempPassword: null,
  invitedEmail: null,
};

export function LeadEscalationPanel({ value, members }: { value: LeadEscalationConfig; members: RoutableMember[] }) {
  const [state, formAction, pending] = useActionState(saveLeadEscalation, initialState);
  const [enabled, setEnabled] = useState(value.enabled);
  const [hoursOn, setHoursOn] = useState(value.working_hours !== null);
  const last = useRef<number | null>(null);
  const hours = value.working_hours ?? SEEDED_WORKING_HOURS;

  useEffect(() => {
    if (state.savedAt && state.savedAt !== last.current) {
      last.current = state.savedAt;
      toast.success("Lead escalation saved — the next five-minute check applies it");
    }
  }, [state.savedAt]);

  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state.error]);

  const active = members.filter((m) => m.is_active);
  const inactive = members.filter((m) => !m.is_active && value.recipients.includes(m.id));
  const outsideWait = isOutsideEscalationFormBounds("after_minutes", value.after_minutes);
  const outsideAge = isOutsideEscalationFormBounds("max_age_hours", value.max_age_hours);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-2">
        When a website enquiry has waited too long for a first response, e-mail a colleague about it.
        The desk alert already says an enquiry <em>arrived</em>; this says it is still <em>waiting</em>.
        It goes once per enquiry to the people ticked below — never to the person the lead is assigned
        to, who already has the alert and the task. The check runs every five minutes and the e-mail
        leaves with the next alert sweep, so expect the wait plus up to seven minutes, not the minute
        itself.
      </p>

      <form action={formAction} data-testid="lead-escalation-form" className="flex flex-col gap-5">
        <label className="flex items-start gap-3 rounded-[10px] border border-border bg-surface p-3">
          <input
            type="checkbox"
            name="enabled"
            value="on"
            defaultChecked={value.enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-0.5 size-4 accent-brand-700"
          />
          <span className="flex flex-col">
            <span className="text-sm font-medium text-text-1">Escalate unanswered website enquiries</span>
            <span className="text-xs text-text-2">
              Off: nothing is sent, whatever the settings below say. On: enquiries still unanswered after the wait are
              escalated once, including ones already waiting when you switch this on — unless the wait ended more than{" "}
              <span className="font-mono">{value.max_age_hours}</span> hours ago. An enquiry that waited through the weekend
              counts from Monday&apos;s opening, not from Friday night.
            </span>
          </span>
        </label>

        <fieldset className={cn("flex flex-col gap-3 rounded-[10px] border border-border p-3", !enabled && "opacity-70")}>
          <legend className="px-1 text-sm font-medium text-text-1">The wait</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="after_minutes">Minutes without a first response</Label>
              <Input
                id="after_minutes"
                name="after_minutes"
                type="number"
                inputMode="numeric"
                min={ESCALATION_FORM_BOUNDS.after_minutes.min}
                max={ESCALATION_FORM_BOUNDS.after_minutes.max}
                step={1}
                defaultValue={value.after_minutes}
                required
              />
              <p className="text-xs text-text-3">
                Counted in working time when hours are set. {ESCALATION_FORM_BOUNDS.after_minutes.min}–
                {ESCALATION_FORM_BOUNDS.after_minutes.max} here
                {outsideWait ? ` (the row currently holds ${value.after_minutes}, set outside this form — the sweep uses it)` : ""}.
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="max_age_hours">Ignore enquiries overdue for more than (hours)</Label>
              <Input
                id="max_age_hours"
                name="max_age_hours"
                type="number"
                inputMode="numeric"
                min={ESCALATION_FORM_BOUNDS.max_age_hours.min}
                max={ESCALATION_FORM_BOUNDS.max_age_hours.max}
                step={1}
                defaultValue={value.max_age_hours}
                required
              />
              <p className="text-xs text-text-3">
                Counted from the moment the wait ended, so closed days do not count against an enquiry. Keeps switching
                this on from e-mailing about every stale enquiry — those have their tasks
                {outsideAge ? ` (the row currently holds ${value.max_age_hours}, set outside this form)` : ""}.
              </p>
            </div>
          </div>
        </fieldset>

        <fieldset className={cn("flex flex-col gap-2 rounded-[10px] border border-border p-3", !enabled && "opacity-70")}>
          <legend className="px-1 text-sm font-medium text-text-1">Who is told</legend>
          <p className="text-xs text-text-2">
            Active admins and agents. Whoever the lead is assigned to is skipped even if ticked. Turning
            escalation on needs at least one person here.
          </p>
          {active.length === 0 ? <p className="text-sm text-text-3">No active admins or agents to choose from.</p> : null}
          <ul className="flex flex-col gap-1">
            {active.map((m) => (
              <li key={m.id}>
                <label className="flex items-center gap-2 text-sm text-text-1">
                  <input
                    type="checkbox"
                    name="recipients"
                    value={m.id}
                    defaultChecked={value.recipients.includes(m.id)}
                    className="size-4 accent-brand-700"
                  />
                  {m.full_name}
                  <span className="text-xs text-text-3">({m.role})</span>
                </label>
              </li>
            ))}
            {inactive.map((m) => (
              <li key={m.id} className="text-xs text-text-3">
                {m.full_name} is in the policy but inactive — the sweep skips them; saving drops them.
              </li>
            ))}
          </ul>
        </fieldset>

        <fieldset className={cn("flex flex-col gap-3 rounded-[10px] border border-border p-3", !enabled && "opacity-70")}>
          <legend className="px-1 text-sm font-medium text-text-1">Working hours</legend>
          <label className="flex items-center gap-2 text-sm text-text-1">
            <input
              type="checkbox"
              name="hours_enabled"
              value="on"
              defaultChecked={value.working_hours !== null}
              onChange={(e) => setHoursOn(e.target.checked)}
              className="size-4 accent-brand-700"
            />
            Count the wait in working time only
          </label>
          <p className="text-xs text-text-2">
            An enquiry at 22:00 Friday then counts from 09:00 Monday, in <span className="font-mono">{value.timezone}</span>{" "}
            (the desk&rsquo;s zone; daylight saving is handled). Off: the wait is clock time, day and night.
          </p>
          <div className={cn("flex flex-col gap-3", !hoursOn && "opacity-60")}>
            <div className="flex flex-wrap gap-3">
              {DAYS.map((d) => (
                <label key={d.iso} className="flex items-center gap-1.5 text-sm text-text-1">
                  <input
                    type="checkbox"
                    name="days"
                    value={d.iso}
                    defaultChecked={hours.days.includes(d.iso)}
                    disabled={!hoursOn}
                    className="size-4 accent-brand-700"
                  />
                  {d.label}
                </label>
              ))}
            </div>
            <div className="grid max-w-sm gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor="hours_start">From</Label>
                <Input id="hours_start" name="start" type="time" defaultValue={hours.start} disabled={!hoursOn} required={hoursOn} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="hours_end">To</Label>
                <Input id="hours_end" name="end" type="time" defaultValue={hours.end} disabled={!hoursOn} required={hoursOn} />
              </div>
            </div>
          </div>
        </fieldset>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save escalation"}
          </Button>
          <p className="text-xs text-text-3">Every save is an event. The e-mail itself needs the provider key the desk alert already uses.</p>
        </div>
      </form>
    </div>
  );
}
