"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { saveNudgeThresholds, type SettingsActionState } from "@/lib/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  FORM_BOUNDS,
  NUDGE_DEFAULTS,
  NUDGE_LABELS,
  NUDGE_THRESHOLD_KEYS,
  isOutsideFormBounds,
  type NudgeThresholdKey,
} from "@/lib/services/nudge-thresholds";

/**
 * Settings → Nudges (0052).
 *
 * A typed form rather than the generic JSON textarea on /settings/cyprus-config,
 * which writes the same row. "How many days of silence before we chase a deal"
 * is a workflow question the desk owner should be able to answer without
 * meeting a brace.
 */

const initialState: SettingsActionState = {
  error: null,
  savedAt: null,
  tempPassword: null,
  invitedEmail: null,
};

export function NudgeThresholdsPanel({
  values,
}: {
  values: Record<NudgeThresholdKey, number>;
}) {
  const [state, formAction, pending] = useActionState(saveNudgeThresholds, initialState);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== last.current) {
      last.current = state.savedAt;
      toast.success("Nudge thresholds saved — tonight's sweeps use the new values");
    }
  }, [state.savedAt]);

  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state.error]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-2">
        When the nightly sweeps raise chase-up tasks. Each runs once a night; changing a value
        here takes effect on the next run, and every save is an event.
      </p>

      <form action={formAction} className="flex flex-col gap-4">
        <section className="rounded-[10px] border border-border bg-surface p-5">
          <div className="flex flex-col gap-5">
            {NUDGE_THRESHOLD_KEYS.map((k) => {
              const outside = isOutsideFormBounds(k, values[k]);
              return (
                <div key={k} className="flex flex-col gap-1.5">
                  <Label htmlFor={k}>{NUDGE_LABELS[k].label}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={k}
                      name={k}
                      type="number"
                      inputMode="numeric"
                      min={FORM_BOUNDS[k].min}
                      max={FORM_BOUNDS[k].max}
                      step={1}
                      defaultValue={values[k]}
                      className="w-28 tabular-nums"
                    />
                    <span className="text-sm text-text-2">{NUDGE_LABELS[k].unit}</span>
                    <span className="text-xs text-text-3">
                      ({FORM_BOUNDS[k].min}–{FORM_BOUNDS[k].max}, default {NUDGE_DEFAULTS[k]})
                    </span>
                  </div>
                  <p className="text-xs text-text-3">{NUDGE_LABELS[k].help}</p>
                  {/* A raw-JSON edit on /settings/cyprus-config can put a value
                      here that this form would refuse. Say so rather than
                      quietly showing a rounded number the sweeps are not using. */}
                  {outside ? (
                    <p className="text-xs text-warning">
                      Currently {values[k]}, which is outside this form&rsquo;s range — it was set
                      by editing <code>nudge_thresholds</code> directly. The sweeps are using it.
                      Saving here will replace it.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        {/* The decision from 0052, stated where it can actually be read. If
            these two definitions of "stale" are going to differ, the person
            changing one of them is who needs to know. */}
        <section className="rounded-[10px] border border-border bg-surface-2 p-4">
          <h2 className="text-sm font-semibold text-text-1">
            This does not change how deals are scored
          </h2>
          <p className="mt-1 text-xs text-text-2">
            Deal health scores activity on a fixed scale — full marks within 7 days, half within
            14, none after that — and it stays that way whatever you set above. So if you chase
            after 21 days, the health score will already call a deal stale a week before anyone is
            told to ring them. That is deliberate: health scores are stored per deal and only
            recalculated when something happens to that deal, so tying them to this setting would
            leave every existing score wrong until it was next touched.
          </p>
        </section>

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save thresholds"}
          </Button>
        </div>
      </form>
    </div>
  );
}
