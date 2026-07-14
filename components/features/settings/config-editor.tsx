"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { saveCyprusConfig, type SettingsActionState } from "@/lib/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface ConfigRow {
  key: string;
  valueJson: string;
  description: string | null;
  verifiedAt: string | null;
  sourceNote: string | null;
}

const initialState: SettingsActionState = { error: null, savedAt: null, tempPassword: null };

export function ConfigCard({ row }: { row: ConfigRow }) {
  const [state, formAction, pending] = useActionState(saveCyprusConfig, initialState);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== last.current) {
      last.current = state.savedAt;
      toast.success(`${row.key} saved`);
    }
  }, [state.savedAt, row.key]);

  return (
    <section className="rounded-[10px] border border-border bg-surface p-5">
      <h2 className="font-mono text-sm font-semibold text-text-1">{row.key}</h2>
      {row.description ? <p className="mt-1 text-xs text-text-3">{row.description}</p> : null}

      <form action={formAction} className="mt-3 flex flex-col gap-3">
        <input type="hidden" name="key" value={row.key} />
        <Textarea
          name="value_json"
          defaultValue={row.valueJson}
          rows={Math.min(16, row.valueJson.split("\n").length + 1)}
          spellCheck={false}
          className="font-mono text-xs"
        />
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`verified-${row.key}`}>Verified on</Label>
            <Input
              id={`verified-${row.key}`}
              name="verified_at"
              type="date"
              defaultValue={row.verifiedAt ?? ""}
              className="h-9 w-44"
            />
          </div>
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor={`source-${row.key}`}>Source note</Label>
            <Input
              id={`source-${row.key}`}
              name="source_note"
              defaultValue={row.sourceNote ?? ""}
              className="h-9"
            />
          </div>
          <Button type="submit" disabled={pending} className="h-9">
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
        {state.error ? (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
